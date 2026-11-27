/**
 * @module marshal/groups/voice-engine
 *
 * Backend engine for live voice calls with resident Agents:
 * - STT: dynamically reuses DSH's built-in `speechToText` service (SenseVoice + Silero VAD)
 * - Brain (A1): low-latency streaming LLM turn with Agent persona, Mnemon memory, and call context
 * - TTS: pluggable provider registry (T1 Edge neural + macOS `say` fallback, T2 local offline neural, T3 extensible)
 * - Summary: structured post-call summary feeding MarshalVoiceSummaryCard
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EDGE_DEFAULT_VOICE, EDGE_ZH_VOICES, normalizeEdgeVoice, synthesizeEdgeTts } from './edge-tts.js';

const execFileAsync = promisify(execFile);
const MAX_WAV_BYTES = 4 * 1024 * 1024;
const MAX_TTS_TEXT_CHARS = 800;
const MAX_HISTORY_TURNS = 12;
const DEFAULT_LOCAL_MODEL_DIR = join(homedir(), '.dsh-marshal', 'voice', 'models');
const SAFE_SAY_VOICE_RE = /^[A-Za-z0-9][A-Za-z0-9 _()-]{0,63}$/;
const EDGE_NEURAL_VOICE_RE = /-[A-Za-z0-9]+Neural$/i;
const HAS_SPEAKABLE_CHAR_RE = /[\p{L}\p{N}]/u;
const STT_READY_PHASES = new Set(['ready', 'standby', 'idle']);
const STT_PREPARING_PHASES = new Set(['preparing', 'checking', 'downloading', 'loading', 'waking']);
const DEFAULT_SAY_VOICE = 'Tingting';

function sliceSafeChars(text, maxChars) {
    const str = String(text ?? '');
    if (str.length <= maxChars) return str;
    const end = maxChars;
    const code = str.charCodeAt(end - 1);
    return (code >= 0xD800 && code <= 0xDBFF) ? str.slice(0, end - 1) : str.slice(0, end);
}

function createConcurrencyLimiter(limit = 2) {
    const cap = Math.max(1, Number(limit) || 2);
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < cap && queue.length > 0) {
            const entry = queue.shift();
            if (entry.cancelled) continue;
            active += 1;
            entry.start();
        }
    };
    return (fn, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(makeVoiceError('aborted', '语音合成已取消。', 499));
            return;
        }
        const entry = {
            cancelled: false,
            start() {
                signal?.removeEventListener('abort', onAbort);
                Promise.resolve()
                    .then(fn)
                    .then(resolve, reject)
                    .finally(() => {
                        active -= 1;
                        pump();
                    });
            },
        };
        const onAbort = () => {
            entry.cancelled = true;
            reject(makeVoiceError('aborted', '语音合成已取消。', 499));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
        pump();
    });
}

function execFileWithStdin(bin, args, { input, signal, timeout = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(bin, args, { signal, timeout }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
        if (typeof input === 'string' && child.stdin) {
            child.stdin.on('error', () => { /* ignore EPIPE if process exits early */ });
            child.stdin.end(input + '\n');
        }
    });
}

export const SYSTEM_ZH_VOICES = Object.freeze([
    { id: 'Tingting', label: '婷婷（macOS 离线中文）', lang: 'zh-CN', gender: 'female' },
    { id: 'Sinji', label: '善怡（macOS 粤语）', lang: 'zh-HK', gender: 'female' },
    { id: 'Meijia', label: '美嘉（macOS 台湾中文）', lang: 'zh-TW', gender: 'female' },
]);

/** Clean Markdown syntax so spoken TTS stays natural and concise. */
export function stripForSpeech(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?```/g, '（相关代码我已整理好，挂断后可在纪要中查看）')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*>\s+/gm, '')
        .replace(/(\*\*|__|~~|\*)/g, '')
        .replace(/\|/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * Incremental sentence splitter for streaming LLM text.
 * Emits speakable chunks as soon as a sentence terminator arrives so the client
 * can overlap TTS synthesis with ongoing token generation.
 */
export function createSentenceSplitter({ minChars = 6, maxChars = 140 } = {}) {
    let buffer = '';
    const pushIfSpeakable = (out, raw) => {
        const spoken = stripForSpeech(raw);
        if (spoken && HAS_SPEAKABLE_CHAR_RE.test(spoken)) out.push(spoken);
    };
    const hasOpenCodeFence = text => {
        const fences = text.match(/```/g);
        return Boolean(fences && fences.length % 2 === 1);
    };
    const findSentenceCut = text => {
        const re = /[。！？；\n]+|[.!?](?=\s|$)/g;
        let match;
        while ((match = re.exec(text)) !== null) {
            const end = match.index + match[0].length;
            const candidate = text.slice(0, end);
            if (hasOpenCodeFence(candidate)) continue;
            if (candidate.trim().length >= minChars) return end;
        }
        return -1;
    };
    const extract = flush => {
        const out = [];
        while (buffer.length > 0) {
            const cutEnd = findSentenceCut(buffer);
            if (cutEnd > 0) {
                const raw = buffer.slice(0, cutEnd);
                buffer = buffer.slice(cutEnd);
                pushIfSpeakable(out, raw);
                continue;
            }
            if (!hasOpenCodeFence(buffer) && buffer.length >= maxChars) {
                const soft = buffer.slice(0, maxChars).match(/^([\s\S]*[，,、：:\s])/);
                const cut = soft && soft[1].trim().length >= minChars ? soft[1].length : maxChars;
                const raw = buffer.slice(0, cut);
                buffer = buffer.slice(cut);
                pushIfSpeakable(out, raw);
                continue;
            }
            if (hasOpenCodeFence(buffer) && buffer.length >= maxChars * 6) {
                const raw = buffer.slice(0, maxChars);
                buffer = buffer.slice(maxChars);
                pushIfSpeakable(out, raw);
                continue;
            }
            break;
        }
        if (flush && buffer.trim()) {
            const raw = buffer;
            buffer = '';
            pushIfSpeakable(out, raw);
        }
        return out;
    };
    return {
        push(delta) {
            if (typeof delta === 'string' && delta) buffer += delta;
            return extract(false);
        },
        flush() {
            return extract(true);
        },
    };
}

