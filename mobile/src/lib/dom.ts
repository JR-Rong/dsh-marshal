/** 极简 DOM 构建器：避免手写 innerHTML，所有数据都走 textContent。 */

export type Child = Node | string | number | null | undefined | false

export interface ElProps {
  class?: string
  text?: string
  title?: string
  id?: string
  type?: string
  value?: string
  placeholder?: string
  inputmode?: string
  autocomplete?: string
  maxlength?: number | string
  disabled?: boolean
  hidden?: boolean
  href?: string
  target?: string
  rel?: string
  role?: string
  'aria-label'?: string
  onClick?: (event: MouseEvent) => void
  onInput?: (event: Event) => void
  onChange?: (event: Event) => void
  onSubmit?: (event: Event) => void
  [key: string]: unknown
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag) as HTMLElementTagNameMap[K]
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'onClick') node.addEventListener('click', value as EventListener)
    else if (key === 'onInput') node.addEventListener('input', value as EventListener)
    else if (key === 'onChange') node.addEventListener('change', value as EventListener)
    else if (key === 'onSubmit') node.addEventListener('submit', value as EventListener)
    else if (key === 'value') (node as unknown as { value: string }).value = String(value)
    else if (key === 'disabled') (node as unknown as { disabled: boolean }).disabled = Boolean(value)
    else if (key === 'hidden') (node as unknown as { hidden: boolean }).hidden = Boolean(value)
    else node.setAttribute(key, String(value))
  }
  append(node, children)
  return node
}

export function append(node: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'number' ? String(child) : child)
  }
}

export function clear(node: Element): void {
  node.replaceChildren()
}

export function button(label: string, onClick: () => void, props: ElProps = {}): HTMLButtonElement {
  return el('button', { ...props, text: label, onClick: () => onClick() })
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

/** 轻提示：同一时刻只保留一条，自动消失。 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  document.querySelectorAll('.toast').forEach((node) => node.remove())
  const node = el('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text: message, role: 'status' })
  document.body.append(node)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.remove(), 2600)
}

export function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const now = Date.now()
  const diff = now - timestamp
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff >= 0 && diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}