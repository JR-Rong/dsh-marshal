/**
 * UI accent themes. Only the accent palette changes; surfaces stay the same
 * dark neutral so contrast does not depend on the choice.
 */
export type ThemeId = 'blue' | 'purple' | 'gray'

export interface ThemeOption {
  id: ThemeId
  label: string
  swatch: string
}

export const THEMES: readonly ThemeOption[] = [
  { id: 'blue', label: 'DeepSeek 蓝', swatch: '#4d6bfe' },
  { id: 'purple', label: 'Codex 紫', swatch: '#8b5cf6' },
  { id: 'gray', label: '灰', swatch: '#c9d1d9' },
]

const KEY = 'dsh-marshal-theme'
const FALLBACK: ThemeId = 'blue'

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'blue' || value === 'purple' || value === 'gray'
}

export function readTheme(): ThemeId {
  try {
    const value = window.localStorage.getItem(KEY)
    return isThemeId(value) ? value : FALLBACK
  } catch {
    return FALLBACK
  }
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id
}

export function setTheme(id: ThemeId): void {
  try { window.localStorage.setItem(KEY, id) } catch { /* 存不下也先应用 */ }
  applyTheme(id)
}

export function initTheme(): void {
  applyTheme(readTheme())
}
