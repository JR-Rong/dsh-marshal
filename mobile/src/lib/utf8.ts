/**
 * 按字节增量解码 UTF-8。
 * iOS 插件若把半个汉字整块丢掉，多字节字符会消失；这里的规则与 Swift 侧一致。
 */
export function createUtf8Decoder(): { push(bytes: Uint8Array): string } {
  let pending = new Uint8Array(0)
  return {
    push(bytes: Uint8Array): string {
      const combined = new Uint8Array(pending.length + bytes.length)
      combined.set(pending, 0)
      combined.set(bytes, pending.length)
      const decoded = takeUtf8(combined)
      pending = new Uint8Array(decoded.rest)
      return decoded.text
    },
  }
}

function sequenceLength(lead: number): number {
  if ((lead & 0x80) === 0x00) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 0
}

export function takeUtf8(bytes: Uint8Array): { text: string; rest: Uint8Array } {
  if (bytes.length === 0) return { text: '', rest: new Uint8Array(0) }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return { text: decoder.decode(bytes), rest: new Uint8Array(0) }
  } catch {
    /* 末尾可能是被拆开的多字节字符 */
  }
  let index = bytes.length - 1
  let continuations = 0
  while (index >= 0 && continuations < 3 && (bytes[index]! & 0xc0) === 0x80) {
    continuations += 1
    index -= 1
  }
  if (index >= 0) {
    const need = sequenceLength(bytes[index]!)
    const have = bytes.length - index
    if (need > 1 && have < need) {
      const prefix = bytes.slice(0, index)
      const rest = bytes.slice(index)
      if (prefix.length === 0) return { text: '', rest }
      try {
        return { text: decoder.decode(prefix), rest }
      } catch {
        return { text: new TextDecoder('utf-8', { fatal: false }).decode(prefix), rest }
      }
    }
  }
  const skipped = takeUtf8(bytes.slice(1))
  return skipped
}
