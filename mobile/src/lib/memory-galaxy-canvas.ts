import { MEMORY_KIND_META, pickNearestGalaxyNode, projectGalaxyNode, type GalaxyCamera, type layoutMemoryGalaxy } from './memory-galaxy.ts'

export const initialGalaxyCamera = () => ({ yaw: 0.35, pitch: -0.16, zoom: 1, auto: true })
type CanvasCamera = GalaxyCamera & { auto: boolean }
type Point = { x: number; y: number }
const circle = Math.PI * 2
const clarityAlpha = { vivid: 1, clear: 0.85, fuzzy: 0.5, trace: 0.28 }
const stars = Array.from({ length: 180 }, (_, i) => ({ x: (i * 73 % 997) / 997, y: (i * 151 % 991) / 991, r: (i % 7) / 7 * 1.15 + 0.22, phase: i }))

export function mountGalaxyCanvas(canvas: HTMLCanvasElement, graph: ReturnType<typeof layoutMemoryGalaxy>, camera: CanvasCamera,
  selected: () => string, select: (id: string) => void, controls: { plus: HTMLElement; minus: HTMLElement; reset: HTMLElement }): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const labels = new Set([...graph.nodes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance).slice(0, 5).map(n => n.id))
  const events = new AbortController()
  const options = { signal: events.signal }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const pointers = new Map<number, Point>()
  let start: Point | undefined
  let moved = false
  let raf = 0
  const zoom = (factor: number) => { camera.zoom = Math.max(0.5, Math.min(2.8, camera.zoom * factor)) }
  const project = (width: number, height: number) => {
    const fit = Math.min(width, height) / 850
    const view = { ...camera, zoom: camera.zoom * fit }
    return graph.nodes.map(node => ({ node, ...projectGalaxyNode(node, view, width, height) })).sort((a, b) => b.depth - a.depth)
  }
  let projected: ReturnType<typeof project> = []
  const arc = (x: number, y: number, r: number) => { ctx.beginPath(); ctx.arc(x, y, r, 0, circle) }
  const draw = (time: number): void => {
    raf = 0
    if (events.signal.aborted || document.hidden || !canvas.isConnected) return
    const width = canvas.clientWidth, height = canvas.clientHeight
    if (width && height) {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(width * dpr), h = Math.round(height * dpr)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const bg = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.75)
      bg.addColorStop(0, '#111827'); bg.addColorStop(1, '#05070d')
      ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height)
      const t = reducedMotion.matches ? 0 : time
      ctx.fillStyle = '#b4d2ff'
      for (const star of stars) {
        ctx.globalAlpha = 0.18 + 0.35 * (0.5 + 0.5 * Math.sin(t / 2400 + star.phase))
        arc(star.x * width, star.y * height, star.r); ctx.fill()
      }
      ctx.globalAlpha = 1
      if (camera.auto && !pointers.size && !reducedMotion.matches) camera.yaw = (camera.yaw + 0.00045) % circle
      projected = project(width, height)
      const byId = new Map(projected.map(p => [p.node.id, p]))
      const edges = graph.edges.flatMap(edge => {
        const a = byId.get(edge.source), b = byId.get(edge.target)
        return a && b ? [{ a, b, relation: edge.relation }] : []
      }).sort((a, b) => b.a.depth + b.b.depth - a.a.depth - a.b.depth)
      ctx.lineWidth = 0.7
      for (const { a, b, relation } of edges) {
        ctx.strokeStyle = relation === 'session' ? 'rgba(120,180,255,0.20)' : 'rgba(160,140,255,0.25)'
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      const selectedId = selected()
      for (const { node, x, y, scale, depth } of projected) {
        const radius = Math.max(2, (3.2 + Math.sqrt(Math.max(0.01, node.importance)) * 8 + Math.log1p(node.accessCount) * 1.6) * scale)
        const alpha = Math.max(0.12, Math.min(1, 1 - (depth + 350) / 900)) * clarityAlpha[node.clarity]
        const color = MEMORY_KIND_META[node.kind].color
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.2)
        glow.addColorStop(0, color); glow.addColorStop(0.24, color + '55'); glow.addColorStop(1, 'transparent')
        ctx.globalAlpha = alpha * 0.55; ctx.fillStyle = glow; arc(x, y, radius * 3.2); ctx.fill()
        ctx.globalAlpha = alpha; ctx.fillStyle = color; arc(x, y, radius); ctx.fill()
        ctx.globalAlpha = 1; ctx.lineWidth = 1.4
        if (node.pinned) { ctx.strokeStyle = '#ffdc96'; arc(x, y, radius + 3); ctx.stroke() }
        if (node.id === selectedId) { ctx.strokeStyle = '#fff'; arc(x, y, radius + 6); ctx.stroke() }
        if (node.pending) {
          const pulse = 0.5 + 0.5 * Math.sin(t / 300)
          ctx.strokeStyle = `rgba(255,176,73,${0.4 + 0.6 * pulse})`
          arc(x, y, radius + 9 + 4 * pulse); ctx.stroke()
        }
        if (node.id === selectedId || labels.has(node.id)) {
          ctx.fillStyle = '#e8edf7'; ctx.font = '12px system-ui'
          ctx.fillText(node.title.slice(0, 18), x + radius + 7, y + 3)
        }
      }
    }
    raf = requestAnimationFrame(draw)
  }
  const pinchDistance = () => {
    const [a, b] = pointers.values()
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  const release = (id: number) => { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id) }
  const resetPointers = () => {
    for (const id of pointers.keys()) release(id)
    pointers.clear(); start = undefined
    canvas.classList.remove('dragging')
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return
    const point = { x: event.clientX, y: event.clientY }
    if (!pointers.size) { start = point; moved = false }
    else { moved = true; camera.auto = false }
    pointers.set(event.pointerId, point)
    canvas.setPointerCapture(event.pointerId)
    canvas.classList.add('dragging')
  }, options)
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId)
    if (!previous) return
    const point = { x: event.clientX, y: event.clientY }
    const before = pinchDistance()
    pointers.set(event.pointerId, point)
    if (pointers.size === 2) {
      const after = pinchDistance()
      if (before > 0 && after > 0) zoom(after / before)
      return
    }
    if (!moved && start && Math.hypot(point.x - start.x, point.y - start.y) < 5) return
    moved = true; camera.auto = false
    camera.yaw = (camera.yaw + (point.x - previous.x) * 0.009) % circle
    camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + (point.y - previous.y) * 0.009))
  }, options)
  const endPointer = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return
    if (event.type === 'pointerup' && !moved && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
      const rect = canvas.getBoundingClientRect()
      const hit = pickNearestGalaxyNode(projected, event.clientX - rect.left, event.clientY - rect.top, 24)
      if (hit) { camera.auto = false; select(hit.node.id) }
    }
    pointers.delete(event.pointerId)
    release(event.pointerId)
    if (!pointers.size) resetPointers()
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) canvas.addEventListener(event, endPointer, options)
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    if (event.deltaY) zoom(event.deltaY > 0 ? 0.92 : 1.08)
  }, { ...options, passive: false })
  controls.plus.addEventListener('click', () => zoom(1.2), options)
  controls.minus.addEventListener('click', () => zoom(1 / 1.2), options)
  controls.reset.addEventListener('click', () => Object.assign(camera, initialGalaxyCamera()), options)
  function suspend(): void { cancelAnimationFrame(raf); raf = 0; resetPointers() }
  function resume(): void { if (!raf && !document.hidden) raf = requestAnimationFrame(draw) }
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else resume() }, options)
  window.addEventListener('pagehide', suspend, options)
  window.addEventListener('pageshow', resume, options)
  resume()
  return () => { events.abort(); suspend() }
}
