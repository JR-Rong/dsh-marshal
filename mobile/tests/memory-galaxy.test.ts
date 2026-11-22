import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryGraph, fnv1a32, layoutMemoryGalaxy, pickNearestGalaxyNode, projectGalaxyNode, toGalaxyNodes } from '../src/lib/memory-galaxy.ts'
import { initialGalaxyCamera, mountGalaxyCanvas } from '../src/lib/memory-galaxy-canvas.ts'
import { makeConfig, normalizeDailySummaryCapK, parseConfig, tightenPrivacyMode } from '../src/lib/config.ts'
import { readConfig, updateConfig, writeNodePreference } from '../src/lib/storage.ts'

const entry = { id: 'profile', deviceId: 'host-a', layer: 'private', agent: 'coder', text: '# 当前偏好\n正文' }

test('FNV-1a matches the desktop UTF-16 hash and known vectors', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5)
  assert.equal(fnv1a32('hello'), 0x4f9f2cab)
  assert.equal(fnv1a32('记忆'), fnv1a32('记忆'))
  assert.notEqual(fnv1a32('记忆'), fnv1a32('记性'))
})

test('normalizes Hub rows and optional metadata without merging hosts', () => {
  const [first, other, pending] = toGalaxyNodes([null, entry, entry,
    { ...entry, deviceId: 'host-b' }, { id: 'pending', layer: 'global', agentId: 'lead', title: '提案', kind: 'decision',
      status: 'pending', pinned: true, importance: 2, tags: [' tag ', 'tag', 3], sourceSession: 's-1' },
  ])
  assert.equal(first.title, '当前偏好')
  assert.equal(first.kind, 'profile')
  assert.equal(first.clarity, 'clear')
  assert.notEqual(first.id, other.id)
  assert.equal(pending.text, '')
  assert.equal(pending.agent, 'lead')
  assert.equal(pending.importance, 1)
  assert.equal(pending.clarity, 'vivid')
  assert.equal(pending.pending, true)
  assert.deepEqual(pending.tags, ['tag'])
})

test('deduplicates undirected edges per relation across tags, session and agent', () => {
  const [a, b, c, d] = toGalaxyNodes([
    { ...entry, id: 'a', tags: ['x', 'y', 'x'], sourceSession: 's1' },
    { ...entry, id: 'b', tags: ['x', 'y'], sourceSession: 's1' },
    { ...entry, id: 'c', sourceSession: 's2' },
    { ...entry, id: 'd', sourceSession: 's1', deviceId: 'host-b' },
  ])
  const graph = buildMemoryGraph([b, a, c, d])
  assert.deepEqual(graph.edges, [
    { source: a.id, target: b.id, relation: 'tag', weight: 0.72 },
    { source: a.id, target: b.id, relation: 'session', weight: 0.58 },
    { source: a.id, target: c.id, relation: 'session', weight: 0.58 },
    { source: b.id, target: c.id, relation: 'session', weight: 0.58 },
  ])
})

test('default layout deterministically runs 110 steps and normalizes to a finite sphere', () => {
  const nodes = toGalaxyNodes(Array.from({ length: 25 }, (_, i) => ({ ...entry, id: `n${i}`, tags: [`t${i % 3}`] })))
  const graph = buildMemoryGraph(nodes)
  const laid = layoutMemoryGalaxy(graph)
  assert.deepEqual(laid, layoutMemoryGalaxy(graph, 110))
  assert.notDeepEqual(laid, layoutMemoryGalaxy(graph, 109))
  const radii = laid.nodes.map(n => Math.hypot(n.x, n.y, n.z))
  assert.ok(radii.every(r => Number.isFinite(r) && r <= 300.000001))
  assert.ok(Math.abs(Math.max(...radii) - 300) < 1e-6)
  assert.ok(laid.nodes.some((node, i) => Math.hypot(node.x, node.y, node.z) !== radii[0] && i > 0))
  assert.equal(Object.hasOwn(nodes[0], 'x'), false)
  assert.deepEqual(layoutMemoryGalaxy({ nodes: [], edges: [] }), { nodes: [], edges: [] })
})

test('projects yaw, pitch and perspective, picking only within the hit radius', () => {
  const center = projectGalaxyNode({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0, zoom: 1 }, 320, 240)
  assert.deepEqual(center, { x: 160, y: 120, scale: 1, depth: 0 })
  const rotated = projectGalaxyNode({ x: 100, y: 0, z: 0 }, { yaw: Math.PI / 2, pitch: Math.PI / 2, zoom: 2 }, 320, 240)
  assert.ok(Math.abs(rotated.x - 160) < 1e-9)
  assert.ok(Math.abs(rotated.y - (-80)) < 1e-9)
  const distant = projectGalaxyNode({ x: 60, y: 0, z: 300 }, { yaw: 0, pitch: 0, zoom: 1 }, 320, 240)
  assert.equal(distant.scale, 0.75)
  assert.equal(pickNearestGalaxyNode([distant, center], 167, 122, 24), center)
  assert.equal(pickNearestGalaxyNode([distant, center], 0, 0, 24), undefined)
})

