import { normalizeHubUrl } from './config.ts'

export type DeepLinkDecision =
  | { action: 'ignore' }
  | { action: 'invalid'; error: string }
  | { action: 'prefill'; hubUrl: string }
  | { action: 'confirm'; hubUrl: string }
  | { action: 'same' }

/** 锁屏时整条忽略。已配置的 Hub 被换成别的地址时，必须先让用户确认。 */
export function decideDeepLink(input: {
  url: string
  locked: boolean
  configuredHub: string | null
}): DeepLinkDecision {
  if (input.locked) return { action: 'ignore' }
  let hub: string | null = null
  try {
    const parsed = new URL(input.url)
    if (parsed.protocol === 'marshal:' && parsed.hostname === 'pair') return { action: 'ignore' }
    hub = parsed.searchParams.get('hub')
  } catch {
    return { action: 'ignore' }
  }
  if (!hub) return { action: 'ignore' }
  const normalized = normalizeHubUrl(hub)
  if (!normalized.ok) return { action: 'invalid', error: normalized.error }
  if (!input.configuredHub) return { action: 'prefill', hubUrl: normalized.value }
  if (input.configuredHub === normalized.value) return { action: 'same' }
  return { action: 'confirm', hubUrl: normalized.value }
}

/** 电脑上的配对二维码内容：marshal://pair?code=...&hub=... */
export function parsePairingLink(url: string): { code: string; hubUrl: string | null } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'marshal:' || parsed.hostname !== 'pair') return null
    const code = parsed.searchParams.get('code')?.trim() ?? ''
    if (!code || code.length > 128) return null
    const hub = parsed.searchParams.get('hub')
    if (!hub) return { code, hubUrl: null }
    const normalized = normalizeHubUrl(hub)
    if (!normalized.ok) return null
    return { code, hubUrl: normalized.value }
  } catch {
    return null
  }
}
