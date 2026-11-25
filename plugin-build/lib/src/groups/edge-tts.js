/**
 * @module marshal/groups/edge-tts
 *
 * Pure Node client for Microsoft Edge neural TTS (Sec-MS-GEC v2 / CS64-SHA256).
 * Keeps zero external binary requirements by reusing marshal's bundled `ws`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const EDGE_BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SEC = 11644473600n;
const TICKS_PER_SEC = 10000000n;

const VOICE_NAME_RE = /^[a-z]{2,3}-[A-Z]{2,4}(?:-[a-z]{2,16})?-[A-Za-z0-9]+Neural$/;
const RATE_RE = /^[+-]?\d{1,3}%$/;
const AUDIO_SEPARATOR = Buffer.from('Path:audio\r\n');
const MAX_EDGE_AUDIO_BYTES = 8 * 1024 * 1024;

export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
export const EDGE_ZH_VOICES = Object.freeze([
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温暖自然·女）', lang: 'zh-CN', gender: 'female' },
    { id: 'zh-CN-YunxiNeural', label: '云希（清朗年轻·男）', lang: 'zh-CN', gender: 'male' },
    { id: 'zh-CN-YunjianNeural', label: '云健（沉稳大气·男）', lang: 'zh-CN', gender: 'male' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊（轻快灵动·女）', lang: 'zh-CN', gender: 'female' },
    { id: 'zh-CN-YunyangNeural', label: '云扬（专业播音·男）', lang: 'zh-CN', gender: 'male' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北亲切·女）', lang: 'zh-CN', gender: 'female' },
]);

// --- Sec-MS-GEC v2 (CS64 + modified SHA-256) ---
const SHA256_INITIAL = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA256_STATE = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
    0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA256_SCHEDULE = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
    0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
    0xD258B060, 0x72766564,
];
const SHA256_K = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJ = 0xC9DC06A7;
const SHA256_BLOCK_K = [...SHA256_K.slice(0, 14), SHA256_ADJ, ...SHA256_K.slice(15)];
const SHA256_SIGMA0_ADJ = 0x059C0B80;
const SHA256_SIGMA1_ADJ = 0x000B92C0;

const CS64_COEFFS = [
    [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
    [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
    [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
    [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xF2F90B1A;
const CS64_ADJ1 = 0x0B1A0000;

const u32 = v => v >>> 0;
const rotr = (v, n) => ((v >>> n) | (v << (32 - n))) >>> 0;
const rol16 = v => ((v << 16) | (v >>> 16)) >>> 0;
const mul32 = (a, b) => Math.imul(a, b) >>> 0;
const sigma0 = v => (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
const sigma1 = v => (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;
const bigSigma0 = v => (rotr(v, 2) ^ rotr(v, 13) ^ rotr(v, 22)) >>> 0;
const bigSigma1 = v => (rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25)) >>> 0;

function expandSchedule(words, firstWord = 16) {
    for (let i = firstWord; i < 64; i++) {
        words[i] = u32(sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]);
    }
}

function sha256Rounds(state, words, firstRound = 0) {
    let [a, b, c, d, e, f, g, h] = state;
    const K = firstRound === 14 ? SHA256_BLOCK_K : SHA256_K;
    for (let i = firstRound; i < 64; i++) {
        const ch = (g ^ (e & (f ^ g))) >>> 0;
        const maj = ((a & b) | (c & (a | b))) >>> 0;
        const t1 = u32(h + bigSigma1(e) + ch + K[i] + words[i]);
        const t2 = u32(bigSigma0(a) + maj);
        h = g; g = f; f = e; e = u32(d + t1);
        d = c; c = b; b = a; a = u32(t1 + t2);
    }
    return [a, b, c, d, e, f, g, h];
}

function sha256Init(prefix7) {
    const words = new Array(64).fill(0);
    words[14] = ((prefix7[0] << 16) | (prefix7[1] << 8) | prefix7[2]) >>> 0;
    words[15] = prefix7.readUInt32BE(3);
    for (let i = 16; i < 30; i++) {
        let val = SHA256_SCHEDULE[i - 16];
        if (i - 2 >= 14) val = u32(val + (i === 16 ? (sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJ) >>> 0 : sigma1(words[i - 2])));
        if (i - 7 >= 14) val = u32(val + words[i - 7]);
        if (i - 15 >= 14) val = u32(val + (i === 29 ? (sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJ) >>> 0 : sigma0(words[i - 15])));
        words[i] = val;
    }
    words[30] = u32(sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJ - SHA256_K[14]);
    expandSchedule(words, 31);
    const working = sha256Rounds(SHA256_STATE, words, 14);
    return SHA256_INITIAL.map((x, i) => u32(x + working[i]));
}

function sha256TokenDigest(data) {
    const totalLen = 57 + data.length;
    const rem = data.subarray(7);
    const padZeros = ((55 - totalLen) % 64 + 64) % 64;
    const padded = Buffer.alloc(rem.length + 1 + padZeros + 8);
    rem.copy(padded, 0);
    padded[rem.length] = 0x80;
    padded.writeBigUInt64BE(BigInt(totalLen) * 8n, padded.length - 8);
    let state = sha256Init(data.subarray(0, 7));
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words = new Array(64);
        for (let i = 0; i < 16; i++) words[i] = padded.readUInt32BE(offset + i * 4);
        expandSchedule(words, 16);
        const working = sha256Rounds(state, words, 0);
        state = state.map((x, i) => u32(x + working[i]));
    }
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) out.writeUInt32BE(state[i], i * 4);
    return out;
}

function wordsLe4Even(buf) {
    const pad = (-buf.length % 4 + 4) % 4;
    const padded = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
    const words = [];
    for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
    if (words.length % 2 === 1) words.push(0);
    return words;
}

function cs64Digest(data, digest) {
    const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
    const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
    const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];
    const terms = CS64_COEFFS.map(([coeff], i) => mul32(coeff, factors[i % 2]));
    const offsets = CS64_COEFFS.map(([, off]) => off);
    const input = Buffer.concat([Buffer.from([0]), data]);
    const words = wordsLe4Even(input);
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        let term = mul32(w, i % 2 === 0 ? keyA : keyB);
        let off = mul32(rol16(w), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
        if (i === 0) {
            term = u32(term + mul32(CS64_ADJ0, factors[0]));
            off = u32(off + CS64_ADJ1);
        }
        terms.push(term);
        offsets.push(off);
    }
    let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
    for (let i = 0; i < terms.length; i += 2) {
        const x = terms[i], y = terms[i + 1];
        let t = rol16(u32(offsets[i] + x));
        let q = mul32(t, 0x76F50F34);
        swapAcc = u32(swapAcc + u32(mul32(rol16(q), 0xC3EFEA97) + q));
        t = rol16(u32(offsets[i + 1] + y));
        q = mul32(t, 0x1881CE3C);
        swapLast = u32(mul32(rol16(q), 0x35BD1EC9) + q);
        swapAcc = u32(swapAcc + swapLast);

        state = u32(mul32(state, keyA) + x);
        state = mul32(rol16(state), 0xCF98B111);
        state = mul32(rol16(state), 0x87085B9F);
        state = mul32(rol16(state), 0x12CEB96D);
        state = mul32(rol16(state), 0x257E1D83);
        acc = u32(acc + state);
        t = u32(mul32(state, keyB) + y);
        t = mul32(rol16(t), 0xA27416F5);
        t = mul32(rol16(t), 0xD38396FF);
        state = mul32(rol16(mul32(rol16(t), 0x7C932B89)), 0xBFA49F69);
        acc = u32(acc + state);
    }
    const out = Buffer.alloc(8);
    out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
    out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
    return out.toString('hex').toUpperCase();
}

let clockSkewSeconds = 0;

export function generateSecMsGecV2(unixSeconds = Date.now() / 1000 + clockSkewSeconds) {
    let ticks = BigInt(Math.floor(unixSeconds)) + WIN_EPOCH_SEC;
    ticks -= ticks % 300n;
    const payload = Buffer.from((ticks * TICKS_PER_SEC).toString() + TRUSTED_CLIENT_TOKEN, 'ascii');
    const digest = sha256TokenDigest(payload);
    const cs64 = cs64Digest(payload, digest);
    return `${cs64}-${digest.toString('hex').toUpperCase()}`;
}

export function escapeSsml(text) {
    return String(text ?? '')
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .trim();
}

export function normalizeEdgeVoice(voice) {
    const value = typeof voice === 'string' ? voice.trim() : '';
    return VOICE_NAME_RE.test(value) ? value : EDGE_DEFAULT_VOICE;
}

export function normalizeEdgeRate(rate) {
    if (typeof rate === 'number' && Number.isFinite(rate)) {
        const pct = Math.max(-50, Math.min(100, Math.round((rate - 1) * 100)));
        return (pct >= 0 ? '+' : '') + pct + '%';
    }
    const value = typeof rate === 'string' ? rate.trim() : '';
    if (RATE_RE.test(value)) {
        const n = Math.max(-50, Math.min(100, Number.parseInt(value, 10)));
        return (n >= 0 ? '+' : '') + n + '%';
    }
    return '+0%';
}

function synthesizeOnce({ text, voice, rate, signal, timeoutMs, WebSocketImpl }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(Object.assign(new Error('edge-tts-aborted'), { code: 'aborted' }));
            return;
        }
        const connId = randomUUID().replace(/-/g, '');
        const gec = generateSecMsGecV2();
        const muid = randomBytes(16).toString('hex').toUpperCase();
        const url = `wss://${EDGE_BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;
        const ws = new WebSocketImpl(url, {
            headers: {
                Pragma: 'no-cache',
                'Cache-Control': 'no-cache',
                Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                Cookie: `muid=${muid};`,
                'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            handshakeTimeout: Math.min(timeoutMs, 8000),
        });
        const chunks = [];
        let totalBytes = 0;
        let settled = false;
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            try {
                if (err || ws.readyState !== 1) ws.terminate?.();
                else ws.close();
            } catch { /* ignore */ }
            if (err) reject(err);
            else resolve(value);
        };
        const onAbort = () => finish(Object.assign(new Error('edge-tts-aborted'), { code: 'aborted' }));
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
            finish(Object.assign(new Error('edge-tts-timeout'), { code: 'timeout' }));
        }, timeoutMs);
        timer.unref?.();

        ws.on('unexpected-response', (_req, res) => {
            const status = res?.statusCode ?? 0;
            const dateHeader = res?.headers?.date;
            try { res?.resume?.(); } catch { /* ignore */ }
            finish(Object.assign(new Error(`edge-tts-http-${status}`), {
                code: status === 403 ? 'edge-403' : 'edge-http-error',
                status,
                serverDate: typeof dateHeader === 'string' ? dateHeader : undefined,
            }));
        });
        ws.on('open', () => {
            if (settled) return;
            const stamp = new Date().toUTCString();
            const requestId = randomUUID().replace(/-/g, '');
            const lang = voice.split('-').slice(0, 2).join('-') || 'zh-CN';
            const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeSsml(text)}</prosody></voice></speak>`;
            try {
                ws.send(
                    `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
                    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
                );
                ws.send(
                    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
                );
            } catch (err) {
                finish(Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 'edge-send-failed' }));
            }
        });
        ws.on('message', (data, isBinary) => {
            if (settled) return;
            if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const idx = buf.indexOf(AUDIO_SEPARATOR);
                if (idx >= 0) {
                    const part = buf.subarray(idx + AUDIO_SEPARATOR.length);
                    totalBytes += part.length;
                    if (totalBytes > MAX_EDGE_AUDIO_BYTES) {
                        finish(Object.assign(new Error('edge-tts-audio-too-large'), { code: 'audio-too-large' }));
                        return;
                    }
                    chunks.push(part);
                }
                return;
            }
            const msg = String(data);
            if (msg.includes('Path:turn.end')) {
                const audio = Buffer.concat(chunks);
                if (audio.length === 0) {
                    finish(Object.assign(new Error('edge-tts-empty'), { code: 'empty-audio' }));
                } else {
                    finish(null, { mime: 'audio/mpeg', audio, provider: 'edge', voice });
                }
            }
        });
        ws.on('error', err => finish(Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 'edge-network' })));
        ws.on('close', () => {
            if (!settled) {
                finish(Object.assign(new Error('edge-tts-closed'), { code: 'closed' }));
            }
        });
    });
}

export async function synthesizeEdgeTts({ text, voice, rate, signal, timeoutMs = 10_000, WebSocketImpl = WebSocket }) {
    const clean = escapeSsml(text);
    if (!clean) throw Object.assign(new Error('empty-text'), { code: 'invalid-text' });
    const resolvedVoice = normalizeEdgeVoice(voice);
    const resolvedRate = normalizeEdgeRate(rate);
    const startedAt = Date.now();
    try {
        return await synthesizeOnce({ text, voice: resolvedVoice, rate: resolvedRate, signal, timeoutMs, WebSocketImpl });
    } catch (error) {
        if (error?.code === 'edge-403' && error.serverDate && !signal?.aborted) {
            const parsed = Date.parse(error.serverDate);
            if (Number.isFinite(parsed)) {
                clockSkewSeconds = parsed / 1000 - Date.now() / 1000;
                const remainingMs = Math.max(2_000, timeoutMs - (Date.now() - startedAt));
                return await synthesizeOnce({ text, voice: resolvedVoice, rate: resolvedRate, signal, timeoutMs: remainingMs, WebSocketImpl });
            }
        }
        throw error;
    }
}
