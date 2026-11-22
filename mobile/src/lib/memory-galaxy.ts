/** Desktop MemoryGalaxy math (plugin-build/client/index.js) and PR7 graph conventions. */
export const MEMORY_KIND_META = {
  profile: { label: '画像', color: '#f6c35c' }, decision: { label: '决策', color: '#5aa7ff' },
  fact: { label: '事实', color: '#4fd1c5' }, episode: { label: '片段', color: '#b18cff' },
  handoff: { label: '交接', color: '#ff9f5a' }, scene: { label: '场景', color: '#7bd88f' },
} as const
export const CLARITY_LABELS = { vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '仅留印象' } as const
export const MEMORY_LAYERS = { global: '全局', workspace: '工作区', private: '私有' } as const
export const GALAXY_NODE_LIMIT = 420
export interface GalaxyNode {
  id: string
  deviceId: string
  agent: string
  layer: keyof typeof MEMORY_LAYERS
  title: string
  text: string
  kind: keyof typeof MEMORY_KIND_META
  clarity: keyof typeof CLARITY_LABELS
  importance: number
  accessCount: number
  pinned: boolean
  pending: boolean
  tags: string[]
  sourceSession: string
  cue: string
}
export interface GalaxyEdge { source: string; target: string; relation: 'tag' | 'session'; weight: number }
export interface MemoryGraph { nodes: readonly GalaxyNode[]; edges: readonly GalaxyEdge[] }
export interface Point3 { x: number; y: number; z: number }
export interface GalaxyCamera { yaw: number; pitch: number; zoom: number }
export type LayoutNode = GalaxyNode & Point3

export function fnv1a32(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
function enumKey<T extends object>(value: unknown, values: T): value is Extract<keyof T, string> {
  return typeof value === 'string' && Object.hasOwn(values, value)
}

export function toGalaxyNodes(entries: readonly unknown[]): GalaxyNode[] {
  const seen = new Set<string>()
  return entries.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const e = entry as Record<string, unknown>
    const deviceId = str(e.deviceId)
    const agent = str(e.agentId) || str(e.agent)
    const layer = enumKey(e.layer, MEMORY_LAYERS) ? e.layer : 'private'
    const text = typeof e.text === 'string' ? e.text : str(e.summary)
    const sourceId = str(e.id)
    // Host snapshots reuse ids such as "profile"; never merge across devices.
    const id = JSON.stringify([deviceId, layer, agent, sourceId || fnv1a32(text || str(e.title))])
    if (seen.has(id)) return []
    seen.add(id)
    const suffix = sourceId.split('/').pop()?.toLowerCase().replace(/\.md$/, '')
    const kind = enumKey(e.kind, MEMORY_KIND_META) ? e.kind : enumKey(suffix, MEMORY_KIND_META) ? suffix : 'fact'
    const pinned = e.pinned === true
    return [{ id, deviceId, agent, layer, text, kind, pinned,
      title: str(e.title) || text.split('\n').map(line => line.trim().replace(/^#+\s*/, '')).find(Boolean)?.slice(0, 80) || sourceId || '未命名记忆',
      clarity: enumKey(e.clarity, CLARITY_LABELS) ? e.clarity : pinned ? 'vivid' : 'clear',
      importance: Math.max(0, Math.min(1, finite(e.importance, 0.7))),
      accessCount: Math.max(0, finite(e.accessCount, 0)),
      pending: e.status === 'pending' || e.pending === true,
      tags: Array.isArray(e.tags) ? [...new Set(e.tags.map(str).filter(Boolean))] : [],
      sourceSession: str(e.sourceSession) || str(e.sessionId), cue: str(e.cue),
    }]
  })
}

export function buildMemoryGraph(nodes: readonly GalaxyNode[]): MemoryGraph {
  const edges: GalaxyEdge[] = []
  const seen = new Set<string>()
  const groups = (keys: (node: GalaxyNode) => string[], relation: GalaxyEdge['relation'], weight: number) => {
    const buckets = new Map<string, Set<string>>()
    for (const node of nodes) for (const key of keys(node)) {
      const ids = buckets.get(key) ?? new Set<string>()
      ids.add(node.id)
      buckets.set(key, ids)
    }
    for (const bucket of buckets.values()) {
      const ids = [...bucket].sort()
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const source = ids[i], target = ids[j]
        const key = JSON.stringify([source, target, relation])
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source, target, relation, weight })
      }
    }
  }
  groups(node => node.tags, 'tag', 0.72)
  groups(node => [
    ...(node.sourceSession ? [JSON.stringify(['session', node.deviceId, node.sourceSession])] : []),
    ...(node.agent ? [JSON.stringify(['agent', node.deviceId, node.agent])] : []),
  ], 'session', 0.58)
  return { nodes, edges }
}