test('legacy config round-trips, validating and never loosening privacy', async (t) => {
  const legacy = makeConfig({ hubUrl: 'https://hub.example.test', token: 'mph1.test', label: '旧配置' })
  assert.equal(tightenPrivacyMode('content'), 'metadata')
  assert.equal(tightenPrivacyMode('metadata'), 'metadata')
  assert.equal(tightenPrivacyMode(undefined), 'metadata')
  assert.equal(parseConfig({ ...legacy, privacyMode: 'invalid' })?.privacyMode, undefined)
  assert.equal(normalizeDailySummaryCapK(parseConfig(legacy)?.dailySummaryCapK), 50)
  for (const [raw, expected] of [[NaN, 50], [Infinity, 50], ['80', 50], [4, 10], [80.8, 81], [999, 200]]) {
    assert.equal(parseConfig({ ...legacy, dailySummaryCapK: raw })?.dailySummaryCapK, expected)
  }
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value),
  } } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'window') })
  await updateConfig(() => legacy)
  await Promise.all([writeNodePreference({ tightenPrivacy: true }), writeNodePreference({ dailySummaryCapK: 123 }),
    updateConfig(current => ({ ...(current ?? legacy), privacyMode: 'content', label: '新备注' }))])
  const result = await readConfig()
  assert.equal(result.status, 'ok')
  const saved = result.config
  assert.equal(saved?.privacyMode, 'metadata')
  assert.equal(saved?.dailySummaryCapK, 123)
  assert.equal(saved?.token, legacy.token)
  assert.equal(saved?.label, '新备注')
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(saved))), saved)
})

test('Canvas picks without remounting, handles drag and pinch, and cancels RAF/listeners on hide or dispose', (t) => {
  const frame = new Map<number, (time: number) => void>()
  let next = 0
  const stub = () => {}
  const gradient = { addColorStop: stub }
  const ctx = { setTransform: stub, createRadialGradient: () => gradient, fillRect: stub, beginPath: stub,
    arc: stub, fill: stub, stroke: stub, fillText: stub }
  const capture = new Set<number>()
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 320, clientHeight: 240, isConnected: true, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0 }), classList: { add: stub, remove: stub },
    hasPointerCapture: (id: number) => capture.has(id), setPointerCapture: (id: number) => capture.add(id),
    releasePointerCapture: (id: number) => capture.delete(id),
  })
  const doc = Object.assign(new EventTarget(), { hidden: false })
  const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 })
  const globals = {
    document: doc, window: win,
    requestAnimationFrame: (cb: (time: number) => void) => { frame.set(++next, cb); return next },
    cancelAnimationFrame: (id: number) => frame.delete(id),
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => { for (const key of Object.keys(globals)) Reflect.deleteProperty(globalThis, key) })
  const camera = initialGalaxyCamera()
  const [node] = toGalaxyNodes([entry])
  const graph = { nodes: [{ ...node, x: 0, y: 0, z: 0 }], edges: [] }
  let selected = ''
  const controls = { plus: new EventTarget(), minus: new EventTarget(), reset: new EventTarget() }
  const dispose = mountGalaxyCanvas(canvas as unknown as HTMLCanvasElement, graph, camera, () => selected,
    id => { selected = id }, controls as unknown as Parameters<typeof mountGalaxyCanvas>[5])
  const tick = () => { for (const [id, cb] of [...frame]) { frame.delete(id); cb(100) } }
  const pointer = (type: string, pointerId: number, clientX: number, clientY = 120) => {
    canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId, clientX, clientY }))
  }
  tick()
  const yaw = camera.yaw
  pointer('pointerdown', 1, 160); pointer('pointerup', 1, 160)
  assert.equal(selected, node.id)
  tick()
  assert.equal(camera.yaw, yaw)
  assert.equal(frame.size, 1)
  pointer('pointerdown', 1, 160); pointer('pointermove', 1, 183)
  assert.ok(camera.yaw > yaw)
  pointer('pointerdown', 2, 200); pointer('pointermove', 2, 210)
  assert.ok(camera.zoom > 1)
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(frame.size, 0)
  assert.equal(capture.size, 0)
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(frame.size, 1)
  dispose()
  controls.reset.dispatchEvent(new Event('click'))
  win.dispatchEvent(new Event('pageshow'))
  pointer('pointerdown', 1, 160)
  assert.ok(camera.zoom > 1)
  assert.equal(capture.size, 0)
  assert.equal(frame.size, 0)
})
