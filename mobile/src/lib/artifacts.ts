export type ArtifactKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'binary'

export interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
}

export interface ToolArtifactItem {
  path: string
  name: string
  kind: ArtifactKind
  action: 'edit' | 'write' | 'present' | 'read' | 'ref'
  description?: string
  diffLines?: DiffLine[]
  added?: number
  removed?: number
  content?: string
  startLine?: number
  endLine?: number
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'])
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'])
const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx', 'txt',
  'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'sh', 'zsh', 'bash', 'sql', 'diff', 'patch', 'csv', 'tsv', 'log', 'vue', 'svelte',
  'rb', 'php', 'lua', 'r', 'gradle', 'cmake', 'plist',
])

export function parseArtifactTarget(raw: string): {
  path: string
  name: string
  kind: ArtifactKind
  startLine?: number
  endLine?: number
} {
  let clean = raw.trim()
  let startLine: number | undefined
  let endLine: number | undefined
  const hashMatch = clean.match(/#L(\d+)(?:-L?(\d+))?$/i)
  if (hashMatch) {
    startLine = Number(hashMatch[1])
    endLine = hashMatch[2] ? Number(hashMatch[2]) : startLine
    clean = clean.slice(0, clean.length - hashMatch[0].length)
  }
  if (/^file:\/\//i.test(clean)) {
    clean = clean.replace(/^file:\/\//i, '').split('?')[0] ?? clean
    try { clean = decodeURIComponent(clean) } catch { /* keep */ }
  }
  const normalized = clean.replace(/\\/g, '/')
  const name = normalized.split('/').filter(Boolean).pop() ?? (clean || '文件')
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  let kind: ArtifactKind = 'binary'
  if (IMAGE_EXTS.has(ext)) kind = 'image'
  else if (VIDEO_EXTS.has(ext)) kind = 'video'
  else if (AUDIO_EXTS.has(ext)) kind = 'audio'
  else if (ext === 'pdf') kind = 'pdf'
  else if (TEXT_EXTS.has(ext) || /^(makefile|dockerfile|readme|license)$/i.test(name)) kind = 'text'
  return {
    path: clean,
    name,
    kind,
    ...(startLine !== undefined ? { startLine, endLine } : {}),
  }
}

export function isPreviewableLocalPath(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 512) return false
  if (/^file:\/\//i.test(trimmed)) return true
  if (!/^(?:\/|~\/)/.test(trimmed)) return false
  if (/\s/.test(trimmed) && !/\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|m4v|mp3|wav|m4a|pdf|md|txt|ts|tsx|js|jsx|py|json|css|html|ya?ml)$/i.test(trimmed)) {
    return false
  }
  const parsed = parseArtifactTarget(trimmed)
  return parsed.kind !== 'binary'
}

/** 轻量级行级 Diff，适配手机端展示 edit/Edit 工具调用中的变更。 */
export function buildLineDiff(oldText: string, newText: string, maxLines = 240): {
  lines: DiffLine[]
  added: number
  removed: number
} {
  const a = oldText === '' ? [] : oldText.replace(/\r\n?/g, '\n').split('\n')
  const b = newText === '' ? [] : newText.replace(/\r\n?/g, '\n').split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++
  }

  const lines: DiffLine[] = []
  const ctxBefore = Math.max(0, prefix - 2)
  for (let i = ctxBefore; i < prefix; i++) lines.push({ type: 'context', text: a[i]! })

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  let added = 0
  let removed = 0
  // Use LCS when both sides are modest; fall back to clean block diff for huge edits.
  if (midA.length * midB.length <= 40_000) {
    const m = midA.length
    const n = midB.length
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j]
          ? (dp[i + 1]![j + 1]! + 1)
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < m || j < n) {
      if (i < m && j < n && midA[i] === midB[j]) {
        lines.push({ type: 'context', text: midA[i]! })
        i++
        j++
      } else if (i < m && (j === n || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        lines.push({ type: 'remove', text: midA[i]! })
        removed++
        i++
      } else {
        lines.push({ type: 'add', text: midB[j]! })
        added++
        j++
      }
    }
  } else {
    for (const line of midA) { lines.push({ type: 'remove', text: line }); removed++ }
    for (const line of midB) { lines.push({ type: 'add', text: line }); added++ }
  }

  const ctxAfter = Math.min(suffix, 2)
  for (let i = 0; i < ctxAfter; i++) lines.push({ type: 'context', text: a[a.length - suffix + i]! })

  return { lines: lines.slice(0, maxLines), added, removed }
}