export function validateWavBuffer(buffer, maxBytes = MAX_WAV_BYTES) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 44) {
        return { ok: false, code: 'invalid-audio', message: '音频内容过短或不是有效的 WAV 文件。' };
    }
    if (buffer.length > maxBytes) {
        return { ok: false, code: 'audio-too-large', message: `单段语音超过大小上限（${Math.round(maxBytes / 1024 / 1024)} MB）。` };
    }
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
        return { ok: false, code: 'invalid-audio', message: '音频必须是标准 WAV（RIFF/WAVE）格式。' };
    }
    let offset = 12;
    let foundFmt = false;
    let foundData = false;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const bodyStart = offset + 8;
        if (chunkId === 'fmt ') {
            if (chunkSize < 16 || bodyStart + 16 > buffer.length) {
                return { ok: false, code: 'invalid-audio', message: 'WAV 音频格式头损坏。' };
            }
            const audioFormat = buffer.readUInt16LE(bodyStart);
            const channels = buffer.readUInt16LE(bodyStart + 2);
            const sampleRate = buffer.readUInt32LE(bodyStart + 4);
            const bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
            if (audioFormat !== 1 || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000 || bitsPerSample !== 16) {
                return { ok: false, code: 'invalid-audio', message: '仅支持 16-bit PCM WAV 音频（8kHz–48kHz，单/双声道）。' };
            }
            foundFmt = true;
        } else if (chunkId === 'data') {
            if (chunkSize > 0 && bodyStart < buffer.length) foundData = true;
        }
        const padded = chunkSize + (chunkSize % 2);
        if (padded === 0 && chunkId === '\0\0\0\0') break;
        offset = bodyStart + padded;
    }
    if (!foundFmt || !foundData) {
        return { ok: false, code: 'invalid-audio', message: 'WAV 缺少有效的 PCM 格式头或音频数据。' };
    }
    return { ok: true };
}

