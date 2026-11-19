import { normalizeToken } from './config.ts'

export const SETTINGS_TOKEN_PLACEHOLDER = '已保存，留空则保持不变'

/**
 * 设置页的令牌框永远不回填已保存的值。
 * 地址没变且用户留空时，沿用本机已保存的令牌；更换 Hub 必须重新输入。
 */
export function resolveSettingsToken(input: {
  typed: string
  saved: string
  previousHub: string
  nextHub: string
}): { ok: true; token: string } | { ok: false; error: string } {
  const typed = input.typed.trim()
  const hubChanged = input.nextHub !== input.previousHub
  if (typed) {
    const normalized = normalizeToken(typed)
    if (!normalized.ok) return normalized
    if (!normalized.value) return { ok: false, error: '请填写管理令牌' }
    return { ok: true, token: normalized.value }
  }
  if (hubChanged) return { ok: false, error: '更换 Hub 后需要重新填写令牌' }
  if (!input.saved) return { ok: false, error: '请填写管理令牌' }
  return { ok: true, token: input.saved }
}
