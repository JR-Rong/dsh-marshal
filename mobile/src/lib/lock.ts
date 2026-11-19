/** 应用锁：PBKDF2-SHA256 派生，只保存盐和摘要，不保存 PIN 明文。 */

export const LOCK_ITERATIONS = 210_000
const DIGEST_BITS = 256

export interface LockRecord {
  salt: string
  hash: string
  iterations: number
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function subtle(): SubtleCrypto {
  const api = (globalThis as { crypto?: Crypto }).crypto
  if (!api?.subtle) throw new Error('当前环境不支持 WebCrypto，无法启用应用锁')
  return api.subtle
}

export async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    DIGEST_BITS,
  )
  return new Uint8Array(bits)
}

/** 生成新锁记录；salt 每次随机。 */
export async function createLock(pin: string, iterations = LOCK_ITERATIONS): Promise<LockRecord> {
  if (!isValidPin(pin)) throw new Error('PIN 需要 4 到 8 位数字')
  const salt = new Uint8Array(16)
  ;(globalThis as { crypto: Crypto }).crypto.getRandomValues(salt)
  const digest = await derive(pin, salt, iterations)
  return { salt: toBase64(salt), hash: toBase64(digest), iterations }
}

/** 常数时间比较，避免按位提前返回。 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index]
  return diff === 0
}

export async function verifyPin(pin: string, record: LockRecord): Promise<boolean> {
  if (!isValidPin(pin)) return false
  try {
    const digest = await derive(pin, fromBase64(record.salt), record.iterations)
    return equalBytes(digest, fromBase64(record.hash))
  } catch {
    return false
  }
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin)
}

export const PIN_MAX_ATTEMPTS = 5

/** 第 1 次错等 1 秒，之后翻倍，第 5 次起至少 60 秒。 */
export function pinDelay(failures: number): number {
  if (failures <= 0) return 0
  const stepped = Math.min(60_000, 1_000 * 2 ** (failures - 1))
  return failures >= PIN_MAX_ATTEMPTS ? Math.max(60_000, stepped) : stepped
}