function makeVoiceError(code, message, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function findBinary(candidates) {
    for (const candidate of candidates) {
        if (candidate.startsWith('/') && existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** Built-in offline fallback on macOS using `/usr/bin/say` + `afconvert`/`ffmpeg`. */
export function createSystemTtsProvider({ execFileImpl = execFileAsync, platform = process.platform } = {}) {
    const sayBin = platform === 'darwin' ? findBinary(['/usr/bin/say']) : undefined;
    const afconvertBin = platform === 'darwin' ? findBinary(['/usr/bin/afconvert']) : undefined;
    const ffmpegBin = findBinary(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
    return {
        id: 'system',
        label: '系统离线语音（macOS say）',
        tier: 'T1-fallback',
        status() {
            const ready = Boolean(sayBin && (afconvertBin || ffmpegBin));
            return {
                id: 'system',
                label: '系统离线语音（macOS say）',
                tier: 'T1-fallback',
                ready,
                offline: true,
                ...(ready ? {} : { reason: '仅 macOS 环境支持系统离线语音合成。' }),
            };
        },
        listVoices() {
            return [...SYSTEM_ZH_VOICES];
        },
        async synthesize({ text, voice, rate, signal }) {
            if (!sayBin || (!afconvertBin && !ffmpegBin)) {
                throw makeVoiceError('tts-system-unavailable', '当前系统不支持离线 say 语音合成。', 503);
            }
            const spoken = sliceSafeChars(stripForSpeech(text), MAX_TTS_TEXT_CHARS);
            if (!spoken || !HAS_SPEAKABLE_CHAR_RE.test(spoken)) {
                throw makeVoiceError('invalid-text', '合成文本不能为空或仅包含标点。', 400);
            }
            const trimmedVoice = typeof voice === 'string' ? voice.trim() : '';
            let selectedVoice = trimmedVoice && !EDGE_NEURAL_VOICE_RE.test(trimmedVoice) && SAFE_SAY_VOICE_RE.test(trimmedVoice)
                ? trimmedVoice
                : DEFAULT_SAY_VOICE;
            const rateNum = typeof rate === 'number' && Number.isFinite(rate)
                ? Math.max(120, Math.min(320, Math.round(190 * rate)))
                : 190;
            const dir = mkdtempSync(join(tmpdir(), 'marshal-say-'));
            const aiffPath = join(dir, 'speech.aiff');
            const wavPath = join(dir, 'speech.wav');
            try {
                try {
                    await execFileImpl(sayBin, ['-v', selectedVoice, '-r', String(rateNum), '-o', aiffPath, '--', spoken], {
                        signal,
                        timeout: 15_000,
                    });
                } catch (err) {
                    const detail = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
                    if (!signal?.aborted && selectedVoice !== DEFAULT_SAY_VOICE && /voice .* not found/i.test(detail)) {
                        selectedVoice = DEFAULT_SAY_VOICE;
                        await execFileImpl(sayBin, ['-v', selectedVoice, '-r', String(rateNum), '-o', aiffPath, '--', spoken], {
                            signal,
                            timeout: 15_000,
                        });
                    } else {
                        throw err;
                    }
                }
                if (afconvertBin) {
                    await execFileImpl(afconvertBin, ['-f', 'WAVE', '-d', 'LEI16@22050', aiffPath, wavPath], {
                        signal,
                        timeout: 10_000,
                    });
                } else {
                    await execFileImpl(ffmpegBin, ['-y', '-i', aiffPath, '-ar', '22050', '-ac', '1', wavPath], {
                        signal,
                        timeout: 10_000,
                    });
                }
                const audio = await readFile(wavPath);
                return { mime: 'audio/wav', audio, provider: 'system', voice: selectedVoice };
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    };
}

/** T1 Default: Edge neural TTS with automatic offline fallback to macOS `say`. */
export function createEdgeTtsProvider({ synthesizeEdge = synthesizeEdgeTts, fallbackProvider } = {}) {
    return {
        id: 'edge',
        label: 'Edge 神经语音（默认 · 断网自动离线兜底）',
        tier: 'T1',
        status() {
            return {
                id: 'edge',
                label: 'Edge 神经语音（默认）',
                tier: 'T1',
                ready: true,
                offline: false,
                fallback: fallbackProvider?.status?.().ready ? 'system' : null,
            };
        },
        listVoices() {
            return [...EDGE_ZH_VOICES];
        },
        async synthesize({ text, voice, rate, signal }) {
            const spoken = sliceSafeChars(stripForSpeech(text), MAX_TTS_TEXT_CHARS);
            if (!spoken || !HAS_SPEAKABLE_CHAR_RE.test(spoken)) {
                throw makeVoiceError('invalid-text', '合成文本不能为空或仅包含标点。', 400);
            }
            const resolvedVoice = normalizeEdgeVoice(voice);
            try {
                return await synthesizeEdge({ text: spoken, voice: resolvedVoice, rate, signal });
            } catch (error) {
                if (signal?.aborted || error?.code === 'aborted') throw error;
                if (fallbackProvider && fallbackProvider.status().ready) {
                    const fallback = await fallbackProvider.synthesize({ text: spoken, voice: DEFAULT_SAY_VOICE, rate, signal });
                    return { ...fallback, fallbackFrom: 'edge' };
                }
                throw makeVoiceError('tts-edge-failed', `Edge 语音合成失败：${error instanceof Error ? error.message : String(error)}`, 502);
            }
        },
    };
}

/** Discover local offline neural TTS binaries & ONNX models for T2. */
function detectLocalTts(modelDir) {
    const piperBin = findBinary(['/opt/homebrew/bin/piper', '/usr/local/bin/piper', join(modelDir, 'piper')]);
    const sherpaBin = findBinary(['/opt/homebrew/bin/sherpa-onnx-offline-tts', '/usr/local/bin/sherpa-onnx-offline-tts', join(modelDir, 'sherpa-onnx-offline-tts')]);
    const kokoroBin = findBinary(['/opt/homebrew/bin/kokoro-tts', '/usr/local/bin/kokoro-tts', join(modelDir, 'kokoro-tts')]);
    let onnxFiles = [];
    let tokensFile;
    if (existsSync(modelDir)) {
        try {
            const entries = readdirSync(modelDir);
            onnxFiles = entries.filter(name => name.endsWith('.onnx')).map(name => join(modelDir, name));
            if (entries.includes('tokens.txt')) tokensFile = join(modelDir, 'tokens.txt');
        } catch { /* unreadable dir */ }
    }
    if (sherpaBin && onnxFiles.length > 0 && tokensFile) {
        return { kind: 'sherpa-onnx', bin: sherpaBin, model: onnxFiles[0], tokens: tokensFile, models: onnxFiles };
    }
    if (piperBin && onnxFiles.length > 0) {
        return { kind: 'piper', bin: piperBin, model: onnxFiles[0], models: onnxFiles };
    }
    if (kokoroBin) {
        return { kind: 'kokoro', bin: kokoroBin, model: onnxFiles[0], models: onnxFiles };
    }
    return null;
}

/** T2 Optional: fully offline local neural TTS (sherpa-onnx / piper / kokoro). */
export function createLocalNeuralTtsProvider({ modelDir = DEFAULT_LOCAL_MODEL_DIR, execFileImpl = execFileAsync, detect = detectLocalTts } = {}) {
    return {
        id: 'local',
        label: '本地离线神经语音（T2）',
        tier: 'T2',
        status() {
            const found = detect(modelDir);
            if (found) {
                return { id: 'local', label: `本地离线神经语音（${found.kind}）`, tier: 'T2', ready: true, offline: true, engine: found.kind, modelDir };
            }
            return {
                id: 'local',
                label: '本地离线神经语音（T2）',
                tier: 'T2',
                ready: false,
                offline: true,
                modelDir,
                installHint: `请将 sherpa-onnx / piper 的 .onnx 模型放入 ${modelDir} 并安装对应可执行文件。`,
            };
        },
        listVoices() {
            const found = detect(modelDir);
            if (!found) return [];
            return (found.models ?? []).map(file => {
                const name = file.split('/').pop().replace(/\.onnx$/, '');
                return { id: name, label: `本地模型 · ${name}`, lang: 'zh-CN' };
            });
        },
        async synthesize({ text, voice, signal }) {
            const found = detect(modelDir);
            if (!found) {
                throw makeVoiceError('tts-local-not-installed', `尚未安装本地离线神经语音模型（目录：${modelDir}）。`, 503);
            }
            const spoken = sliceSafeChars(stripForSpeech(text), MAX_TTS_TEXT_CHARS);
            if (!spoken || !HAS_SPEAKABLE_CHAR_RE.test(spoken)) {
                throw makeVoiceError('invalid-text', '合成文本不能为空或仅包含标点。', 400);
            }
            const safePositionalText = spoken.replace(/^[\s-]+/, '').trim();
            if (!safePositionalText || !HAS_SPEAKABLE_CHAR_RE.test(safePositionalText)) {
                throw makeVoiceError('invalid-text', '合成文本不能为空或仅包含标点。', 400);
            }
            const dir = mkdtempSync(join(tmpdir(), 'marshal-local-tts-'));
            const outPath = join(dir, 'out.wav');
            try {
                const safeVoice = typeof voice === 'string' && !voice.includes('/') && !voice.includes('\\') && !voice.includes('..')
                    ? voice.trim().slice(0, 64)
                    : '';
                const selectedModel = (found.models ?? []).find(file => safeVoice && file.endsWith(`/${safeVoice}.onnx`)) ?? found.model;
                if (found.kind === 'sherpa-onnx') {
                    const args = [`--vits-model=${selectedModel}`, `--vits-tokens=${found.tokens}`, `--output-filename=${outPath}`, safePositionalText];
                    const lexicon = join(modelDir, 'lexicon.txt');
                    if (existsSync(lexicon)) args.splice(2, 0, `--vits-lexicon=${lexicon}`);
                    await execFileImpl(found.bin, args, { signal, timeout: 20_000 });
                } else if (found.kind === 'piper') {
                    const piperArgs = ['--model', selectedModel, '--output_file', outPath];
                    if (execFileImpl === execFileAsync) {
                        await execFileWithStdin(found.bin, piperArgs, { input: spoken, signal, timeout: 20_000 });
                    } else {
                        await execFileImpl(found.bin, piperArgs, { input: spoken, signal, timeout: 20_000 });
                    }
                } else {
                    await execFileImpl(found.bin, ['--output', outPath, '--text', safePositionalText], { signal, timeout: 20_000 });
                }
                const audio = await readFile(outPath);
                return { mime: 'audio/wav', audio, provider: 'local', voice: safeVoice || 'local-default' };
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    };
}

/** Pluggable TTS registry supporting T1 (default), T2 (local), system fallback, and future T3 providers. */
export function createTtsRegistry(options = {}) {
    const system = options.systemProvider ?? createSystemTtsProvider(options);
    const edge = options.edgeProvider ?? createEdgeTtsProvider({ ...options, fallbackProvider: system });
    const local = options.localProvider ?? createLocalNeuralTtsProvider(options);
    const providers = new Map([
        [edge.id, edge],
        [local.id, local],
        [system.id, system],
    ]);
    for (const extra of options.extraProviders ?? []) {
        if (extra?.id && typeof extra.synthesize === 'function') providers.set(extra.id, extra);
    }
    const limitTts = createConcurrencyLimiter(options.maxConcurrentTts ?? 2);
    return {
        defaultProviderId: 'edge',
        registerProvider(provider) {
            if (!provider?.id || typeof provider.synthesize !== 'function') {
                throw makeVoiceError('invalid-tts-provider', 'TTS Provider 缺少 id 或 synthesize 方法。');
            }
            providers.set(provider.id, provider);
        },
        get(id) {
            return providers.get(id || 'edge');
        },
        list() {
            return [...providers.values()].map(provider => ({
                ...provider.status(),
                voices: provider.listVoices(),
            }));
        },
        async synthesize({ provider: providerId, text, voice, rate, signal }) {
            const target = providers.get(providerId || 'edge');
            if (!target) throw makeVoiceError('unknown-tts-provider', `不支持的 TTS 引擎：${providerId}`);
            return await limitTts(() => target.synthesize({ text, voice, rate, signal }), signal);
        },
    };
}

function parseModelRoute(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
    return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function collectFastLlmCandidates(readDefaultModel, preferredModel) {
    const candidates = [];
    const seen = new Set();
    const push = (provider, model) => {
        if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return;
        const key = `${provider}/${model}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ provider, model });
    };
    const agentRoute = parseModelRoute(preferredModel);
    if (agentRoute) push(agentRoute.provider, agentRoute.model);
    if (typeof readDefaultModel === 'function') {
        try {
            const def = readDefaultModel();
            if (def?.provider && def?.model) push(def.provider, def.model);
        } catch { /* ignore unavailable default service */ }
    }
    return { candidates, seen, push };
}

async function collectCatalogLlmCandidates(llm, seen, push, signal) {
    const added = [];
    if (typeof llm?.listProviders !== 'function') return added;
    try {
        for (const entry of llm.listProviders() ?? []) {
            if (signal?.aborted) break;
            const provider = typeof entry === 'string' ? entry : entry?.id;
            if (!provider) continue;
            try {
                const models = await llm.listModels?.(provider);
                const first = Array.isArray(models) ? models.find(item => typeof item?.id === 'string' && item.id) : undefined;
                if (first) {
                    const key = `${provider}/${first.id}`;
                    if (!seen.has(key)) {
                        push(provider, first.id);
                        added.push({ provider, model: first.id });
                    }
                }
            } catch { /* try next provider */ }
        }
    } catch { /* ignore catalog errors */ }
    return added;
}

async function collectAgentMemoryContext(memory, agent, query, { allowGlobal = false, signal } = {}) {
    if (!memory || signal?.aborted) return '';
    const snippets = [];
    const pushRows = rows => {
        for (const row of Array.isArray(rows) ? rows : []) {
            const title = typeof row?.title === 'string' ? row.title.trim() : '';
            const content = typeof row?.content === 'string' ? row.content.trim() : '';
            const line = title && content ? `${title}：${content.slice(0, 180)}` : (title || content.slice(0, 180));
            if (line && !snippets.includes(line)) snippets.push(line);
        }
    };
    const work = async () => {
        const scopes = [];
        if (agent?.agentId) scopes.push({ scope: 'agent', ownerId: agent.agentId });
        if (agent?.workspaceId) scopes.push({ scope: 'workspace', ownerId: agent.workspaceId });
        if (allowGlobal) scopes.push({ scope: 'global', ownerId: 'global' });
        if (scopes.length === 0) return;
        if (query && typeof memory.recallFor === 'function') {
            pushRows(await memory.recallFor(scopes, query, 5, { group: false, workspaceId: agent?.workspaceId }).catch(() => []));
        }
        if (snippets.length < 4 && typeof memory.listScope === 'function') {
            for (const target of scopes.slice(0, 2)) {
                if (signal?.aborted) break;
                pushRows(await memory.listScope(target, 4, { group: false, workspaceId: agent?.workspaceId }).catch(() => []));
            }
        }
    };
    try {
        let timer;
        const timeoutPromise = new Promise(resolve => {
            timer = setTimeout(resolve, 2500);
            timer.unref?.();
        });
        await Promise.race([work(), timeoutPromise]).finally(() => clearTimeout(timer));
    } catch { /* memory enrichment is best-effort */ }
    return snippets.slice(0, 6).join('\n').slice(0, 1600);
}

function buildVoiceSystemPrompt({ agent, member, memoryContext, ticketContext }) {
    const name = member?.name || agent?.name || '智能体';
    const brief = typeof member?.brief === 'string' ? member.brief.trim().slice(0, 2000) : '';
    const parts = [
        `你现在正在与用户进行实时语音电话通话。你的身份是「${name}」。`,
        brief ? `【角色人设与职责】\n${brief}` : '',
        memoryContext ? `【相关长期记忆】\n${memoryContext}` : '',
        ticketContext ? `【当前关联工单上下文】\n${ticketContext.slice(0, 800)}` : '',
        '【语音通话表达要求】\n1. 用自然口语对话，每句话简洁明了，控制在 1~4 句内，先给结论再补充。\n2. 严禁输出 Markdown 表格、代码块、复杂符号或冗长清单；如需改代码或深度执行，可口头确认方向并提醒用户挂断后同步至 1:1 会话或工单执行。\n3. 保持角色语气一致，响应干脆利落。',
    ];
    return parts.filter(Boolean).join('\n\n');
}

function normalizeHistory(history, selected) {
    if (!Array.isArray(history)) return [];
    const out = [];
    let index = 0;
    for (const item of history.slice(-MAX_HISTORY_TURNS)) {
        const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
        const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 1000) : '';
        if (!role || !text) continue;
        index += 1;
        if (role === 'assistant') {
            out.push({
                id: `voice-hist-${index}`,
                role: 'assistant',
                source: { kind: 'model', provider: selected.provider, model: selected.model },
                content: [{ type: 'text', text }],
            });
        } else {
            out.push({
                id: `voice-hist-${index}`,
                role: 'user',
                content: [{ type: 'text', text }],
            });
        }
    }
    return out;
}

function fallbackCallSummary(agentName, transcript, notes) {
    const lines = [];
    if (notes) lines.push(`【通话笔记】\n${notes}`);
    if (transcript.length > 0) {
        lines.push('【通话记录】\n' + transcript.map(item => `${item.speaker || agentName}：${item.text}`).join('\n'));
    }
    return lines.join('\n\n').slice(0, 3000);
}

export function createVoiceEngine({
    getSpeechToText = () => undefined,
    llm: initialLlm,
    getLlm,
    readDefaultModel,
    memory,
    ttsRegistry = createTtsRegistry(),
} = {}) {
    const resolveLlm = () => (typeof getLlm === 'function' ? getLlm() : undefined) ?? initialLlm;
    const getSttCapabilities = () => {
        const stt = getSpeechToText?.();
        if (!stt || typeof stt.snapshot !== 'function') {
            return {
                available: false,
                ready: false,
                providerId: null,
                phase: 'unavailable',
                languages: [],
                message: '宿主未启用语音识别服务（SenseVoice）。',
            };
        }
        try {
            const snap = stt.snapshot();
            const providerId = snap?.selection?.providerId || 'sensevoice-local';
            const selected = (snap?.providers ?? []).find(item => item?.id === providerId) ?? snap?.providers?.[0];
            const prep = selected?.preparation ?? { phase: selected ? 'ready' : 'unavailable' };
            const phase = typeof prep.phase === 'string' ? prep.phase : (selected ? 'ready' : 'unavailable');
            const progress = typeof prep.progress === 'number' && Number.isFinite(prep.progress)
                ? Math.min(1, Math.max(0, prep.progress))
                : (typeof prep.completedBytes === 'number' && typeof prep.totalBytes === 'number' && prep.totalBytes > 0
                    ? Math.min(1, Math.max(0, prep.completedBytes / prep.totalBytes))
                    : undefined);
            return {
                available: Boolean(selected),
                ready: Boolean(selected) && STT_READY_PHASES.has(phase),
                preparing: Boolean(selected) && STT_PREPARING_PHASES.has(phase),
                providerId: selected?.id ?? providerId,
                phase,
                progress,
                message: typeof prep.message === 'string' ? prep.message : undefined,
                languages: Array.isArray(selected?.languages) ? selected.languages : ['auto', 'zh', 'en'],
            };
        } catch (error) {
            return {
                available: false,
                ready: false,
                preparing: false,
                providerId: null,
                phase: 'error',
                languages: [],
                message: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const prepareStt = ({ providerId, source, downloadSource } = {}) => {
        const stt = getSpeechToText?.();
        if (!stt || typeof stt.prepare !== 'function') {
            return { ok: false, code: 'stt-unavailable', message: '宿主未启用 SenseVoice 语音识别服务。', stt: getSttCapabilities() };
        }
        const caps = getSttCapabilities();
        const targetId = typeof providerId === 'string' && providerId.trim() ? providerId.trim() : (caps.providerId || 'sensevoice-local');
        const resolvedSource = typeof downloadSource === 'string' && downloadSource.trim()
            ? downloadSource.trim()
            : (typeof source === 'string' && source.trim() ? source.trim() : undefined);
        try {
            stt.prepare(targetId, resolvedSource ? { downloadSource: resolvedSource } : undefined);
            return { ok: true, started: true, providerId: targetId, stt: getSttCapabilities() };
        } catch (error) {
            return {
                ok: false,
                code: 'stt-prepare-failed',
                message: error instanceof Error ? error.message : String(error),
                stt: getSttCapabilities(),
            };
        }
    };

    const transcribe = async ({ audioBase64, audioBuffer, language = 'auto', providerId }, signal) => {
        const stt = getSpeechToText?.();
        if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
            throw makeVoiceError('stt-unavailable', '宿主未启用语音识别服务（SenseVoice）。', 503);
        }
        const caps = getSttCapabilities();
        if (!STT_READY_PHASES.has(caps.phase)) {
            throw makeVoiceError(
                'stt-not-ready',
                STT_PREPARING_PHASES.has(caps.phase) ? 'SenseVoice 模型正在准备中，请稍候。' : 'SenseVoice 语音模型尚未就绪，请先点击准备模型。',
                503,
            );
        }
        let buf = audioBuffer;
        if (!buf) {
            if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
                throw makeVoiceError('invalid-audio', '缺少音频数据。', 400);
            }
            if (audioBase64.length > Math.ceil(MAX_WAV_BYTES / 3) * 4 + 16) {
                throw makeVoiceError('audio-too-large', '语音片段超出大小限制。', 413);
            }
            buf = Buffer.from(audioBase64.trim(), 'base64');
        }
        const check = validateWavBuffer(buf);
        if (!check.ok) throw makeVoiceError(check.code, check.message, check.code === 'audio-too-large' ? 413 : 400);
        const lang = typeof language === 'string' && language.trim() ? language.trim() : 'auto';
        const effectiveSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
        try {
            const spec = stt.resolve({
                audio: buf,
                language: lang,
                ...(typeof providerId === 'string' && providerId.trim() ? { providerId: providerId.trim() } : {}),
            });
            const result = await stt.transcribe(spec, effectiveSignal);
            const text = typeof result === 'string' ? result.trim() : String(result?.text ?? '').trim();
            return { ok: true, text, language: result?.language ?? lang };
        } catch (error) {
            if (effectiveSignal.aborted) throw makeVoiceError('aborted', '语音识别已取消。', 499);
            const msg = error instanceof Error ? error.message : String(error);
            const notReady = /not ready|missing|prepare|download|model/i.test(msg);
            throw makeVoiceError(notReady ? 'stt-not-ready' : 'stt-failed', msg, notReady ? 503 : 500);
        }
    };

    const tryPrepareCandidates = async (llm, candidates, maxTokens, signal) => {
        for (const candidate of candidates) {
            if (signal?.aborted) return null;
            try {
                if (typeof llm.prepareCall === 'function') {
                    const prepared = await llm.prepareCall({
                        provider: candidate.provider,
                        model: candidate.model,
                        maxTokens,
                    }, signal);
                    return { prepared, selected: candidate };
                }
                return {
                    prepared: {
                        config: { provider: candidate.provider, model: candidate.model, maxTokens },
                        stream: req => llm.stream(req),
                    },
                    selected: candidate,
                };
            } catch { /* try next candidate */ }
        }
        return null;
    };

    const streamVoiceTurn = async function* ({ agent, member, text, history, ticketContext, allowGlobalMemory = false, signal }) {
        const utterance = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        if (!utterance) throw makeVoiceError('invalid-text', '语音输入内容不能为空。', 400);
        const llm = resolveLlm();
        if (!llm || (typeof llm.prepareCall !== 'function' && typeof llm.stream !== 'function')) {
            throw makeVoiceError('no-llm', '当前宿主未提供可用的对话模型服务。', 503);
        }
        const { candidates: fastCandidates, seen, push } = collectFastLlmCandidates(readDefaultModel, member?.model);
        const [memoryContext, fastInit] = await Promise.all([
            collectAgentMemoryContext(memory, agent, utterance, { allowGlobal: allowGlobalMemory === true, signal }),
            tryPrepareCandidates(llm, fastCandidates, 2048, signal),
        ]);
        if (signal?.aborted) return;
        let init = fastInit;
        if (!init) {
            const catalogCandidates = await collectCatalogLlmCandidates(llm, seen, push, signal);
            if (signal?.aborted) return;
            if (fastCandidates.length === 0 && catalogCandidates.length === 0) {
                throw makeVoiceError('no-model', '未找到可用于语音对话的模型配置。', 503);
            }
            init = await tryPrepareCandidates(llm, catalogCandidates, 2048, signal);
        }
        if (!init) throw makeVoiceError('no-model', '模型初始化失败，请检查当前模型配置。', 503);
        const { prepared, selected } = init;
        const system = buildVoiceSystemPrompt({ agent, member, memoryContext, ticketContext });
        const prior = normalizeHistory(history, selected);
        const messages = [
            ...prior,
            { id: `voice-user-${prior.length + 1}`, role: 'user', content: [{ type: 'text', text: utterance }] },
        ];

        const splitter = createSentenceSplitter();
        let fullText = '';
        let sentenceIndex = 0;

        if (typeof prepared.stream === 'function') {
            for await (const chunk of prepared.stream({
                ...prepared.config,
                system,
                signal,
                tools: [],
                messages,
            })) {
                if (signal?.aborted) return;
                if (!chunk || typeof chunk !== 'object') continue;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
                    fullText += chunk.text;
                    yield { type: 'delta', text: chunk.text };
                    for (const sentence of splitter.push(chunk.text)) {
                        yield { type: 'sentence', index: sentenceIndex++, text: sentence };
                    }
                } else if (chunk.type === 'finish') {
                    if (chunk.reason?.kind === 'error' && !fullText.trim()) {
                        throw makeVoiceError('model-error', chunk.reason?.failure?.message || '模型返回异常。', 502);
                    }
                    break;
                }
            }
        } else if (typeof prepared.text === 'string') {
            fullText = prepared.text;
            yield { type: 'delta', text: fullText };
            for (const sentence of splitter.push(fullText)) {
                yield { type: 'sentence', index: sentenceIndex++, text: sentence };
            }
        }
        if (signal?.aborted) return;
        for (const sentence of splitter.flush()) {
            yield { type: 'sentence', index: sentenceIndex++, text: sentence };
        }
        yield {
            type: 'done',
            text: fullText.trim(),
            spokenText: stripForSpeech(fullText),
            model: `${selected.provider}/${selected.model}`,
        };
    };

    const summarizeCall = async ({ agent, member, transcript = [], notes = '', ticketTitle = '', signal }) => {
        const cleanTranscript = Array.isArray(transcript)
            ? transcript.slice(-120).map(item => ({
                speaker: String(item?.speaker || '').trim().slice(0, 80),
                text: String(item?.text || '').trim().slice(0, 1200),
            })).filter(item => item.text)
            : [];
        const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 3000) : '';
        const agentName = member?.name || agent?.name || '智能体';
        if (cleanTranscript.length === 0 && !cleanNotes) return { ok: true, summary: '', source: 'empty' };

        const llm = resolveLlm();
        if (llm && typeof llm.prepareCall === 'function') {
            const totalSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
            try {
                const { candidates: fastCandidates, seen, push } = collectFastLlmCandidates(readDefaultModel, member?.model);
                const transcriptBlock = cleanTranscript.map(item => `${item.speaker || agentName}：${item.text}`).join('\n');
                const userPrompt = [
                    `请将以下与「${agentName}」的语音通话整理为简洁清晰的结构化纪要（不超过 800 字），按「核心结论 / 待办事项 / 需同步指导要点」分点输出，不要编造未提及的内容。`,
                    ticketTitle ? `关联工单：${ticketTitle}` : '',
                    cleanNotes ? `通话笔记：\n${cleanNotes}` : '',
                    transcriptBlock ? `通话记录：\n${transcriptBlock.slice(0, 8000)}` : '',
                ].filter(Boolean).join('\n\n');

                const trySummarize = async list => {
                    for (const candidate of list) {
                        if (totalSignal.aborted) return null;
                        try {
                            const prepared = await llm.prepareCall({
                                provider: candidate.provider,
                                model: candidate.model,
                                maxTokens: 1536,
                            }, totalSignal);
                            let summary = '';
                            if (typeof prepared.stream === 'function') {
                                for await (const chunk of prepared.stream({
                                    ...prepared.config,
                                    signal: totalSignal,
                                    tools: [],
                                    messages: [{ id: 'voice-summary-1', role: 'user', content: [{ type: 'text', text: userPrompt }] }],
                                })) {
                                    if (totalSignal.aborted) break;
                                    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text;
                                    if (chunk?.type === 'finish') break;
                                }
                            } else if (typeof prepared.text === 'string') {
                                summary = prepared.text;
                            }
                            if (summary.trim()) return { ok: true, summary: summary.trim().slice(0, 3000), source: 'llm' };
                        } catch { /* try next candidate */ }
                    }
                    return null;
                };
                const fastResult = await trySummarize(fastCandidates);
                if (fastResult) return fastResult;
                if (!totalSignal.aborted) {
                    const catalogCandidates = await collectCatalogLlmCandidates(llm, seen, push, totalSignal);
                    const catalogResult = await trySummarize(catalogCandidates);
                    if (catalogResult) return catalogResult;
                }
            } catch { /* fallback below */ }
        }
        return { ok: true, summary: fallbackCallSummary(agentName, cleanTranscript, cleanNotes), source: 'fallback' };
    };

    return {
        capabilities() {
            const ttsProviders = ttsRegistry.list();
            return {
                ok: true,
                stt: getSttCapabilities(),
                tts: {
                    defaultProvider: ttsRegistry.defaultProviderId,
                    defaultVoice: EDGE_DEFAULT_VOICE,
                    providers: ttsProviders,
                },
                llmAvailable: Boolean(resolveLlm() && (typeof resolveLlm().prepareCall === 'function' || typeof resolveLlm().stream === 'function')),
            };
        },
        prepareStt,
        transcribe,
        streamVoiceTurn,
        synthesizeTts: (params) => ttsRegistry.synthesize(params),
        summarizeCall,
        ttsRegistry,
    };
}