export function parseUnifiedDiffText(rawDiff: string, maxLines = 240): {
  lines: DiffLine[]
  added: number
  removed: number
} {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const line of rawDiff.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      lines.push({ type: 'context', text: line })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', text: line.slice(1) })
      added++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', text: line.slice(1) })
      removed++
    } else {
      lines.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  return { lines: lines.slice(0, maxLines), added, removed }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'string' && val.trim() !== '') return val
  }
  return undefined
}

/** 从 tool.started 载荷中提取修改的文件、Diff、写入内容、以及交付/读取的图片和视频。 */
export function extractToolArtifacts(toolName: string, rawArgs: unknown): ToolArtifactItem[] {
  const args = asRecord(rawArgs)
  if (!args) return []
  const lower = toolName.toLowerCase()

  // Edit tools: DSH edit / mcp_dsh_edit / edit_file / Claude Edit
  if (lower === 'edit' || lower === 'edit_file' || lower.endsWith('_edit') || lower === 'multiedit') {
    const filePath = pickString(args, 'file_path', 'Path', 'path', 'filePath')
    if (!filePath) return []
    const meta = parseArtifactTarget(filePath)
    const oldStr = typeof args.old_string === 'string' ? args.old_string
      : typeof args.Target === 'string' ? args.Target
        : typeof args.oldText === 'string' ? args.oldText : undefined
    const newStr = typeof args.new_string === 'string' ? args.new_string
      : typeof args.Replacement === 'string' ? args.Replacement
        : typeof args.newText === 'string' ? args.newText : undefined
    if (oldStr !== undefined && newStr !== undefined) {
      const diff = buildLineDiff(oldStr, newStr)
      return [{
        ...meta,
        action: 'edit',
        diffLines: diff.lines,
        added: diff.added,
        removed: diff.removed,
      }]
    }
    return [{ ...meta, action: 'edit' }]
  }

  // Write tools: DSH write / mcp_dsh_write / write_file / Claude Write
  if (lower === 'write' || lower === 'write_file' || lower.endsWith('_write')) {
    const filePath = pickString(args, 'file_path', 'Path', 'path', 'filePath')
    if (!filePath) return []
    const meta = parseArtifactTarget(filePath)
    const content = typeof args.content === 'string' ? args.content
      : typeof args.Content === 'string' ? args.Content : undefined
    const added = content ? content.replace(/\r\n?/g, '\n').split('\n').length : undefined
    return [{
      ...meta,
      action: 'write',
      ...(content !== undefined ? { content: content.slice(0, 20_000) } : {}),
      ...(added !== undefined ? { added, removed: 0 } : {}),
    }]
  }

  // Codex fileChange: { changes: [{ path, kind, diff }] }
  if (lower === 'filechange' && Array.isArray(args.changes)) {
    const out: ToolArtifactItem[] = []
    for (const rawChange of args.changes) {
      const change = asRecord(rawChange)
      const filePath = change ? pickString(change, 'path', 'file_path') : undefined
      if (!filePath) continue
      const meta = parseArtifactTarget(filePath)
      const rawDiff = typeof change?.diff === 'string' ? change.diff : undefined
      const parsed = rawDiff ? parseUnifiedDiffText(rawDiff) : undefined
      out.push({
        ...meta,
        action: 'edit',
        ...(parsed ? { diffLines: parsed.lines, added: parsed.added, removed: parsed.removed } : {}),
      })
    }
    return out
  }

  // Present deliverables: { files: [{ path, description }] }
  if (lower === 'present' || lower.endsWith('_present')) {
    if (!Array.isArray(args.files)) return []
    const out: ToolArtifactItem[] = []
    for (const rawFile of args.files) {
      const file = asRecord(rawFile)
      const filePath = file ? pickString(file, 'path', 'file_path') : undefined
      if (!filePath) continue
      const meta = parseArtifactTarget(filePath)
      out.push({
        ...meta,
        action: 'present',
        ...(typeof file?.description === 'string' ? { description: file.description } : {}),
      })
    }
    return out
  }

  // Image / File readers: read_image, read_file, read
  if (lower === 'read_image' || lower.endsWith('_read_image') || lower === 'read_file' || lower === 'read' || lower.endsWith('_read')) {
    const filePath = pickString(args, 'file_path', 'Path', 'path')
    if (!filePath) return []
    const meta = parseArtifactTarget(filePath)
    return [{ ...meta, action: 'read' }]
  }

  return []
}

