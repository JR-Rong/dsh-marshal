import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Old deployments derived one key from this fixed salt. New sync uses a per-owner salt. */
export const LEGACY_SALT = 'dsh-marshal-memory-sync-v1';
export const MIN_PASSPHRASE_LENGTH = 12;

export function passphraseAcceptable(passphrase) {
    if (typeof passphrase !== 'string') return false;
    const value = passphrase.normalize('NFKC');
    if (value.length < MIN_PASSPHRASE_LENGTH || value.length > 512) return false;
    if (/^(.)\1+$/u.test(value)) return false;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter(pattern => pattern.test(value)).length;
    if (value.length >= 20) return classes >= 2;
    return classes >= 3;
}

export function freshSalt() {
    return randomBytes(16).toString('base64url');
}

/** Empty or weak passphrases do not produce a key. */
export function syncKey(passphrase, salt = LEGACY_SALT) {
    if (!passphraseAcceptable(passphrase)) return undefined;
    const material = typeof salt === 'string' && salt.length >= 8 ? salt : undefined;
    if (material === undefined) return undefined;
    return scryptSync(passphrase.normalize('NFKC'), material, 32);
}

export function encryptRecord(key, record, kdf = 'scrypt') {
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
        kdf,
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
