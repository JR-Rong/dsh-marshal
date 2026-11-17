import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const SALT = 'dsh-marshal-memory-sync-v1';

export function syncKey(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.trim() === '') return undefined;
    return scryptSync(passphrase, SALT, 32);
}

export function encryptRecord(key, record) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(record));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        id: String(record.id),
        updatedAt: Number(record.updatedAt ?? Date.now()),
        revision: Number(record.revision ?? record.updatedAt ?? Date.now()),
        nonce: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}

export function decryptRecord(key, envelope) {
    const iv = Buffer.from(String(envelope.nonce), 'base64');
    const tag = Buffer.from(String(envelope.tag), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertext), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}