export function layoutMemoryGalaxy(graph: MemoryGraph, iterations = 110): { nodes: LayoutNode[]; edges: GalaxyEdge[] } {
  const nodes = graph.nodes.slice(0, GALAXY_NODE_LIMIT).map((node, index) => {
    const h = fnv1a32(node.id || String(index))
    const angle = (h % 1000) / 1000 * Math.PI * 2
    const radius = 70 + ((h >>> 10) % 1000) / 1000 * 300
    return { ...node, x: Math.cos(angle) * radius, y: ((h >>> 20) % 1000) / 1000 * 420 - 210,
      z: Math.sin(angle) * radius, vx: 0, vy: 0, vz: 0 }
  })
  const ids = new Map(nodes.map(node => [node.id, node]))
  const edges = graph.edges.flatMap(edge => {
    const a = ids.get(edge.source), b = ids.get(edge.target)
    return a && b && a !== b ? [{ edge, a, b }] : []
  }).slice(0, 1400)
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
        const d2 = dx * dx + dy * dy + dz * dz + 12
        const force = 5200 / d2, d = Math.sqrt(d2)
        a.vx += dx / d * force; a.vy += dy / d * force; a.vz += dz / d * force
        b.vx -= dx / d * force; b.vy -= dy / d * force; b.vz -= dz / d * force
      }
      a.vx -= a.x * 0.0007; a.vy -= a.y * 0.0007; a.vz -= a.z * 0.0007
    }
    for (const { edge, a, b } of edges) {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const force = (d - 170) * 0.008 * (0.4 + (edge.weight || 0.4))
      a.vx += dx / d * force; a.vy += dy / d * force; a.vz += dz / d * force
      b.vx -= dx / d * force; b.vy -= dy / d * force; b.vz -= dz / d * force
    }
    for (const n of nodes) {
      n.vx *= 0.72; n.vy *= 0.72; n.vz *= 0.72
      n.x += n.vx; n.y += n.vy; n.z += n.vz
    }
  }
  const maxRadius = Math.max(1, ...nodes.map(n => Math.hypot(n.x, n.y, n.z)))
  const factor = (nodes.length <= 4 ? 360 : 300) / maxRadius
  return { nodes: nodes.map(({ vx, vy, vz, ...n }) => ({ ...n, x: n.x * factor, y: n.y * factor, z: n.z * factor })),
    edges: edges.map(({ edge }) => edge) }
}

export function projectGalaxyNode(node: Point3, camera: GalaxyCamera, width: number, height: number) {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw)
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch)
  const x = node.x * cy - node.z * sy
  const z = node.x * sy + node.z * cy
  const y = node.y * cp - z * sp
  const depth = node.y * sp + z * cp
  const scale = 900 / (900 + depth) * camera.zoom
  return { x: width / 2 + x * scale, y: height / 2 + y * scale, scale, depth }
}

export function pickNearestGalaxyNode<T extends { x: number; y: number }>(projected: readonly T[], x: number, y: number, maxDist: number): T | undefined {
  let best: T | undefined
  let distance = maxDist
  for (const point of projected) {
    const d = Math.hypot(point.x - x, point.y - y)
    if (d <= distance) { best = point; distance = d }
  }
  return best
}
