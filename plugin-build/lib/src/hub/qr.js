/**
 * 字节模式、纠错级别 L 的二维码。只覆盖配对链接需要的版本 1–6。
 * 矩阵和 segno/qrcode 的同参数结果对齐，见 tests/qr.spec.ts。
 */
const ECC_L = [
    { data: 19, ecc: 7, blocks: 1 },
    { data: 34, ecc: 10, blocks: 1 },
    { data: 55, ecc: 15, blocks: 1 },
    { data: 80, ecc: 20, blocks: 1 },
    { data: 108, ecc: 26, blocks: 1 },
    { data: 136, ecc: 18, blocks: 2 },
];
const ALIGN = [null, [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
function gfExp() {
    const exp = new Array(512);
    const log = new Array(256);
    let value = 1;
    for (let i = 0; i < 255; i += 1) {
        exp[i] = value;
        log[value] = i;
        value <<= 1;
        if (value & 0x100)
            value ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1)
        exp[i] = exp[i - 255];
    return { exp, log };
}
const FIELD = gfExp();
function mul(a, b) {
    if (a === 0 || b === 0)
        return 0;
    return FIELD.exp[(FIELD.log[a] + FIELD.log[b]) % 255];
}
function generator(length) {
    let poly = [1];
    for (let i = 0; i < length; i += 1) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j += 1) {
            next[j] = (next[j] ^ poly[j]) & 255;
            next[j + 1] = (next[j + 1] ^ mul(poly[j], FIELD.exp[i])) & 255;
        }
        poly = next;
    }
    return poly;
}
function remainder(data, ecc) {
    const gen = generator(ecc);
    const buffer = data.concat(new Array(ecc).fill(0));
    for (let i = 0; i < data.length; i += 1) {
        const factor = buffer[i];
        if (factor === 0)
            continue;
        for (let j = 0; j < gen.length; j += 1)
            buffer[i + j] = (buffer[i + j] ^ mul(gen[j], factor)) & 255;
    }
    return buffer.slice(data.length);
}
function bits(bytes) {
    const out = [];
    out.push(0, 1, 0, 0);
    const countBits = bytes.length > 255 ? 16 : 8;
    for (let i = countBits - 1; i >= 0; i -= 1)
        out.push((bytes.length >> i) & 1);
    for (const byte of bytes)
        for (let i = 7; i >= 0; i -= 1)
            out.push((byte >> i) & 1);
    return out;
}
function pack(bitList, capacity) {
    const bits = bitList.slice(0, capacity * 8);
    while (bits.length < capacity * 8 && bits.length < bitList.length + 4)
        bits.push(0);
    while (bits.length % 8 !== 0)
        bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j += 1)
            value = (value << 1) | (bits[i + j] ?? 0);
        bytes.push(value);
    }
    const pads = [0xec, 0x11];
    let pad = 0;
    while (bytes.length < capacity)
        bytes.push(pads[pad++ % 2]);
    return bytes;
}
function chooseVersion(byteLength) {
    for (let version = 1; version <= ECC_L.length; version += 1) {
        const countBits = version <= 9 ? 8 : 16;
        const header = Math.ceil((4 + countBits) / 8);
        if (header + byteLength <= ECC_L[version - 1].data)
            return version;
    }
    throw new Error('marshal: pairing qr payload is too long');
}
function interleave(data, version) {
    const spec = ECC_L[version - 1];
    const blocks = [];
    const eccBlocks = [];
    const short = Math.floor(spec.data / spec.blocks);
    const longCount = spec.data % spec.blocks;
    let offset = 0;
    for (let i = 0; i < spec.blocks; i += 1) {
        const size = short + (i >= spec.blocks - longCount ? 1 : 0);
        const slice = data.slice(offset, offset + size);
        offset += size;
        blocks.push(slice);
        eccBlocks.push(remainder(slice, spec.ecc));
    }
    const out = [];
    const max = Math.max(...blocks.map((block) => block.length));
    for (let i = 0; i < max; i += 1)
        for (const block of blocks)
            if (block[i] !== undefined)
                out.push(block[i]);
    for (let i = 0; i < spec.ecc; i += 1)
        for (const block of eccBlocks)
            out.push(block[i]);
    return out;
}
function moduleCount(version) {
    return 21 + (version - 1) * 4;
}
function inFinder(size, row, col) {
    const zones = [[0, 0], [size - 7, 0], [0, size - 7]];
    return zones.some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7);
}
function finderDark(size, row, col) {
    const zones = [[0, 0], [size - 7, 0], [0, size - 7]];
    for (const [r, c] of zones) {
        if (row < r || row >= r + 7 || col < c || col >= c + 7)
            continue;
        const dr = row - r;
        const dc = col - c;
        return dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
    }
    return false;
}
export function qrMatrix(text) {
    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length);
    const spec = ECC_L[version - 1];
    const data = interleave(pack(bits(bytes), spec.data), version);
    const size = moduleCount(version);
    const dark = Array.from({ length: size }, () => Array(size).fill(null));
    const set = (row, col, value) => {
        if (row < 0 || col < 0 || row >= size || col >= size)
            return;
        dark[row][col] = value;
    };
    for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1)
            if (inFinder(size, row, col))
                set(row, col, finderDark(size, row, col));
    }
    for (let i = 0; i < size; i += 1) {
        if (dark[6][i] === null)
            set(6, i, i % 2 === 0);
        if (dark[i][6] === null)
            set(i, 6, i % 2 === 0);
    }
    const align = ALIGN[version - 1];
    if (align) {
        for (const row of align)
            for (const col of align) {
                if (dark[row][col] !== null)
                    continue;
                for (let dr = -2; dr <= 2; dr += 1)
                    for (let dc = -2; dc <= 2; dc += 1) {
                        const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
                        set(row + dr, col + dc, edge);
                    }
            }
    }
    set(size - 8, 8, true);
    const codewords = data;
    let bitIndex = 0;
    const bitAt = () => {
        if (bitIndex >= codewords.length * 8)
            return 0;
        const value = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        bitIndex += 1;
        return value;
    };
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6)
            col -= 1;
        for (let i = 0; i < size; i += 1) {
            const row = upward ? size - 1 - i : i;
            for (const dc of [0, -1]) {
                if (dark[row][col + dc] !== null)
                    continue;
                set(row, col + dc, bitAt() === 1);
            }
        }
        upward = !upward;
    }
    // 掩码 0：(row + col) % 2 === 0 时翻转数据模块。格式信息随后写入。
    for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
            if (reserved(size, version, row, col))
                continue;
            if ((row + col) % 2 === 0)
                dark[row][col] = !dark[row][col];
        }
    }
    const format = formatBits(0);
    const coords = formatCoords(size);
    format.forEach((bit, index) => {
        const a = coords[index];
        set(a[0], a[1], bit === 1);
    });
    return dark.map((row) => row.map((cell) => cell === true));
}
function reserved(size, version, row, col) {
    if (inFinder(size, row, col))
        return true;
    if (row < 9 && col < 9)
        return true;
    if (row < 9 && col >= size - 8)
        return true;
    if (col < 9 && row >= size - 8)
        return true;
    if (row === 6 || col === 6)
        return true;
    const align = ALIGN[version - 1];
    if (!align)
        return false;
    return align.some((ar) => align.some((ac) => Math.abs(row - ar) <= 2 && Math.abs(col - ac) <= 2 && !(row < 9 && col < 9) && !(row < 9 && col > size - 9) && !(col < 9 && row > size - 9)));
}
function formatBits(mask) {
    let value = (0b01 << 3) | mask;
    let rest = value << 10;
    const gen = 0b10100110111;
    for (let i = 14; i >= 10; i -= 1)
        if ((rest >> i) & 1)
            rest ^= gen << (i - 10);
    value = ((value << 10) | rest) ^ 0b101010000010010;
    const bits = [];
    for (let i = 14; i >= 0; i -= 1)
        bits.push((value >> i) & 1);
    return bits;
}
function formatCoords(size) {
    const coords = [];
    for (let i = 0; i < 8; i += 1)
        coords.push([8, i < 6 ? i : i + 1]);
    for (let i = 0; i < 7; i += 1)
        coords.push([size - 1 - i, 8]);
    for (let i = 0; i < 7; i += 1)
        coords.push([8, size - 1 - i]);
    for (let i = 0; i < 8; i += 1)
        coords.push([i < 6 ? 5 - i : 8 - i, 8]);
    return coords;
}
export function qrSvg(text) {
    const matrix = qrMatrix(text);
    const n = matrix.length;
    const cell = 4;
    const quiet = 4;
    const span = (n + quiet * 2) * cell;
    let rects = '';
    for (let row = 0; row < n; row += 1) {
        for (let col = 0; col < n; col += 1) {
            if (!matrix[row][col])
                continue;
            rects += `<rect x="${(col + quiet) * cell}" y="${(row + quiet) * cell}" width="${cell}" height="${cell}"/>`;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="280" height="280" role="img" aria-label="配对二维码"><rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`;
}
