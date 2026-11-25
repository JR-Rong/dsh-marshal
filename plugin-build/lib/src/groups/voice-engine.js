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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
const DEFAULT_SAY_VOICE = 'Tingting';

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
    const extract = flush => {
        const out = [];
        while (buffer.length > 0) {
            const match = buffer.match(/^([\s\S]*?(?:[。！？；\n]+|[.!?](?=\s|$)))/);
            if (match && match[1].trim().length >= minChars) {
                const raw = match[1];
                buffer = buffer.slice(raw.length);
                const spoken = stripForSpeech(raw);
                if (spoken) out.push(spoken);
                continue;
            }
            if (buffer.length >= maxChars) {
                const soft = buffer.slice(0, maxChars).match(/^([\s\S]*[，,、：:\s])/);
                const cut = soft && soft[1].trim().length >= minChars ? soft[1].length : maxChars;
                const raw = buffer.slice(0, cut);
                buffer = buffer.slice(cut);
                const spoken = stripForSpeech(raw);
                if (spoken) out.push(spoken);
                continue;
            }
            break;
        }
        if (flush && buffer.trim()) {
            const spoken = stripForSpeech(buffer);
            buffer = '';
            if (spoken) out.push(spoken);
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
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
        return { ok: false, code: 'invalid-audio', message: '音频内容过短或不是有效的 WAV 文件。' };
    }
    if (buffer.length > maxBytes) {
        return { ok: false, code: 'audio-too-large', message: `单段语音超过大小上限（${Math.round(maxBytes / 1024 / 1024)} MB）。` };
    }
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
        return { ok: false, code: 'invalid-audio', message: '音频必须是标准 WAV（RIFF/WAVE）格式。' };
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
            const spoken = stripForSpeech(text).slice(0, MAX_TTS_TEXT_CHARS);
            if (!spoken) throw makeVoiceError('invalid-text', '合成文本不能为空。', 400);
            const selectedVoice = typeof voice === 'string' && SAFE_SAY_VOICE_RE.test(voice.trim())
                ? voice.trim()
                : DEFAULT_SAY_VOICE;
            const rateNum = typeof rate === 'number' && Number.isFinite(rate)
                ? Math.max(120, Math.min(320, Math.round(190 * rate)))
                : 190;
            const dir = mkdtempSync(join(tmpdir(), 'marshal-say-'));
            const aiffPath = join(dir, 'speech.aiff');
            const wavPath = join(dir, 'speech.wav');
            try {
                await execFileImpl(sayBin, ['-v', selectedVoice, '-r', String(rateNum), '-o', aiffPath, '--', spoken], {
                    signal,
                    timeout: 15_000,
                });
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
                const audio = readFileSync(wavPath);
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
            const spoken = stripForSpeech(text).slice(0, MAX_TTS_TEXT_CHARS);
            if (!spoken) throw makeVoiceError('invalid-text', '合成文本不能为空。', 400);
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
            const spoken = stripForSpeech(text).slice(0, MAX_TTS_TEXT_CHARS);
            if (!spoken) throw makeVoiceError('invalid-text', '合成文本不能为空。', 400);
            const dir = mkdtempSync(join(tmpdir(), 'marshal-local-tts-'));
            const outPath = join(dir, 'out.wav');
            try {
                const safeVoice = typeof voice === 'string' && !voice.includes('/') && !voice.includes('\\') && !voice.includes('..') ? voice : '';
                const selectedModel = (found.models ?? []).find(file => safeVoice && file.endsWith(`/${safeVoice}.onnx`)) ?? found.model;
                const safePositionalText = spoken.replace(/^-+/, '').trim() || ' ';
                if (found.kind === 'sherpa-onnx') {
                    const args = [`--vits-model=${selectedModel}`, `--vits-tokens=${found.tokens}`, `--output-filename=${outPath}`, safePositionalText];
                    const lexicon = join(modelDir, 'lexicon.txt');
                    if (existsSync(lexicon)) args.splice(2, 0, `--vits-lexicon=${lexicon}`);
                    await execFileImpl(found.bin, args, { signal, timeout: 20_000 });
                } else if (found.kind === 'piper') {
                    await execFileImpl(found.bin, ['--model', selectedModel, '--output_file', outPath, '--text', spoken], { signal, timeout: 20_000 });
                } else {
                    await execFileImpl(found.bin, ['--output', outPath, '--text', spoken], { signal, timeout: 20_000 });
                }
                const audio = readFileSync(outPath);
                return { mime: 'audio/wav', audio, provider: 'local', voice: voice || 'local-default' };
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
            return await target.synthesize({ text, voice, rate, signal });
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

async function resolveLlmCandidate(llm, readDefaultModel, preferredModel) {
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
    if (typeof llm?.listProviders === 'function') {
        try {
            for (const entry of llm.listProviders() ?? []) {
                const provider = typeof entry === 'string' ? entry : entry?.id;
                if (!provider) continue;
                try {
                    const models = await llm.listModels?.(provider);
                    const first = Array.isArray(models) ? models.find(item => typeof item?.id === 'string' && item.id) : undefined;
                    if (first) push(provider, first.id);
                } catch { /* try next provider */ }
            }
        } catch { /* ignore catalog errors */ }
    }
    return candidates;
}

async function collectAgentMemoryContext(memory, agent, query) {
    if (!memory) return '';
    const snippets = [];
    const pushRows = rows => {
        for (const row of Array.isArray(rows) ? rows : []) {
            const title = typeof row?.title === 'string' ? row.title.trim() : '';
            const content = typeof row?.content === 'string' ? row.content.trim() : '';
            const line = title && content ? `${title}：${content.slice(0, 180)}` : (title || content.slice(0, 180));
            if (line && !snippets.includes(line)) snippets.push(line);
        }
    };
    try {
        const scopes = [];
        if (agent?.agentId) scopes.push({ scope: 'agent', ownerId: agent.agentId });
        if (agent?.workspaceId) scopes.push({ scope: 'workspace', ownerId: agent.workspaceId });
        scopes.push({ scope: 'global', ownerId: 'global' });
        if (query && typeof memory.recallFor === 'function') {
            pushRows(await memory.recallFor(scopes, query, 5, { group: false, workspaceId: agent?.workspaceId }).catch(() => []));
        }
        if (snippets.length < 4 && typeof memory.listScope === 'function') {
            for (const target of scopes.slice(0, 2)) {
                pushRows(await memory.listScope(target, 4, { group: false, workspaceId: agent?.workspaceId }).catch(() => []));
            }
        }
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

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    const out = [];
    for (const item of history.slice(-MAX_HISTORY_TURNS)) {
        const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
        const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 1000) : '';
        if (role && text) out.push({ role, content: [{ type: 'text', text }] });
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
            return {
                available: Boolean(selected),
                ready: prep.phase === 'ready',
                providerId: selected?.id ?? providerId,
                phase: prep.phase ?? 'idle',
                progress: typeof prep.progress === 'number' ? prep.progress : undefined,
                message: typeof prep.message === 'string' ? prep.message : undefined,
                languages: Array.isArray(selected?.languages) ? selected.languages : ['auto', 'zh', 'en'],
            };
        } catch (error) {
            return {
                available: false,
                ready: false,
                providerId: null,
                phase: 'error',
                languages: [],
                message: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const prepareStt = ({ providerId, source } = {}) => {
        const stt = getSpeechToText?.();
        if (!stt || typeof stt.prepare !== 'function') {
            return { ok: false, code: 'stt-unavailable', message: '宿主未启用 SenseVoice 语音识别服务。', stt: getSttCapabilities() };
        }
        const caps = getSttCapabilities();
        const targetId = typeof providerId === 'string' && providerId.trim() ? providerId.trim() : (caps.providerId || 'sensevoice-local');
        try {
            stt.prepare(targetId, source ? { source } : undefined);
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
        if (caps.phase !== 'ready' && caps.phase !== 'idle') {
            throw makeVoiceError('stt-not-ready', caps.phase === 'preparing' ? 'SenseVoice 模型正在准备中，请稍候。' : 'SenseVoice 语音模型尚未就绪，请先点击准备模型。', 503);
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

    const streamVoiceTurn = async function* ({ agent, member, text, history, ticketContext, signal }) {
        const utterance = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        if (!utterance) throw makeVoiceError('invalid-text', '语音输入内容不能为空。', 400);
        const llm = resolveLlm();
        if (!llm || (typeof llm.prepareCall !== 'function' && typeof llm.stream !== 'function')) {
            throw makeVoiceError('no-llm', '当前宿主未提供可用的对话模型服务。', 503);
        }
        const candidates = await resolveLlmCandidate(llm, readDefaultModel, member?.model);
        if (candidates.length === 0) {
            throw makeVoiceError('no-model', '未找到可用于语音对话的模型配置。', 503);
        }
        const memoryContext = await collectAgentMemoryContext(memory, agent, utterance);
        const system = buildVoiceSystemPrompt({ agent, member, memoryContext, ticketContext });
        const prior = normalizeHistory(history);
        const messages = [
            ...prior,
            { role: 'user', content: [{ type: 'text', text: utterance }] },
        ];
        let prepared;
        let selected;
        for (const candidate of candidates) {
            if (signal?.aborted) return;
            try {
                if (typeof llm.prepareCall === 'function') {
                    prepared = await llm.prepareCall({
                        provider: candidate.provider,
                        model: candidate.model,
                        maxTokens: 600,
                    }, signal);
                } else {
                    prepared = {
                        config: { provider: candidate.provider, model: candidate.model, maxTokens: 600 },
                        stream: req => llm.stream(req),
                    };
                }
                selected = candidate;
                break;
            } catch { /* try next candidate */ }
        }
        if (!prepared) throw makeVoiceError('no-model', '模型初始化失败，请检查当前模型配置。', 503);

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
            try {
                const candidates = await resolveLlmCandidate(llm, readDefaultModel, member?.model);
                const transcriptBlock = cleanTranscript.map(item => `${item.speaker || agentName}：${item.text}`).join('\n');
                const userPrompt = [
                    `请将以下与「${agentName}」的语音通话整理为简洁清晰的结构化纪要（不超过 800 字），按「核心结论 / 待办事项 / 需同步指导要点」分点输出，不要编造未提及的内容。`,
                    ticketTitle ? `关联工单：${ticketTitle}` : '',
                    cleanNotes ? `通话笔记：\n${cleanNotes}` : '',
                    transcriptBlock ? `通话记录：\n${transcriptBlock.slice(0, 8000)}` : '',
                ].filter(Boolean).join('\n\n');

                for (const candidate of candidates) {
                    if (signal?.aborted) break;
                    try {
                        const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
                        const prepared = await llm.prepareCall({
                            provider: candidate.provider,
                            model: candidate.model,
                            maxTokens: 600,
                        }, callSignal);
                        let summary = '';
                        if (typeof prepared.stream === 'function') {
                            for await (const chunk of prepared.stream({
                                ...prepared.config,
                                signal: callSignal,
                                tools: [],
                                messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
                            })) {
                                if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text;
                                if (chunk?.type === 'finish') break;
                            }
                        } else if (typeof prepared.text === 'string') {
                            summary = prepared.text;
                        }
                        if (summary.trim()) return { ok: true, summary: summary.trim().slice(0, 3000), source: 'llm' };
                    } catch { /* try next candidate */ }
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
