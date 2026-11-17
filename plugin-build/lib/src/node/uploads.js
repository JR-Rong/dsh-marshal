import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PreCallRejection } from "../adapters/types.js";
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const UploadSchema = z.object({
    id: z.string().uuid(), name: z.string().min(1).max(200), mime: z.string().max(100),
    size: z.number().int().min(0).max(UPLOAD_LIMIT), offset: z.number().int().min(0).max(UPLOAD_LIMIT),
    data: z.string().max(350000), sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
/** Session/operator/epoch-bound receipts. Bytes never enter command journals. */
export class UploadStore {
    clock;
    entries = new Map();
    directory;
    constructor(clock = Date.now) {
        this.clock = clock;
    }
    put(scope, input) {
        const at = this.clock();
        for (const [id, entry] of this.entries)
            if (at - entry.at > 60 * 60_000)
                this.entries.delete(id);
        const data = Buffer.from(input.data, 'base64');
        if ((data.length === 0 && input.size !== 0) || data.toString('base64') !== input.data || input.offset + data.length > input.size)
            throw new PreCallRejection('invalid-args');
        let entry = this.entries.get(input.id);
        if (!entry) {
            const total = [...this.entries.values()].reduce((sum, item) => sum + item.size, 0);
            if (input.offset !== 0 || this.entries.size >= 100 || total + input.size > 64 * 1024 * 1024)
                throw new PreCallRejection('size-limit');
            if (/[\x00-\x1f\x7f/\\]/.test(input.name) || input.name === '.' || input.name === '..')
                throw new PreCallRejection('invalid-args');
            entry = { scope, name: input.name, mime: input.mime, size: input.size, digest: input.sha256, bytes: 0, chunks: [], at };
            this.entries.set(input.id, entry);
        }
        if (entry.scope !== scope || entry.name !== input.name || entry.mime !== input.mime || entry.size !== input.size || entry.digest !== input.sha256)
            throw new PreCallRejection('conflict');
        if (entry.bytes !== input.offset || entry.file)
            throw new PreCallRejection('conflict');
        entry.chunks.push(data);
        entry.bytes += data.length;
        entry.at = at;
        if (entry.bytes === entry.size) {
            const content = Buffer.concat(entry.chunks);
            if (createHash('sha256').update(content).digest('hex') !== entry.digest) {
                this.entries.delete(input.id);
                throw new PreCallRejection('invalid-args');
            }
            this.directory ??= mkdtempSync(join(tmpdir(), 'dsh-marshal-uploads-'));
            const folder = join(this.directory, randomUUID());
            mkdirSync(folder, { mode: 0o700 });
            let diskName = entry.name;
            while (Buffer.byteLength(diskName) > 240)
                diskName = Array.from(diskName).slice(0, -1).join('');
            const path = join(folder, diskName);
            writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
            // Only native vision formats get image handling; other files are path attachments.
            const mime = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(entry.mime) ? entry.mime : 'application/octet-stream';
            entry.file = { path, name: entry.name, mime };
            entry.chunks = [];
        }
        return { attachmentId: input.id, bytes: entry.bytes, complete: !!entry.file };
    }
    resolve(scope, ids) {
        return ids.map(id => {
            const entry = this.entries.get(id);
            if (!entry?.file || entry.scope !== scope || this.clock() - entry.at > 60 * 60_000)
                throw new PreCallRejection('invalid-args', 'attachment expired');
            return entry.file;
        });
    }
}
