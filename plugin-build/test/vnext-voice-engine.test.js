import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { escapeSsml, generateSecMsGecV2, normalizeEdgeRate, normalizeEdgeVoice, synthesizeEdgeTts } from '../lib/src/groups/edge-tts.js';
import {
    createEdgeTtsProvider,
    createLocalNeuralTtsProvider,
    createSentenceSplitter,
    createSystemTtsProvider,
    createTtsRegistry,
    createVoiceEngine,
    stripForSpeech,
    validateWavBuffer,
} from '../lib/src/groups/voice-engine.js';
import { mountGroups } from '../lib/src/groups/mount.js';
import { createMarshalEventBus } from '../lib/src/groups/event-bus.js';
import { DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const origin = 'http://127.0.0.1:21081';
const deviceId = 'voice-node';
const agentKey = `${deviceId}/squad/chancellor`;

function makeWav(sampleCount = 160) {
    const dataBytes = sampleCount * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);
    return buf;
}

function voiceFixture({ speechToText, llm, memory, tasks = [] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'marshal-voice-'));
    const savedHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    mkdirSync(join(root, 'dsh-agents'));
    mkdirSync(join(root, 'storages'));
    writeFileSync(join(root, 'storages/workspace.json'), JSON.stringify({ tables: { workspaces: { ws: {} } } }));
    writeFileSync(join(root, 'dsh-agents/ledger.json'), JSON.stringify({
        teams: [{
            id: 'squad',
            name: 'marshal-agent:丞相',
            workspaceId: 'ws',
            members: [{
                id: 'chancellor',
                name: '丞相',
                model: 'deepseek-account/deepseek-flash',
                brief: '你是皇上钦点的丞相，说话干脆利落。',
            }],
        }],
        runs: [],
    }));
    writeFileSync(join(root, 'tasks.json'), JSON.stringify({ version: 1, tasks }));
    const routes = new Map();
    const dispose = [];
    const effect = setup => dispose.push(setup());
    const webServer = {
        getOrigin: () => origin,
        register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
        },
    };
    const ctx = {
        effect,
        inject([name], register) {
            if (name === 'webServer') register({ effect, webServer });
        },
        get(name) {
            if (name === 'deepseekAccount') return { getPlatformSession: async () => ({ userId: 'voice-owner', origin: DSH_ACCOUNT_ORIGIN }) };
            if (name === 'speechToText') return speechToText;
            if (name === 'llm') return llm;
            if (name === 'agentDefaultModel') return { provider: 'deepseek-account', model: 'deepseek-flash' };
        },
        sessionController: { async list() { return { items: [] }; } },
    };
    const eventBus = createMarshalEventBus();
    mountGroups(ctx, { deviceId, agents: ['dsh'], groupsRoot: root, memoryRoot: join(root, 'memory') }, {
        eventBus,
        memory: memory ?? {
            listProposals: () => [],
            recallFor: async () => [{ title: '皇上偏好', content: '优先给结论，不废话。' }],
            listScope: async () => [],
        },
    });
    const request = async (method, url, body, headers = {}, remoteAddress = '127.0.0.1') => {
        const req = Object.assign(new EventEmitter(), {
            method,
            url,
            headers: { host: '127.0.0.1:21081', origin, ...headers },
            socket: { remoteAddress },
            async *[Symbol.asyncIterator]() {
                if (body !== undefined) yield Buffer.from(JSON.stringify(body));
            },
        });
        const chunks = [];
        const res = Object.assign(new EventEmitter(), {
            headers: {},
            status: 0,
            destroyed: false,
            writableEnded: false,
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            writeHead(status, hdrs = {}) {
                this.status = status;
                for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
            },
            write(chunk) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                return true;
            },
            end(chunk) {
                if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                this.writableEnded = true;
                this.raw = Buffer.concat(chunks);
                const ct = String(this.headers['content-type'] || '');
                if (ct.includes('application/json') && this.raw.length > 0) this.body = JSON.parse(this.raw.toString('utf8'));
                else this.text = this.raw.toString('utf8');
            },
        });
        const route = routes.get(url.split('?')[0]);
        assert.ok(route, `missing route ${url}`);
        await route.handler(req, res);
        return res;
    };
    const signIn = async () => {
        const res = await request('POST', '/marshal/memory/session', undefined, { 'x-marshal-memory': '1' });
        assert.equal(res.status, 200);
        const cookies = res.headers['set-cookie'].map(value => value.split(';')[0]);
        return { cookie: cookies.join('; '), 'x-marshal-csrf': cookies[1].split('=')[1] };
    };
    return {
        request,
        signIn,
        close() {
            for (const fn of dispose.splice(0).reverse()) fn?.();
            if (savedHome === undefined) delete process.env.DSH_HOME;
            else process.env.DSH_HOME = savedHome;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test('Edge TTS v2 token format, SSML escaping, and rate/voice normalization', () => {
    const token = generateSecMsGecV2(1795536000);
    assert.match(token, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
    assert.equal(generateSecMsGecV2(1795536100), token, 'same 5-minute bucket produces identical token');
    assert.equal(escapeSsml('a < b & "c"\u0007'), 'a &lt; b &amp; &quot;c&quot;');
    assert.equal(normalizeEdgeVoice('zh-CN-YunxiNeural'), 'zh-CN-YunxiNeural');
    assert.equal(normalizeEdgeVoice('zh-CN-liaoning-XiaobeiNeural'), 'zh-CN-liaoning-XiaobeiNeural');
    assert.equal(normalizeEdgeVoice('bad;voice<tag>'), 'zh-CN-XiaoxiaoNeural');
    assert.equal(normalizeEdgeRate(1.2), '+20%');
    assert.equal(normalizeEdgeRate('-15%'), '-15%');
    assert.equal(normalizeEdgeRate('invalid'), '+0%');
});

test('sentence splitter strips markdown and emits Chinese & English sentences incrementally', () => {
    assert.equal(stripForSpeech('**重点**：看 `app.ts` 里的 ```js\nconst x=1;\n```'), '重点：看 app.ts 里的 （相关代码我已整理好，挂断后可在纪要中查看）');
    const splitter = createSentenceSplitter({ minChars: 4, maxChars: 60 });
    assert.deepEqual(splitter.push('好的，'), []);
    assert.deepEqual(splitter.push('我立刻安排。接下来'), ['好的，我立刻安排。']);
    assert.deepEqual(splitter.push('检查测试！All done. 还有一句'), ['接下来检查测试！', 'All done.']);
    assert.deepEqual(splitter.flush(), ['还有一句']);
});

test('WAV validation rejects short, malformed, and oversized buffers', () => {
    assert.equal(validateWavBuffer(makeWav()).ok, true);
    assert.equal(validateWavBuffer(Buffer.from('not-a-wav')).code, 'invalid-audio');
    assert.equal(validateWavBuffer(Buffer.alloc(60)).code, 'invalid-audio');
    assert.equal(validateWavBuffer(makeWav(100), 100).code, 'audio-too-large');
});

test('pluggable TTS registry handles T1 Edge->system fallback, T2 local detection, and T3 registration', async () => {
    const systemStub = {
        id: 'system',
        label: 'system',
        tier: 'T1-fallback',
        status: () => ({ id: 'system', tier: 'T1-fallback', ready: true, offline: true }),
        listVoices: () => [{ id: 'Tingting', label: '婷婷' }],
        async synthesize({ text }) { return { mime: 'audio/wav', audio: Buffer.from('SYS:' + text), provider: 'system', voice: 'Tingting' }; },
    };
    let edgeShouldFail = false;
    const edge = createEdgeTtsProvider({
        fallbackProvider: systemStub,
        async synthesizeEdge({ text, voice }) {
            if (edgeShouldFail) throw Object.assign(new Error('offline'), { code: 'edge-network' });
            return { mime: 'audio/mpeg', audio: Buffer.from('EDGE:' + text), provider: 'edge', voice };
        },
    });
    const missingDir = mkdtempSync(join(tmpdir(), 'marshal-empty-tts-'));
    const localMissing = createLocalNeuralTtsProvider({ modelDir: missingDir });
    const registry = createTtsRegistry({ edgeProvider: edge, localProvider: localMissing, systemProvider: systemStub });
    try {
        const okEdge = await registry.synthesize({ provider: 'edge', text: '测试第一句', voice: 'zh-CN-YunxiNeural' });
        assert.equal(okEdge.provider, 'edge');
        assert.equal(okEdge.mime, 'audio/mpeg');
        assert.equal(okEdge.fallbackFrom, undefined);

        edgeShouldFail = true;
        const fallback = await registry.synthesize({ provider: 'edge', text: '断网测试' });
        assert.equal(fallback.provider, 'system');
        assert.equal(fallback.fallbackFrom, 'edge');
        assert.equal(fallback.mime, 'audio/wav');

        assert.equal(localMissing.status().ready, false);
        await assert.rejects(() => registry.synthesize({ provider: 'local', text: '离线' }), { code: 'tts-local-not-installed' });

        // T3 commercial provider plug-in
        registry.registerProvider({
            id: 'doubao',
            status: () => ({ id: 'doubao', tier: 'T3', ready: true, offline: false }),
            listVoices: () => [{ id: 'BV001', label: '豆包女声' }],
            async synthesize({ text }) { return { mime: 'audio/mpeg', audio: Buffer.from('T3:' + text), provider: 'doubao', voice: 'BV001' }; },
        });
        const t3 = await registry.synthesize({ provider: 'doubao', text: '扩展音色' });
        assert.equal(t3.provider, 'doubao');
        assert.equal(registry.list().some(p => p.id === 'doubao' && p.ready), true);
    } finally {
        rmSync(missingDir, { recursive: true, force: true });
    }
});

test('all 6 /marshal/voice/* routes reject unauthorized requests with 403', async () => {
    const app = voiceFixture();
    try {
        for (const [method, path] of [
            ['GET', '/marshal/voice/capabilities'],
            ['POST', '/marshal/voice/prepare'],
            ['POST', '/marshal/voice/transcribe'],
            ['POST', '/marshal/voice/turn'],
            ['POST', '/marshal/voice/tts'],
            ['POST', '/marshal/voice/summarize'],
        ]) {
            const res = await app.request(method, path, method === 'POST' ? {} : undefined);
            assert.equal(res.status, 403, `${method} ${path} must reject unauthenticated caller`);
        }
    } finally {
        app.close();
    }
});

test('voice routes integrate SenseVoice STT, A1 streaming LLM with persona/memory/abort, and call summarization', async () => {
    let preparedProvider = null;
    let capturedStreamArgs = null;
    const speechToText = {
        snapshot: () => ({
            selection: { providerId: 'sensevoice-local', language: 'auto' },
            providers: [{ id: 'sensevoice-local', languages: ['auto', 'zh', 'en'], preparation: { phase: 'ready' } }],
        }),
        prepare(id) { preparedProvider = id; },
        resolve: req => ({ provider: { id: 'sensevoice-local' }, audio: req.audio, language: req.language }),
        async transcribe(spec, signal) {
            signal.throwIfAborted();
            return { text: '帮我看看工单进度', language: spec.language };
        },
    };
    const llm = {
        async prepareCall(cfg) {
            return {
                config: cfg,
                async *stream(args) {
                    capturedStreamArgs = args;
                    if (String(args.messages?.[0]?.content?.[0]?.text || '').includes('结构化纪要')) {
                        yield { type: 'text-delta', text: '核心结论：工单正常推进。\n待办：继续跟进测试。' };
                        yield { type: 'finish', reason: { kind: 'stop' } };
                        return;
                    }
                    yield { type: 'text-delta', text: '启禀皇上，' };
                    yield { type: 'text-delta', text: '目前进度顺利。' };
                    yield { type: 'text-delta', text: '接下来进入验收。' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };
    const app = voiceFixture({
        speechToText,
        llm,
        tasks: [{ id: 'ticket-1', title: '手机端测试', description: '检查四栏功能', status: 'running', workspaceId: 'ws' }],
    });
    try {
        const headers = await app.signIn();
        const caps = await app.request('GET', '/marshal/voice/capabilities', undefined, headers);
        assert.equal(caps.status, 200);
        assert.equal(caps.body.stt.ready, true);
        assert.equal(caps.body.stt.providerId, 'sensevoice-local');
        assert.equal(caps.body.tts.defaultProvider, 'edge');
        assert.equal(caps.body.llmAvailable, true);

        const prep = await app.request('POST', '/marshal/voice/prepare', {}, headers);
        assert.equal(prep.status, 200);
        assert.equal(preparedProvider, 'sensevoice-local');

        const sttRes = await app.request('POST', '/marshal/voice/transcribe', {
            audioBase64: makeWav().toString('base64'),
            language: 'zh',
        }, headers);
        assert.equal(sttRes.status, 200);
        assert.equal(sttRes.body.text, '帮我看看工单进度');

        const emptyTurn = await app.request('POST', '/marshal/voice/turn', { agentKey, text: '   ' }, headers);
        assert.equal(emptyTurn.status, 400);
        assert.equal(emptyTurn.body.error, 'invalid-text');

        const turnRes = await app.request('POST', '/marshal/voice/turn', {
            agentKey,
            text: '帮我看看工单进度',
            targetTicketId: 'ticket-1',
            history: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '皇上好。' }],
        }, headers);
        assert.equal(turnRes.status, 200);
        assert.match(turnRes.headers['content-type'], /text\/event-stream/);
        assert.ok(capturedStreamArgs.system.includes('丞相'), 'system prompt includes agent persona');
        assert.ok(capturedStreamArgs.system.includes('皇上偏好'), 'system prompt includes Mnemon memory');
        assert.ok(capturedStreamArgs.system.includes('手机端测试'), 'system prompt includes ticket context');
        assert.ok(turnRes.text.includes('event: sentence'));
        assert.ok(turnRes.text.includes('启禀皇上，目前进度顺利。'));
        assert.ok(turnRes.text.includes('event: done'));

        const sumRes = await app.request('POST', '/marshal/voice/summarize', {
            agentKey,
            targetTicketId: 'ticket-1',
            notes: '重点盯紧真机安装',
            transcript: [
                { speaker: '我', text: '帮我看看工单进度' },
                { speaker: '丞相', text: '目前进度顺利。' },
            ],
        }, headers);
        assert.equal(sumRes.status, 200);
        assert.equal(sumRes.body.source, 'llm');
        assert.ok(sumRes.body.summary.includes('核心结论'));
    } finally {
        app.close();
    }
});

test('voice engine degrades cleanly when STT/LLM are absent and cancels streaming turn on AbortSignal', async () => {
    const abortController = new AbortController();
    const llm = {
        async prepareCall(cfg) {
            return {
                config: cfg,
                async *stream({ signal }) {
                    yield { type: 'text-delta', text: '第一句说完了。' };
                    abortController.abort();
                    if (signal?.aborted) return;
                    yield { type: 'text-delta', text: '这句不该输出。' };
                },
            };
        },
    };
    const engine = createVoiceEngine({ llm, readDefaultModel: () => ({ provider: 'deepseek', model: 'flash' }) });
    const events = [];
    for await (const ev of engine.streamVoiceTurn({
        agent: { name: '丞相', agentId: 'a1' },
        member: { name: '丞相', brief: '人设' },
        text: '说两句',
        signal: abortController.signal,
    })) {
        events.push(ev);
    }
    assert.equal(events.some(e => e.type === 'sentence' && e.text === '第一句说完了。'), true);
    assert.equal(events.some(e => e.type === 'done'), false, 'aborted turn stops without emitting done');

    const bare = createVoiceEngine({});
    assert.equal(bare.capabilities().stt.available, false);
    assert.equal(bare.prepareStt().ok, false);
    await assert.rejects(() => bare.transcribe({ audioBase64: makeWav().toString('base64') }), { code: 'stt-unavailable' });
    const fallbackSum = await bare.summarizeCall({
        agent: { name: '丞相' },
        notes: '保留备注',
        transcript: [{ speaker: '我', text: '先这样' }],
    });
    assert.equal(fallbackSum.source, 'fallback');
    assert.ok(fallbackSum.summary.includes('保留备注'));
    assert.ok(fallbackSum.summary.includes('我：先这样'));

    if (process.platform === 'darwin') {
        const calls = [];
        const sys = createSystemTtsProvider({
            async execFileImpl(bin, args) {
                calls.push({ bin, args });
                if (bin.endsWith('say') && args.includes('MissingVoice')) {
                    const err = new Error('Command failed');
                    err.stderr = "Voice 'MissingVoice' not found.";
                    throw err;
                }
                if (bin.endsWith('afconvert') || bin.endsWith('ffmpeg')) {
                    const out = args[args.length - 1];
                    writeFileSync(out, makeWav(10));
                }
            },
        });
        const audio = await sys.synthesize({ text: '-f /etc/passwd', voice: '-badvoice' });
        assert.equal(audio.voice, 'Tingting');
        assert.equal(calls[0].args[calls[0].args.length - 2], '--');
        assert.equal(calls[0].args[calls[0].args.length - 1], '-f /etc/passwd');

        // Edge neural voice name must not leak into macOS say
        const fromEdge = await sys.synthesize({ text: '系统播报测试', voice: 'zh-CN-XiaoxiaoNeural' });
        assert.equal(fromEdge.voice, 'Tingting');

        // Unknown macOS voice retries automatically with default Tingting
        const retried = await sys.synthesize({ text: '回退测试', voice: 'MissingVoice' });
        assert.equal(retried.voice, 'Tingting');
    }
});

test('voice engine honors DSH SenseVoice standby/downloading phases, multi-turn assistant source, memory isolation, splitter & TTS limits', async () => {
    // 1. SenseVoice standby & downloading phases + downloadSource option
    let phase = 'standby';
    let prepareOpts = null;
    const stt = {
        snapshot: () => ({
            selection: { providerId: 'sensevoice-local' },
            providers: [{
                id: 'sensevoice-local',
                languages: ['auto', 'zh'],
                preparation: phase === 'downloading'
                    ? { phase: 'downloading', completedBytes: 50, totalBytes: 100 }
                    : { phase },
            }],
        }),
        prepare(_id, opts) { prepareOpts = opts; },
        resolve: req => ({ provider: { id: 'sensevoice-local' }, audio: req.audio, language: req.language }),
        async transcribe() { return { text: '待机唤醒成功', language: 'zh' }; },
    };
    const capturedScopes = [];
    let capturedMessages = null;
    const llm = {
        async prepareCall(cfg) {
            return {
                config: cfg,
                async *stream(args) {
                    capturedMessages = args.messages;
                    yield { type: 'text-delta', text: '好的。我已经完成核查，一切正常。' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };
    const memory = {
        async recallFor(scopes) {
            capturedScopes.push(scopes);
            return [];
        },
    };
    const engine = createVoiceEngine({
        getSpeechToText: () => stt,
        llm,
        readDefaultModel: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
        memory,
    });

    assert.equal(engine.capabilities().stt.ready, true, 'standby phase counts as ready');
    assert.equal(engine.capabilities().stt.preparing, false);
    const sttOk = await engine.transcribe({ audioBase64: makeWav().toString('base64') });
    assert.equal(sttOk.text, '待机唤醒成功');

    engine.prepareStt({ source: 'modelscope' });
    assert.deepEqual(prepareOpts, { downloadSource: 'modelscope' });

    phase = 'downloading';
    const dlCaps = engine.capabilities().stt;
    assert.equal(dlCaps.ready, false);
    assert.equal(dlCaps.preparing, true);
    assert.equal(dlCaps.progress, 0.5);
    await assert.rejects(() => engine.transcribe({ audioBase64: makeWav().toString('base64') }), { code: 'stt-not-ready' });

    // 2. Multi-turn assistant source + owner-gated global memory
    for await (const _ev of engine.streamVoiceTurn({
        agent: { name: '丞相', agentId: 'a1', workspaceId: 'ws1' },
        member: { name: '丞相' },
        text: '第二轮测试',
        history: [{ role: 'user', text: '第一轮' }, { role: 'assistant', text: '收到。' }],
        allowGlobalMemory: false,
    })) { /* drain */ }
    assert.equal(capturedScopes[0].some(s => s.scope === 'global'), false, 'non-owner must not read global memory');
    assert.equal(capturedMessages[1].role, 'assistant');
    assert.deepEqual(capturedMessages[1].source, { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.ok(capturedMessages[1].id);

    for await (const _ev of engine.streamVoiceTurn({
        agent: { name: '丞相', agentId: 'a1', workspaceId: 'ws1' },
        member: { name: '丞相' },
        text: '机主测试',
        allowGlobalMemory: true,
    })) { /* drain */ }
    assert.equal(capturedScopes[1].some(s => s.scope === 'global'), true, 'owner may read global memory');

    // 3. Sentence splitter short-opener fix & pure punctuation filtering
    const splitter = createSentenceSplitter({ minChars: 6, maxChars: 140 });
    assert.deepEqual(splitter.push('好的。'), []);
    assert.deepEqual(splitter.push('我现在立刻核查移动端工单。'), ['好的。我现在立刻核查移动端工单。']);
    assert.deepEqual(splitter.push('……！？'), []);
    assert.deepEqual(splitter.flush(), []);

    // 4. WAV strict PCM16 + non-empty check
    assert.equal(validateWavBuffer(makeWav(0)).code, 'invalid-audio');
    const floatWav = makeWav(20);
    floatWav.writeUInt16LE(3, 20); // IEEE float instead of PCM16
    assert.equal(validateWavBuffer(floatWav).code, 'invalid-audio');

    // 5. T2 CLI flag injection protection & piper stdin
    const sherpaCalls = [];
    const sherpaLocal = createLocalNeuralTtsProvider({
        modelDir: tmpdir(),
        detect: () => ({ kind: 'sherpa-onnx', bin: '/usr/local/bin/sherpa-onnx-offline-tts', model: '/m/v.onnx', tokens: '/m/tokens.txt', models: ['/m/v.onnx'] }),
        async execFileImpl(_bin, args) {
            sherpaCalls.push(args);
            const outArg = args.find(a => a.startsWith('--output-filename=')).split('=')[1];
            writeFileSync(outArg, makeWav(8));
        },
    });
    const t2Res = await sherpaLocal.synthesize({ text: '- --vits-dict-dir=/tmp/evil', voice: 'x'.repeat(200) });
    assert.equal(sherpaCalls[0].at(-1).startsWith('-'), false);
    assert.ok(t2Res.voice.length <= 64);

    const piperCalls = [];
    const piperLocal = createLocalNeuralTtsProvider({
        modelDir: tmpdir(),
        detect: () => ({ kind: 'piper', bin: '/usr/local/bin/piper', model: '/m/v.onnx', models: ['/m/v.onnx'] }),
        async execFileImpl(_bin, args, opts) {
            piperCalls.push({ args, opts });
            const outIdx = args.indexOf('--output_file');
            writeFileSync(args[outIdx + 1], makeWav(8));
        },
    });
    await piperLocal.synthesize({ text: '测试 piper 标准输入' });
    assert.equal(piperCalls[0].args.includes('--text'), false);
    assert.equal(piperCalls[0].opts.input, '测试 piper 标准输入');

    // 6. TTS concurrency limiter caps simultaneous synthesis
    let inflight = 0;
    let peak = 0;
    const slowProvider = {
        id: 'slow',
        status: () => ({ id: 'slow', ready: true }),
        listVoices: () => [],
        async synthesize({ text }) {
            inflight += 1;
            peak = Math.max(peak, inflight);
            await new Promise(r => setTimeout(r, 15));
            inflight -= 1;
            return { mime: 'audio/wav', audio: Buffer.from(text), provider: 'slow', voice: 'v' };
        },
    };
    const reg = createTtsRegistry({ extraProviders: [slowProvider], maxConcurrentTts: 2 });
    await Promise.all(['一', '二', '三', '四', '五'].map(t => reg.synthesize({ provider: 'slow', text: t })));
    assert.equal(peak, 2);

    // 7. Edge TTS rejects premature close without turn.end and retries on 403 clock skew
    let attempts = 0;
    class TruncatedWs extends EventEmitter {
        constructor() {
            super();
            this.readyState = 1;
            queueMicrotask(() => {
                this.emit('open');
                this.emit('message', Buffer.concat([Buffer.from('Path:audio\r\n'), Buffer.from('PARTIAL')]), true);
                this.emit('close');
            });
        }
        send() {}
        close() {}
        terminate() {}
    }
    await assert.rejects(() => synthesizeEdgeTts({ text: '截断测试', WebSocketImpl: TruncatedWs }), { code: 'closed' });

    class SkewRetryWs extends EventEmitter {
        constructor() {
            super();
            this.readyState = 1;
            attempts += 1;
            const current = attempts;
            queueMicrotask(() => {
                if (current === 1) {
                    this.emit('unexpected-response', {}, { statusCode: 403, headers: { date: new Date().toUTCString() }, resume() {} });
                    return;
                }
                this.emit('open');
                this.emit('message', Buffer.concat([Buffer.from('Path:audio\r\n'), Buffer.from('FULLMP3')]), true);
                this.emit('message', 'Path:turn.end\r\n', false);
            });
        }
        send() {}
        close() {}
        terminate() {}
    }
    const skewOk = await synthesizeEdgeTts({ text: '时钟纠偏测试', WebSocketImpl: SkewRetryWs });
    assert.equal(attempts, 2);
    assert.equal(skewOk.audio.toString(), 'FULLMP3');
});
