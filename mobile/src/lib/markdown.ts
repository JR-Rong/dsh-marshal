export type MarkdownLinkKind =
  | { kind: 'external'; href: string }
  | { kind: 'file'; label: string }
  | { kind: 'unsafe' }

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'fileRef'; label: string }

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'blockquote'; blocks: MarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: Array<{ checked?: boolean; children: InlineNode[] }> }
  | { type: 'table'; header: InlineNode[][]; align: Array<'left' | 'center' | 'right' | null>; rows: InlineNode[][][] }
  | { type: 'hr' }

export function classifyMarkdownHref(rawHref: string): MarkdownLinkKind {
  const trimmed = rawHref.trim()
  if (/^https?:\/\/[^\s<>]+$/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { kind: 'external', href: parsed.href }
      }
    } catch {
      return { kind: 'unsafe' }
    }
  }
  if (/^file:\/\//i.test(trimmed)) {
    const clean = trimmed.replace(/^file:\/\//i, '').split('#')[0] ?? ''
    const base = clean.split('/').filter(Boolean).pop() ?? trimmed
    try {
      return { kind: 'file', label: decodeURIComponent(base) }
    } catch {
      return { kind: 'file', label: base }
    }
  }
  return { kind: 'unsafe' }
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_]/.test(ch))
}

function findClosingDelimiter(text: string, from: number, marker: string): number {
  let pos = from
  while (pos < text.length) {
    const idx = text.indexOf(marker, pos)
    if (idx === -1) return -1
    if (text[idx - 1] === '\\') {
      pos = idx + 1
      continue
    }
    if (marker === '_' && isWordChar(text[idx + 1])) {
      pos = idx + 1
      continue
    }
    return idx
  }
  return -1
}

function parseLink(text: string, start: number): { end: number; label: string; href: string } | null {
  if (text[start] !== '[') return null
  let depth = 1
  let pos = start + 1
  while (pos < text.length && depth > 0) {
    if (text[pos] === '\\') { pos += 2; continue }
    if (text[pos] === '[') depth++
    else if (text[pos] === ']') depth--
    pos++
  }
  if (depth !== 0 || text[pos] !== '(') return null
  const label = text.slice(start + 1, pos - 1)
  let parenDepth = 1
  let hrefPos = pos + 1
  while (hrefPos < text.length && parenDepth > 0) {
    if (text[hrefPos] === '\\') { hrefPos += 2; continue }
    if (text[hrefPos] === '(') parenDepth++
    else if (text[hrefPos] === ')') parenDepth--
    hrefPos++
  }
  if (parenDepth !== 0) return null
  const rawHref = text.slice(pos + 1, hrefPos - 1).trim()
  const href = rawHref.startsWith('<') && rawHref.endsWith('>') ? rawHref.slice(1, -1) : rawHref.split(/\s+/)[0] ?? ''
  return { end: hrefPos, label, href }
}