/** 从 Markdown 正文中抽取 file:// 链接、本地图片 ![...](/path) 以及显著本地媒体路径。 */
export function extractTextArtifacts(text: string): ToolArtifactItem[] {
  if (!text) return []
  const found: ToolArtifactItem[] = []
  const seen = new Set<string>()
  const push = (raw: string, label?: string) => {
    const meta = parseArtifactTarget(raw)
    if (!meta.path || seen.has(meta.path)) return
    seen.add(meta.path)
    found.push({
      ...meta,
      action: 'ref',
      ...(label && label !== meta.name ? { description: label } : {}),
    })
  }

  // Markdown links & images pointing to file:// or absolute paths
  const mdLinkRe = /!?\[([^\]]*)\]\(([^)\s]+)\)/g
  for (const match of text.matchAll(mdLinkRe)) {
    const label = match[1]?.trim()
    const href = match[2]?.trim() ?? ''
    if (/^file:\/\//i.test(href) || isPreviewableLocalPath(href)) {
      push(href, label)
    }
  }

  // Inline code or standalone absolute media/file paths (e.g. `/Volumes/.../render.png` or `/tmp/demo.mp4`)
  const mediaPathRe = /(?:^|[\s`("'])((?:\/|~\/)[^\s`"')<>]+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|m4v|mp3|wav|m4a|pdf))/gi
  for (const match of text.matchAll(mediaPathRe)) {
    const raw = match[1]?.trim() ?? ''
    if (raw) push(raw)
  }

  return found
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function artifactKindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'image': return '图片'
    case 'video': return '视频'
    case 'audio': return '音频'
    case 'pdf': return 'PDF'
    case 'text': return '文件'
    default: return '附件'
  }
}

export function collectSessionArtifacts(
  messages: ReadonlyArray<{ role: string; text: string; artifacts?: ToolArtifactItem[] }>,
): ToolArtifactItem[] {
  const byPath = new Map<string, ToolArtifactItem>()
  const priority: Record<ToolArtifactItem['action'], number> = {
    edit: 5,
    write: 4,
    present: 3,
    read: 2,
    ref: 1,
  }
  const add = (item: ToolArtifactItem) => {
    const existing = byPath.get(item.path)
    if (!existing) {
      byPath.set(item.path, item)
      return
    }
    if (priority[item.action] >= priority[existing.action]) {
      byPath.set(item.path, {
        ...existing,
        ...item,
        diffLines: item.diffLines ?? existing.diffLines,
        added: item.added ?? existing.added,
        removed: item.removed ?? existing.removed,
        content: item.content ?? existing.content,
        description: item.description ?? existing.description,
      })
    } else if (!existing.diffLines && item.diffLines) {
      byPath.set(item.path, { ...existing, diffLines: item.diffLines, added: item.added, removed: item.removed })
    }
  }

  for (const msg of messages) {
    if (msg.artifacts) {
      for (const item of msg.artifacts) add(item)
    }
    if (msg.role === 'assistant') {
      for (const item of extractTextArtifacts(msg.text)) add(item)
    }
  }
  // Put edits/writes/media first for fastest review.
  return [...byPath.values()].sort((a, b) => {
    const mediaDiff = Number(b.kind === 'image' || b.kind === 'video') - Number(a.kind === 'image' || a.kind === 'video')
    const actDiff = priority[b.action] - priority[a.action]
    if (actDiff !== 0) return actDiff
    if (mediaDiff !== 0) return mediaDiff
    return a.name.localeCompare(b.name)
  })
}