export function parseInline(source: string, depth = 0): InlineNode[] {
  if (!source) return []
  const nodes: InlineNode[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]!

    if (ch === '\n') {
      flush()
      nodes.push({ type: 'break' })
      i++
      continue
    }

    if (ch === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(source[i + 1]!)) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    // Inline code (`...` or ``...``)
    if (ch === '`') {
      let ticks = 1
      while (source[i + ticks] === '`') ticks++
      const fence = '`'.repeat(ticks)
      const close = source.indexOf(fence, i + ticks)
      if (close !== -1) {
        flush()
        const raw = source.slice(i + ticks, close)
        const trimmed = raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '' ? raw.slice(1, -1) : raw
        nodes.push({ type: 'code', text: trimmed })
        i = close + ticks
        continue
      }
    }

    // Markdown links [label](href)
    if (ch === '[' && depth < 6) {
      const link = parseLink(source, i)
      if (link && link.label.length > 0 && link.href.length > 0) {
        flush()
        const classified = classifyMarkdownHref(link.href)
        if (classified.kind === 'external') {
          nodes.push({ type: 'link', href: classified.href, children: parseInline(link.label, depth + 1) })
        } else if (classified.kind === 'file') {
          nodes.push({ type: 'fileRef', label: link.label || classified.label })
        } else {
          nodes.push({ type: 'text', text: link.label })
        }
        i = link.end
        continue
      }
    }

    // Bare https:// or http:// URLs
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(source.slice(i))) {
      const match = source.slice(i).match(/^https?:\/\/[^\s<>"'`)\]}，。；！？、]+/i)
      if (match) {
        let rawUrl = match[0]
        while (/[.,;:!?]$/.test(rawUrl)) rawUrl = rawUrl.slice(0, -1)
        const classified = classifyMarkdownHref(rawUrl)
        if (classified.kind === 'external') {
          flush()
          nodes.push({ type: 'link', href: classified.href, children: [{ type: 'text', text: rawUrl }] })
          i += rawUrl.length
          continue
        }
      }
    }

    if (depth < 6) {
      // Bold + Italic (***text***)
      if (source.startsWith('***', i) && source[i + 3] && !/\s/.test(source[i + 3]!)) {
        const close = findClosingDelimiter(source, i + 3, '***')
        if (close > i + 3) {
          flush()
          nodes.push({ type: 'strong', children: [{ type: 'em', children: parseInline(source.slice(i + 3, close), depth + 1) }] })
          i = close + 3
          continue
        }
      }

      // Bold (**text** or __text__)
      if ((source.startsWith('**', i) || (source.startsWith('__', i) && !isWordChar(source[i - 1])))
        && source[i + 2] && !/\s/.test(source[i + 2]!)) {
        const marker = source.slice(i, i + 2)
        const close = findClosingDelimiter(source, i + 2, marker)
        if (close > i + 2 && !(marker === '__' && isWordChar(source[close + 2]))) {
          flush()
          nodes.push({ type: 'strong', children: parseInline(source.slice(i + 2, close), depth + 1) })
          i = close + 2
          continue
        }
      }

      // Strikethrough (~~text~~)
      if (source.startsWith('~~', i) && source[i + 2] && !/\s/.test(source[i + 2]!)) {
        const close = findClosingDelimiter(source, i + 2, '~~')
        if (close > i + 2) {
          flush()
          nodes.push({ type: 'del', children: parseInline(source.slice(i + 2, close), depth + 1) })
          i = close + 2
          continue
        }
      }

      // Italic (*text* or _text_) — protect snake_case words
      if ((ch === '*' || (ch === '_' && !isWordChar(source[i - 1])))
        && source[i + 1] && source[i + 1] !== ch && !/\s/.test(source[i + 1]!)) {
        const close = findClosingDelimiter(source, i + 1, ch)
        if (close > i + 1 && !/\s/.test(source[close - 1]!)) {
          flush()
          nodes.push({ type: 'em', children: parseInline(source.slice(i + 1, close), depth + 1) })
          i = close + 1
          continue
        }
      }
    }

    buffer += ch
    i++
  }
  flush()
  return nodes
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (trimmed[i] === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += trimmed[i]
  }
  cells.push(current.trim())
  return cells
}

function parseTableSeparator(line: string): Array<'left' | 'center' | 'right' | null> | null {
  if (!line.includes('|') && !/^\s*:?-{3,}:?\s*$/.test(line)) return null
  const cells = splitTableRow(line)
  if (cells.length === 0) return null
  const aligns: Array<'left' | 'center' | 'right' | null> = []
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return aligns
}

function isBlockStarter(lines: string[], idx: number): boolean {
  const line = lines[idx] ?? ''
  if (!line.trim()) return true
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true
  if (/^\s*#{1,6}\s+/.test(line)) return true
  if (isHorizontalRule(line)) return true
  if (/^\s*>\s?/.test(line)) return true
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return true
  if (line.includes('|') && idx + 1 < lines.length && parseTableSeparator(lines[idx + 1]!) !== null) return true
  return false
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }

    // Fenced code block (``` or ~~~), also handles unclosed fences during live streaming
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`~]*)/)
    if (fenceMatch) {
      const markerChar = fenceMatch[1]![0]!
      const markerLen = fenceMatch[1]!.length
      const lang = fenceMatch[2] ?? ''
      const closeRe = new RegExp(`^\\s*${markerChar === '`' ? '`' : '~'}{${markerLen},}\\s*$`)
      const codeLines: string[] = []
      i++
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') })
      continue
    }

    // Heading (# .. ######)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ type: 'heading', level, children: parseInline(headingMatch[2]!.trim()) })
      i++
      continue
    }

    // Horizontal rule
    if (isHorizontalRule(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // GFM Table
    if (line.includes('|') && i + 1 < lines.length) {
      const align = parseTableSeparator(lines[i + 1]!)
      if (align) {
        const headerCells = splitTableRow(line)
        const colCount = Math.max(headerCells.length, align.length)
        const pad = (cells: string[]) => Array.from({ length: colCount }, (_, col) => parseInline(cells[col] ?? ''))
        const header = pad(headerCells)
        const rows: InlineNode[][][] = []
        i += 2
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|') && !isBlockStarter(lines, i)) {
          rows.push(pad(splitTableRow(lines[i]!)))
          i++
        }
        blocks.push({ type: 'table', header, align, rows })
        continue
      }
    }

    // Blockquote (> ...)
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdown(quoteLines.join('\n')) })
      continue
    }

    // Unordered or Ordered List
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/)
    const olMatch = !ulMatch ? line.match(/^(\s*)(\d+)[.)]\s+(.*)$/) : null
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch)
      const start = olMatch ? Number(olMatch[2]) : 1
      const items: Array<{ checked?: boolean; children: InlineNode[] }> = []
      while (i < lines.length) {
        const current = lines[i]!
        const match = ordered
          ? current.match(/^\s*\d+[.)]\s+(.*)$/)
          : current.match(/^\s*[-*+]\s+(.*)$/)
        if (!match) break
        const itemLines = [match[1]!]
        i++
        while (i < lines.length && lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!)) {
          itemLines.push(lines[i]!.trim())
          i++
        }
        let body = itemLines.join('\n')
        let checked: boolean | undefined
        if (!ordered) {
          const task = body.match(/^\[( |x|X)\]\s+(.*)$/s)
          if (task) {
            checked = task[1]!.toLowerCase() === 'x'
            body = task[2]!
          }
        }
        items.push({ ...(checked === undefined ? {} : { checked }), children: parseInline(body) })
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // Paragraph (coalesce consecutive plain lines)
    const paraLines: string[] = [line]
    i++
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]!)
      i++
    }
    blocks.push({ type: 'paragraph', children: parseInline(paraLines.join('\n')) })
  }

  return blocks
}

export interface MarkdownRenderOptions {
  onOpenLink?: (url: string) => void
  onCopyCode?: (code: string) => void
}

function renderInlineNodes(nodes: InlineNode[], options: MarkdownRenderOptions): Node[] {
  const out: Node[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(document.createTextNode(node.text))
        break
      case 'break':
        out.push(document.createElement('br'))
        break
      case 'code': {
        const code = document.createElement('code')
        code.className = 'md-inline-code'
        code.textContent = node.text
        out.push(code)
        break
      }
      case 'fileRef': {
        const code = document.createElement('code')
        code.className = 'md-file-ref'
        code.textContent = node.label
        out.push(code)
        break
      }
      case 'strong': {
        const el = document.createElement('strong')
        el.append(...renderInlineNodes(node.children, options))
        out.push(el)
        break
      }
      case 'em': {
        const el = document.createElement('em')
        el.append(...renderInlineNodes(node.children, options))
        out.push(el)
        break
      }
      case 'del': {
        const el = document.createElement('del')
        el.append(...renderInlineNodes(node.children, options))
        out.push(el)
        break
      }
      case 'link': {
        const a = document.createElement('a')
        a.className = 'md-link'
        a.href = node.href
        a.rel = 'noopener noreferrer'
        a.append(...renderInlineNodes(node.children, options))
        a.addEventListener('click', (event) => {
          event.preventDefault()
          options.onOpenLink?.(node.href)
        })
        out.push(a)
        break
      }
    }
  }
  return out
}

function renderBlocks(blocks: MarkdownBlock[], options: MarkdownRenderOptions): Node[] {
  const out: Node[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const tag = `h${Math.min(block.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4'
        const heading = document.createElement(tag)
        heading.className = `md-h md-h${block.level}`
        heading.append(...renderInlineNodes(block.children, options))
        out.push(heading)
        break
      }
      case 'paragraph': {
        const p = document.createElement('p')
        p.append(...renderInlineNodes(block.children, options))
        out.push(p)
        break
      }
      case 'hr': {
        out.push(document.createElement('hr'))
        break
      }
      case 'blockquote': {
        const bq = document.createElement('blockquote')
        bq.append(...renderBlocks(block.blocks, options))
        out.push(bq)
        break
      }
      case 'list': {
        const list = document.createElement(block.ordered ? 'ol' : 'ul')
        if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start))
        for (const item of block.items) {
          const li = document.createElement('li')
          if (item.checked !== undefined) {
            li.className = 'md-task'
            const box = document.createElement('span')
            box.className = 'md-task-box' + (item.checked ? ' checked' : '')
            box.setAttribute('aria-hidden', 'true')
            box.textContent = item.checked ? '✓' : ''
            li.append(box)
          }
          li.append(...renderInlineNodes(item.children, options))
          list.append(li)
        }
        out.push(list)
        break
      }
      case 'code': {
        const wrap = document.createElement('div')
        wrap.className = 'md-code'
        const bar = document.createElement('div')
        bar.className = 'md-code-bar'
        const lang = document.createElement('span')
        lang.textContent = block.lang || '代码'
        bar.append(lang)
        if (options.onCopyCode) {
          const copyBtn = document.createElement('button')
          copyBtn.type = 'button'
          copyBtn.className = 'md-code-copy'
          copyBtn.textContent = '复制'
          const codeText = block.text
          copyBtn.addEventListener('click', () => options.onCopyCode?.(codeText))
          bar.append(copyBtn)
        }
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        code.textContent = block.text
        pre.append(code)
        wrap.append(bar, pre)
        out.push(wrap)
        break
      }
      case 'table': {
        const wrap = document.createElement('div')
        wrap.className = 'md-table-wrap'
        const table = document.createElement('table')
        const thead = document.createElement('thead')
        const headerRow = document.createElement('tr')
        block.header.forEach((cell, col) => {
          const th = document.createElement('th')
          if (block.align[col]) th.style.textAlign = block.align[col]!
          th.append(...renderInlineNodes(cell, options))
          headerRow.append(th)
        })
        thead.append(headerRow)
        table.append(thead)
        if (block.rows.length > 0) {
          const tbody = document.createElement('tbody')
          for (const row of block.rows) {
            const tr = document.createElement('tr')
            row.forEach((cell, col) => {
              const td = document.createElement('td')
              if (block.align[col]) td.style.textAlign = block.align[col]!
              td.append(...renderInlineNodes(cell, options))
              tr.append(td)
            })
            tbody.append(tr)
          }
          table.append(tbody)
        }
        wrap.append(table)
        out.push(wrap)
        break
      }
    }
  }
  return out
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const blocks = parseMarkdown(source)
  if (blocks.length === 0) {
    fragment.append(document.createTextNode(source))
    return fragment
  }
  fragment.append(...renderBlocks(blocks, options))
  return fragment
}
