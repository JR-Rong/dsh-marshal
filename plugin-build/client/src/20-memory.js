    function MemoryGalaxy({ graph, selectedId, onSelect, paused }) {
      const canvasRef = React.useRef(null);
      const pausedRef = React.useRef(paused);
      pausedRef.current = paused;
      const cameraRef = React.useRef({ yaw: 0.35, pitch: -0.16, zoom: 1 });
      const selectRef = React.useRef(onSelect);
      selectRef.current = onSelect;
      const selectedRef = React.useRef(selectedId);
      selectedRef.current = selectedId;
      const kinds = ['profile', 'decision', 'fact', 'episode', 'handoff', 'scene'];
      const layout = React.useMemo(() => {
        const domains = new Set((graph.nodes || []).map(node => node.scope));
        const hash = value => {
          let h = 2166136261;
          for (const character of value) h = Math.imul(h ^ character.codePointAt(0), 16777619);
          return h >>> 0;
        };
        const nodes = (graph.nodes || []).slice(0, 420).map((node, index) => {
          const seed = hash(String(node.id ?? index));
          const domain = ({ global: 0, workspace: 1, agent: 2 })[node.scope] ?? 0;
          const orbit = Math.max(0, kinds.indexOf(node.kind)) * Math.PI / 3;
          const angle = seed / 0x100000000 * Math.PI * 2;
          const radius = 12 + (hash('radius:' + seed) % 1000) / 1000 * 42;
          return { ...node,
            x: (domains.size > 1 ? (domain - 1) * 160 : 0) + Math.cos(orbit) * 78 + Math.cos(angle) * radius,
            y: Math.sin(orbit) * 78 + Math.sin(angle) * radius,
            z: (hash('depth:' + seed) % 1000) / 1000 * 140 - 70,
          };
        });
        const ids = new Set(nodes.map(node => node.id));
        const edges = (graph.edges || []).filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target).slice(0, 1400);
        // Keep a few landmark titles readable without labelling every node.
        const labelIds = new Set([...nodes]
          .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (Number(b.importance) || 0) - (Number(a.importance) || 0))
          .slice(0, nodes.length > 40 ? 5 : 8).map(node => node.id));
        return { nodes, edges, labelIds };
      }, [graph]);
      const layoutRef = React.useRef(layout);
      layoutRef.current = layout;
      const scheduleRef = React.useRef(null);
      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const tokens = ['state-warning-primary', 'marshal-accent', 'marshal-success',
          'label-secondary', 'marshal-danger', 'state-info-primary'];
        const fallbackHues = [38, 215, 155, 265, 5, 185];
        const stars = Array.from({ length: 120 }, (_, index) => ({ x: (index * 73 % 997) / 997, y: (index * 151 % 991) / 991, r: (index % 7) / 7 + 0.2 }));
        const camera = cameraRef.current;
        let width = 0, height = 0, pointerId = null;
        let rotY = camera.yaw;
        let drift = 1;
        let hover, dragging = false, moved = false, lastX, lastY, startX, startY;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        let raf = null;
        let disposed = false;
        const toScreen = (node, width, height) => {
          const cy = Math.cos(rotY), sy = Math.sin(rotY);
          const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
          let x = node.x * cy - node.z * sy;
          let z = node.x * sy + node.z * cy;
          let y = node.y * cp - z * sp;
          z = node.y * sp + z * cp;
          const focal = 900;
          const scale = focal / (focal + z) * camera.zoom * Math.min(1.2, width / 560, height / 340);
          return { x: width / 2 + x * scale, y: height / 2 + y * scale, scale, depth: z };
        };
        const draw = () => {
          if (disposed) return;
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          width = canvas.clientWidth || 600; height = canvas.clientHeight || 480;
          if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);
          const theme = window.getComputedStyle(canvas);
          const ink = theme.color;
          const colors = tokens.map((token, index) => theme.getPropertyValue('--dsw-alias-' + token).trim() || 'hsl(' + fallbackHues[index] + ' 48% 48%)');
          // A very soft vignette keeps the canvas from reading as a flat empty box.
          if (typeof ctx.createRadialGradient === 'function' && typeof ctx.fillRect === 'function') {
            try {
              const vignette = ctx.createRadialGradient(width / 2, height * 0.46, Math.min(width, height) * 0.12,
                width / 2, height / 2, Math.max(width, height) * 0.72);
              vignette.addColorStop(0, ink);
              vignette.addColorStop(1, 'transparent');
              ctx.globalAlpha = 0.06; ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
            } catch { /* A host colour the canvas cannot parse simply skips the wash. */ }
          }
          ctx.globalAlpha = 0.16; ctx.fillStyle = ink;
          for (const star of stars) {
            ctx.beginPath(); ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2); ctx.fill();
          }
          const { nodes, edges, labelIds } = layoutRef.current;
          if (!dragging && hover !== undefined && !nodes.some(node => node.id === hover)) {
            hover = undefined;
            canvas.style.cursor = 'grab';
          }
          const target = hover !== undefined || dragging ? 0 : 1;
          drift += (target - drift) * 0.09;
          if (Math.abs(drift - target) < 0.001) drift = target;
          if (!pausedRef.current) {
            if (drift === 1) rotY += 0.00028;
            else rotY += 0.00028 * drift;
          }
          camera.yaw = rotY;
          const projected = nodes.map(node => ({ node, ...toScreen(node, width, height) })).sort((a, b) => b.depth - a.depth);
          const points = new Map(projected.map(entry => [entry.node.id, entry]));
          ctx.lineWidth = 0.7;
          for (const edge of edges) {
            const a = points.get(edge.source), b = points.get(edge.target);
            if (!a || !b) continue;
            const depth = Math.max(0.12, Math.min(1, 1 - (a.depth + 350) / 900));
            ctx.globalAlpha = 0.05 + depth * 0.12;
            ctx.strokeStyle = ink;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
          const focusId = hover ?? selectedRef.current;
          for (const entry of projected) {
            const node = entry.node;
            const base = 3.2 + Math.sqrt(Math.max(0.01, (Number(node.importance) || 0))) * 8 + Math.log1p(Math.max(0, Number(node.accessCount) || 0)) * 1.6;
            const radius = Math.max(2, base * entry.scale);
            const clarityAlpha = node.clarity === 'fuzzy' ? 0.5 : node.clarity === 'trace' ? 0.28 : node.clarity === 'clear' ? 0.85 : 1;
            const alpha = Math.max(0.12, Math.min(1, 1 - (entry.depth + 350) / 900)) * clarityAlpha;
            const color = colors[kinds.indexOf(node.kind)] || ink;
            const active = focusId === node.id;
            // Landmarks and the focused node glow; the rest stay flat so a dense
            // workspace graph never turns into a bloom storm.
            if ((active || node.pinned || labelIds.has(node.id)) && typeof ctx.createRadialGradient === 'function' && radius > 3) {
              try {
                const halo = ctx.createRadialGradient(entry.x, entry.y, radius * 0.6, entry.x, entry.y, radius * 3.4);
                halo.addColorStop(0, color);
                halo.addColorStop(1, 'transparent');
                ctx.globalAlpha = Math.min(0.42, alpha * 0.5); ctx.fillStyle = halo;
                ctx.beginPath(); ctx.arc(entry.x, entry.y, radius * 3.4, 0, Math.PI * 2); ctx.fill();
              } catch { /* Unparsable host colour: fall back to the solid node. */ }
            }
            if (selectedRef.current === node.id || node.pinned) {
              ctx.globalAlpha = 0.85; ctx.strokeStyle = ink; ctx.lineWidth = 1.2;
              ctx.beginPath(); ctx.arc(entry.x, entry.y, radius + 4, 0, Math.PI * 2); ctx.stroke();
            }
            ctx.globalAlpha = alpha; ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(entry.x, entry.y, radius, 0, Math.PI * 2); ctx.fill();
            if (active || labelIds.has(node.id)) {
              const label = String(node.title || '').slice(0, 42);
              if (label) {
                ctx.globalAlpha = active ? 1 : Math.min(0.72, alpha + 0.18);
                ctx.fillStyle = ink; ctx.font = active ? '600 12px sans-serif' : '11px sans-serif';
                ctx.fillText(label, entry.x + radius + 7, entry.y + 4);
              }
            }
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = ink; ctx.font = '12px sans-serif';
          ctx.fillText('拖拽旋转 · 滚轮缩放 · 点击查看记忆', 14, height - 14);
          return !pausedRef.current && ((hover === undefined && !dragging) || drift > 0.001);
        };
        const schedule = () => {
          if (disposed || raf !== null) return;
          raf = requestAnimationFrame(() => {
            raf = null;
            if (draw()) schedule();
          });
        };
        const hit = event => {
          const rect = canvas.getBoundingClientRect();
          let best, distance = 18;
          for (const node of layoutRef.current.nodes) {
            const p = toScreen(node, width, height);
            const d = Math.hypot(p.x - (event.clientX - rect.left), p.y - (event.clientY - rect.top));
            if (d < distance) { best = node; distance = d; }
          }
          return best;
        };
        const onPointerDown = event => {
          if (pointerId !== null || event.button !== 0) return;
          pointerId = event.pointerId; dragging = true; moved = false;
          startX = lastX = event.clientX; startY = lastY = event.clientY;
          canvas.setPointerCapture?.(pointerId); canvas.style.cursor = 'grabbing';
          schedule();
        };
        const onPointerMove = event => {
          schedule();
          if (dragging) {
            if (event.pointerId !== pointerId) return;
            moved ||= Math.hypot(event.clientX - startX, event.clientY - startY) > 3;
            if (!moved) return;
            rotY += (event.clientX - lastX) * 0.008;
            camera.yaw = rotY;
            camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + (event.clientY - lastY) * 0.008));
            lastX = event.clientX; lastY = event.clientY;
          } else {
            hover = hit(event)?.id;
            canvas.style.cursor = hover === undefined ? 'grab' : 'pointer';
          }
        };
        const finishPointer = event => {
          if (!dragging || event.pointerId !== pointerId) return;
          pointerId = null; dragging = false;
          const node = event.type === 'pointerup' ? hit(event) : undefined;
          hover = event.pointerType === 'touch' ? undefined : node?.id;
          canvas.style.cursor = hover === undefined ? 'grab' : 'pointer';
          schedule();
          if (!moved && node) selectRef.current?.(node);
        };
        const onPointerLeave = () => { hover = undefined; if (!dragging) canvas.style.cursor = 'grab'; schedule(); };
        const onWheel = event => { event.preventDefault(); camera.zoom = Math.max(0.35, Math.min(2.8, camera.zoom * (event.deltaY > 0 ? 0.92 : 1.08))); schedule(); };
        const listeners = { pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: finishPointer,
          pointercancel: finishPointer, lostpointercapture: finishPointer, pointerleave: onPointerLeave, wheel: onWheel };
        for (const [type, listener] of Object.entries(listeners)) canvas.addEventListener(type, listener, type === 'wheel' ? { passive: false } : undefined);
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
        observer?.observe(canvas);
        const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)');
        colorScheme?.addEventListener?.('change', schedule);
        const themeObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
        for (let parent = canvas.parentElement; parent; parent = parent.parentElement) {
          themeObserver?.observe(parent, { attributes: true, attributeFilter: [
            'class', 'style', 'data-theme', 'data-ds-dark-theme', 'data-ds-light-theme', 'data-ds-theme-source',
          ] });
        }
        scheduleRef.current = schedule;
        schedule();
        return () => {
          disposed = true;
          scheduleRef.current = null;
          if (raf !== null) cancelAnimationFrame(raf);
          observer?.disconnect();
          themeObserver?.disconnect();
          colorScheme?.removeEventListener?.('change', schedule);
          for (const [type, listener] of Object.entries(listeners)) canvas.removeEventListener(type, listener);
          if (pointerId !== null && canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture?.(pointerId);
          canvas.style.cursor = 'grab';
        };
      }, []);
      React.useEffect(() => { scheduleRef.current?.(); }, [graph, selectedId, paused]);
      return h('canvas', { ref: canvasRef, 'aria-label': '3D 记忆星系', role: 'img', style: { width: '100%', height: '100%', display: 'block', borderRadius: 14, background: 'radial-gradient(ellipse at center, ' + dswTheme.layer + ', ' + dswTheme.layer3 + ')', cursor: 'grab', touchAction: 'none' } });
    }

    const MV_MEMORY_SCOPES = { global: ['全局', '#4e93e8'], agent: ['智能体私有', '#2ea36a'], workspace: ['工作区共享', '#d08a2a'] };
    const MV_MEMORY_KINDS = { profile: ['偏好', '#4e93e8'], decision: ['决策', '#2ea36a'], fact: ['事实', '#4a9fb5'],
      episode: ['片段', '#d08a2a'], handoff: ['交接', '#b456c8'], scene: ['场景', '#cf5f7a'] };
    const mvMemoryScopeLabel = scope => (MV_MEMORY_SCOPES[scope] ?? [scope || '记忆', '#8b93a1']);
    const mvMemoryKindLabel = kind => (MV_MEMORY_KINDS[kind] ?? [kind || '记忆', '#8b93a1']);
    const mvMemoryClarity = clarity => ({ vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象' }[clarity] || clarity || '清晰');
    function mvMemoryChip(label, color, key, solid = false) {
      return h('span', { className: 'mv-tone-chip', key, 'data-solid': solid ? 'true' : undefined,
        style: { '--mv-tone': color } }, label);
    }

    function MemoryPage({ initialAgentId = '', initialLayer = '', mvOpenDirect, closeMemorySidebar } = {}) {
      const [layer, setLayer] = React.useState(() => (initialLayer === 'agent' || initialLayer === 'workspace' || initialLayer === 'global') ? initialLayer : (initialAgentId ? 'agent' : 'global'));
      const [library, setLibrary] = React.useState(null);
      const [extraWorkspaces, setExtraWorkspaces] = React.useState([]);
      const [agentId, setAgentId] = React.useState(initialAgentId || '');
      const [workspaceId, setWorkspaceId] = React.useState('');
      const [loadedGraph, setGraph] = React.useState(null);
      const [paused, setPaused] = React.useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false);
      const [fullCanvas, setFullCanvas] = React.useState(false);
      const closeSidebar = () => {
        try { void Promise.resolve(closeMemorySidebar?.()).catch(() => {}); } catch { /* optional host service */ }
      };
      React.useEffect(closeSidebar, []);
      const [privateBackend, setPrivateBackend] = React.useState('');
      const [allowTaskRecall, setAllowTaskRecall] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detailConflict, setDetailConflict] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [results, setResults] = React.useState(null);
      const [formOpen, setFormOpen] = React.useState(false);
      const [title, setTitle] = React.useState('');
      const [text, setText] = React.useState('');
      const [scope, setScope] = React.useState(layer);
      const [busy, setBusy] = React.useState(false);
      const [syncNotice, setSyncNotice] = React.useState('');
      const [settings, setSettings] = React.useState(null);
      const [health, setHealth] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [proposals, setProposals] = React.useState([]);
      const [approvalNotice, setApprovalNotice] = React.useState('');
      const [drafts, setDrafts] = React.useState({});
      const [globalVisibility, setGlobalVisibility] = React.useState('no-group');
      const [editText, setEditText] = React.useState('');
      const [editVisibility, setEditVisibility] = React.useState('no-group');

      React.useEffect(() => {
        if (initialAgentId) {
          setLayer('agent');
          setAgentId(initialAgentId);
          setScope('agent');
        }
      }, [initialAgentId]);

      const [cue, setCue] = React.useState('');
      const agents = library?.agents ?? [];
      const realWorkspaces = React.useMemo(() => {
        const map = new Map();
        for (const ws of [...(library?.workspaces ?? []), ...extraWorkspaces]) {
          if (!ws || !ws.id || isPseudoAgentWorkspace(ws)) continue;
          if (!map.has(ws.id)) map.set(ws.id, { id: ws.id, label: ws.title || ws.name || ws.path || ws.id, path: ws.path || '' });
        }
        return [...map.values()];
      }, [library, extraWorkspaces]);

      React.useEffect(() => {
        setScope(layer);
      }, [layer]);

      React.useEffect(() => {
        if (layer === 'workspace' && !workspaceId && realWorkspaces.length > 0) {
          setWorkspaceId(realWorkspaces[0].id);
        }
      }, [layer, workspaceId, realWorkspaces]);

      const activeAgentId = layer === 'agent' ? agentId : '';
      const mvDirectAgent = agents.find(row => row.id === activeAgentId);
      const activeWorkspaceId = layer === 'workspace' ? workspaceId : '';
      const domains = (fullCanvas ? ['global', 'workspace', 'agent'] : [layer]).filter(domain =>
        domain === 'global' || (domain === 'agent' ? agentId : workspaceId));
      const view = JSON.stringify([layer, fullCanvas, fullCanvas ? agentId : activeAgentId, fullCanvas ? workspaceId : activeWorkspaceId]);
      const currentView = React.useRef(view);
      currentView.current = view;
      const graph = React.useMemo(() => loadedGraph?.view === view ? loadedGraph : { nodes: [], edges: [] }, [loadedGraph, view]);
      const searchActive = results?.view === view;
      const visibleResults = searchActive ? results.items : null;
      const visibleGraph = React.useMemo(() => {
        if (visibleResults === null) return graph;
        const ids = new Set(visibleResults.map(item => item.id));
        return { nodes: visibleResults, edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
      }, [graph, visibleResults]);
      const lifetime = React.useRef(null);
      const refreshRef = React.useRef(null);
      const detailSelection = React.useRef(0);
      const [detailCheck, setDetailCheck] = React.useState(null);
      const checkingDetail = React.useRef(null);
      const requiredEventSeq = React.useRef(0);
      const verifiedEventSeq = React.useRef(0);
      const detailVerifyFailed = React.useRef(false);
      const verifyLatestDetail = React.useRef(null);
      const detailVerified = () => !checkingDetail.current && !detailVerifyFailed.current
        && verifiedEventSeq.current >= requiredEventSeq.current;
      const savingDetail = React.useRef(false);
      const [saving, setSaving] = React.useState(false);
      const conflictRef = React.useRef(null);
      const updateConflict = conflict => {
        conflictRef.current = conflict;
        setDetailConflict(conflict);
      };
      const searchRequest = React.useRef(null);
      const requestMemory = async (path, body, signal = lifetime.current?.signal, beforeSend) => {
        if (!signal) throw new DOMException('Memory view is not mounted', 'AbortError');
        const data = await fetchJson(path, body, true, signal, beforeSend);
        signal.throwIfAborted();
        return data;
      };
      const submittedQuery = React.useRef('');
      const refresh = () => {
        // Even an initial read with no loaded body can be invalidated.
        if (selectedRef.current?.id) {
          requiredEventSeq.current++;
          void verifyLatestDetail.current();
        }
        return refreshRef.current?.request();
      };
      const selectedRef = React.useRef(selected);
      const editTextRef = React.useRef(editText);
      const editVisibilityRef = React.useRef(editVisibility);
      selectedRef.current = selected;
      editTextRef.current = editText;
      editVisibilityRef.current = editVisibility;
      const replaceDetail = item => {
        selectedRef.current = item;
        editTextRef.current = item?.content || '';
        editVisibilityRef.current = item?.visibility === 'all' ? 'all' : 'no-group';
        setSelected(item);
        setEditText(editTextRef.current);
        setEditVisibility(editVisibilityRef.current);
        updateConflict(null);
      };

      const load = async signal => {
        try {
          const [data, wsData] = await Promise.all([
            loadAgentLibrary(signal),
            requestMemory('marshal/task-rooms/workspaces', undefined, signal).catch(() => ({ workspaces: [] })),
          ]);
          if (signal.aborted) return;
          setLibrary(data);
          setExtraWorkspaces(Array.isArray(wsData?.workspaces) ? wsData.workspaces : []);
          setError('');
          setAgentId(current => current || data.agents?.[0]?.id || '');
          const firstReal = [...(data.workspaces || []), ...(wsData?.workspaces || [])].find(ws => ws && ws.id && !isPseudoAgentWorkspace(ws));
          if (firstReal) setWorkspaceId(current => current || firstReal.id);
        }
        catch (e) { if (!signal.aborted) setError(friendlyError(e, '记忆')); }
      };

      const buildScopeQuery = domain => {
        const params = new URLSearchParams({ scope: domain });
        if (domain === 'agent') params.set('agentId', agentId);
        if (domain === 'workspace') params.set('workspaceId', workspaceId);
        return '?' + params;
      };

      const refreshSelectedDetail = async () => {
        const current = selectedRef.current;
        if (!lifetime.current || !current?.id || savingDetail.current || checkingDetail.current) return;
        const controller = new AbortController();
        const { signal } = controller;
        const seq = requiredEventSeq.current;
        const selection = detailSelection.current;
        const check = { controller };
        checkingDetail.current = check;
        setDetailCheck(check);
        // Ignore responses superseded by another selection or a saved version.
        const isCurrent = () => !signal.aborted && currentView.current === view
          && detailSelection.current === selection && selectedRef.current === current && requiredEventSeq.current === seq;
        try {
          let data;
          try {
            data = await requestMemory('marshal/memory/get' + buildScopeQuery(current.scope) + '&id=' + encodeURIComponent(current.id), undefined, signal);
          } catch (error) {
            if (!isCurrent()) return;
            if (error.status !== 404) {
              // Do not unlock a potentially stale save until a retry can verify the remote version.
              detailVerifyFailed.current = true;
              setError(friendlyError(error, '核验记忆版本（请刷新后重试保存）'));
              return;
            }
            data = { item: null };
          }
          if (!isCurrent()) return;
          verifiedEventSeq.current = seq;
          detailVerifyFailed.current = false;
          const isDirty = current.scope === 'global' && (editTextRef.current !== (current.content || '') || editVisibilityRef.current !== (current.visibility === 'all' ? 'all' : 'no-group'));
          const remoteItem = data.item || null;
          const matchesDraft = Boolean(remoteItem && current.scope === 'global'
            && editTextRef.current === (remoteItem.content || '')
            && editVisibilityRef.current === (remoteItem.visibility === 'all' ? 'all' : 'no-group'));
          if (!isDirty || matchesDraft) replaceDetail(remoteItem);
          else if (!remoteItem || remoteItem.content !== current.content || remoteItem.title !== current.title || remoteItem.visibility !== current.visibility) {
            updateConflict({ remoteItem, deleted: !remoteItem, verifiedSeq: seq });
          } else updateConflict(null);
        } finally {
          if (checkingDetail.current === check) {
            checkingDetail.current = null;
            if (lifetime.current && !signal.aborted) {
              setDetailCheck(null);
              // Only the newest invalidation can commit; coalesce any queued ones.
              if (requiredEventSeq.current > seq || currentView.current !== view) void verifyLatestDetail.current();
              else setDetailLoading(false);
            }
          }
        }
      };
      verifyLatestDetail.current = refreshSelectedDetail;

      const loadGraph = async signal => {
        const [graphs, nextHealth] = await Promise.all([
          Promise.allSettled(domains.map(async domain => ({
            domain, data: await requestMemory('marshal/memory/graph' + buildScopeQuery(domain), undefined, signal),
          }))),
          domains.includes(layer) ? requestMemory('marshal/memory/health' + buildScopeQuery(layer), undefined, signal).catch(() => null) : null,
        ]);
        if (signal.aborted || currentView.current !== view) return;
        const nodes = [], edges = new Map();
        let backend = '';
        for (const result of graphs) {
          if (result.status !== 'fulfilled') continue;
          const { domain, data } = result.value;
          const scoped = (data.graph?.nodes || []).filter(node => node.scope === domain);
          // Reserve space on the canvas for each domain.
          nodes.push(...(fullCanvas ? scoped.slice(0, 140) : scoped));
          for (const edge of data.graph?.edges || []) edges.set(JSON.stringify([edge.source, edge.target]), edge);
          if (domain === layer && domain !== 'global') backend = data.privateBackend ?? '';
        }
        const ids = new Set(nodes.map(node => node.id));
        setGraph({ view, nodes, edges: [...edges.values()].filter(edge => ids.has(edge.source) && ids.has(edge.target)) });
        setPrivateBackend(backend);
        setHealth(nextHealth);
        const failure = graphs.find(result => result.status === 'rejected');
        if (failure) setError(friendlyError(failure.reason, '记忆'));
      };

      const loadProposals = async signal => {
        try {
          const data = await requestMemory('marshal/memory/proposals', undefined, signal);
          const items = data.proposals || [];
          setProposals(items);
          setDrafts(current => {
            const next = { ...current };
            for (const item of items) {
              if (next[item.id] === undefined) next[item.id] = { title: item.title, text: item.content, visibility: item.visibility === 'all' ? 'all' : 'no-group' };
            }
            return next;
          });
        }
        catch (error) {
          if (signal.aborted) return;
          setProposals([]);
          if (error && (error.code === 'sign-in-to-approve' || String(error.message || '').includes('sign-in-to-approve')))
            setApprovalNotice('请先登录机主账号后再审批全局记忆');
        }
      };

      React.useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void load(controller.signal);
        void requestMemory('marshal/memory/settings/get', undefined, controller.signal).then(setSettings).catch(() => {});
        return () => {
          lifetime.current = null;
          controller.abort();
          checkingDetail.current?.controller.abort();
        };
      }, []);
      // Catalog defaults change the loading key without changing the user's selection.
      React.useEffect(() => {
        void selectMemory(null);
      }, [layer, fullCanvas, initialAgentId]);
      React.useEffect(() => {
        const visible = createVisibleMarshalRefresh(signal => {
          setError('');
          return Promise.all([
            loadGraph(signal), loadProposals(signal),
            submittedQuery.current && !searchRequest.current ? search(submittedQuery.current, signal) : null,
          ]);
        });
        refreshRef.current = visible;
        const unsubscribe = subscribeMarshalEvents(['ready', 'memory.changed', 'incidents.changed'], () => { void refresh(); });
        void visible.request();
        return () => {
          refreshRef.current = null;
          unsubscribe();
          visible.dispose();
          searchRequest.current?.abort();
          searchRequest.current = null;
        };
      }, [view]);

      const search = async (value, refreshSignal) => {
        searchRequest.current?.abort();
        if (value.trim() === '') { searchRequest.current = null; submittedQuery.current = ''; setResults(null); return; }
        const controller = new AbortController();
        searchRequest.current = controller;
        const signal = refreshSignal ? AbortSignal.any([refreshSignal, controller.signal]) : controller.signal;
        const reads = await Promise.allSettled(domains.map(async domain => {
          const data = await requestMemory('marshal/memory/list' + buildScopeQuery(domain) + '&query=' + encodeURIComponent(value.trim()), undefined, signal);
          const scoped = (data.items || []).filter(item => item.scope === domain);
          return fullCanvas ? scoped.slice(0, 140) : scoped;
        }));
        if (searchRequest.current === controller) searchRequest.current = null;
        if (signal.aborted || currentView.current !== view) return;
        const failure = reads.find(read => read.status === 'rejected');
        if (failure) setError(friendlyError(failure.reason, '记忆检索'));
        else {
          submittedQuery.current = value;
          setResults({ view, items: reads.flatMap(read => read.value) });
        }
      };
      const submitSearch = () => {
        setError('');
        void search(query.trim());
      };

      const selectMemory = async item => {
        detailSelection.current++;
        checkingDetail.current?.controller.abort();
        checkingDetail.current = null;
        setDetailCheck(null);
        setDetailLoading(!!item);
        if (!item) { replaceDetail(null); return; }
        // Search and graph payloads are previews, not verified edit baselines.
        requiredEventSeq.current++;
        replaceDetail({ ...item, content: undefined });
        await verifyLatestDetail.current();
      };

      const create = async () => {
        if (title.trim() === '' || text.trim() === '') return;
        setBusy(true);
        try {
          if (scope === 'global') {
            await requestMemory('marshal/memory/global', { title: title.trim(), text: text.trim(), kind: 'fact', importance: 0.6, tags: [], visibility: globalVisibility });
          }
          else if (scope === 'workspace') {
            if (!workspaceId) throw new Error('请先选择一个项目工作区');
            await requestMemory('marshal/memory/remember', { workspaceId, scope: 'workspace', title: title.trim(), text: text.trim(), ...(cue.trim() ? { cue: cue.trim() } : {}), kind: 'fact', importance: 0.6, tags: [] });
          }
          else {
            if (!agentId) throw new Error('请先选择一个智能体');
            await requestMemory('marshal/memory/remember', {
              agentId, ...(workspaceId ? { workspaceId } : {}), scope: 'agent',
              title: title.trim(), text: text.trim(), ...(cue.trim() ? { cue: cue.trim() } : {}), kind: 'fact', importance: 0.6, tags: [],
              ...(privateBackend === 'mnemon' && workspaceId && allowTaskRecall ? { visibility: 'group-safe' } : {}),
            });
          }
          setTitle(''); setText(''); setCue(''); setAllowTaskRecall(false); setFormOpen(false); await refresh();
        }
        catch (e) { if (lifetime.current) setError(friendlyError(e, '写入记忆')); }
        finally { if (lifetime.current) setBusy(false); }
      };

      const forget = async item => {
        if (!item || !window.confirm('删除这条记忆？')) return;
        const selection = detailSelection.current;
        try {
          if (item.scope === 'global') await requestMemory('marshal/memory/global/forget', { id: item.id });
          else await requestMemory('marshal/memory/forget', {
            ...(item.scope === 'agent' ? { agentId } : {}),
            ...(item.scope === 'workspace' ? { workspaceId } : {}),
            id: item.id,
          });
          if (detailSelection.current === selection && selectedRef.current?.id === item.id && selectedRef.current.scope === item.scope) {
            void selectMemory(null);
          }
          await refresh();
        }
        catch (e) { if (lifetime.current) setError(friendlyError(e, '删除记忆')); }
      };

      const decideProposal = async (item, action) => {
        const draft = drafts[item.id] || { title: item.title, text: item.content, visibility: item.visibility === 'all' ? 'all' : 'no-group' };
        try {
          if (action === 'reject') await requestMemory('marshal/memory/proposals/reject', { id: item.id });
          else await requestMemory('marshal/memory/proposals/approve', { id: item.id, title: draft.title, text: draft.text, visibility: draft.visibility });
          await refresh();
        }
        catch (e) {
          if (!lifetime.current) return;
          if (e && (e.code === 'sign-in-to-approve' || String(e.message || '').includes('sign-in-to-approve')))
            setApprovalNotice('请先登录机主账号后再审批全局记忆');
          else setError(friendlyError(e, '全局记忆审批'));
        }
      };

      const loadLatestConflict = () => {
        const conflict = conflictRef.current;
        if (!conflict) return;
        if (savingDetail.current || !detailVerified() || conflict.verifiedSeq < requiredEventSeq.current) {
          void verifyLatestDetail.current();
          return;
        }
        replaceDetail(conflict.remoteItem);
      };

      const saveGlobal = async (overwrite = false) => {
        const selection = detailSelection.current;
        if (savingDetail.current || !detailVerified()) return;
        const conflict = conflictRef.current;
        if (overwrite ? !conflict || conflict.deleted || conflict.verifiedSeq < requiredEventSeq.current : !!conflict) return;
        const current = selectedRef.current;
        if (!current || current.scope !== 'global' || typeof current.content !== 'string') return;
        const seq = requiredEventSeq.current;
        const canSend = () => detailVerified() && requiredEventSeq.current === seq
          && detailSelection.current === selection && currentView.current === view && selectedRef.current === current;
        const staleWrite = new DOMException('Memory edit baseline changed', 'AbortError');
        const text = editTextRef.current, visibility = editVisibilityRef.current;
        savingDetail.current = true;
        setSaving(true);
        let writeCompleted = false;
        try {
          if (!canSend()) return;
          const saved = await requestMemory('marshal/memory/global/update', { id: current.id, title: conflict?.remoteItem?.title ?? current.title, text, visibility }, lifetime.current?.signal, () => {
            if (!canSend()) throw staleWrite;
          });
          writeCompleted = true;
          if (detailSelection.current === selection && selectedRef.current === current && currentView.current === view && requiredEventSeq.current === seq) {
            selectedRef.current = saved.item;
            setSelected(saved.item);
            if (editTextRef.current === text) setEditText(editTextRef.current = saved.item.content || '');
            if (editVisibilityRef.current === visibility) setEditVisibility(editVisibilityRef.current = saved.item.visibility === 'all' ? 'all' : 'no-group');
            updateConflict(null);
          }
        }
        catch (e) { if (lifetime.current && e !== staleWrite) setError(friendlyError(e, '编辑全局记忆')); return; }
        finally {
          savingDetail.current = false;
          if (lifetime.current) {
            setSaving(false);
            if (verifiedEventSeq.current < requiredEventSeq.current) void verifyLatestDetail.current();
          }
        }
        if (requiredEventSeq.current === seq) await refresh();
        else await refreshRef.current?.request();
      };
      const saveBlocked = saving || !!detailCheck || !detailVerified();

      const layerTabs = [
        ['global', '全局记忆与审批' + (proposals.length > 0 ? ' (' + proposals.length + ')' : '')],
        ['agent', '智能体私有记忆'],
        ['workspace', '工作区共享记忆'],
      ];

      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h('div', { style: { padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #8883', flexWrap: 'wrap' } },
          h('div', { role: 'tablist', 'aria-label': '三层记忆视图', style: { display: 'flex', alignItems: 'center', gap: 4, padding: 3, borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer } },
            layerTabs.map(([key, label]) => h('button', {
              key, type: 'button', role: 'tab', 'aria-selected': layer === key,
              style: tabStyle(layer === key),
              onClick: () => setLayer(key),
            }, label))),
          (fullCanvas || layer === 'agent') && h('select', { 'aria-label': '智能体', value: agentId, disabled: busy, onChange: event => {
            setAgentId(event.target.value); void selectMemory(null); setResults(null);
            setPrivateBackend(''); setHealth(null); setAllowTaskRecall(false); setError('');
          }, style: { ...uiInput, width: 170 } },
            agents.length === 0 ? h('option', { value: '' }, '暂无智能体') : agents.map(item => h('option', { key: item.id, value: item.id }, item.name))),
          (fullCanvas || layer === 'workspace') && h('select', { 'aria-label': '项目工作区', value: workspaceId, disabled: busy, onChange: event => {
            setWorkspaceId(event.target.value); void selectMemory(null); setResults(null);
            setHealth(null); setError('');
          }, style: { ...uiInput, width: 220 } },
            realWorkspaces.length === 0 ? h('option', { value: '' }, '暂无项目工作区') : realWorkspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.label))),
          layer !== 'global' && privateBackend === 'mnemon' && h('span', { style: { color: '#10b981', fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid color-mix(in srgb, #10b981 35%, transparent)', background: 'color-mix(in srgb, #10b981 12%, transparent)' } }, 'Mnemon · 意图图谱 + 推索引引擎'),
          h('input', { value: query, onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Enter') submitSearch(); }, placeholder: fullCanvas ? '搜索全域记忆…' : '搜索当前层级记忆…', style: { ...uiInput, width: 190 } }),
          h('button', { type: 'button', style: uiButton(false), onClick: submitSearch }, '搜索'),
          h('div', { className: 'mv-actions mv-toolbar-group' },
            h('button', { type: 'button', style: uiButton(false), onClick: () => setPaused(value => !value) }, paused ? '恢复漂移' : '暂停漂移'),
            h('button', { type: 'button', style: uiButton(false), onClick: () => {
              if (!fullCanvas) { closeSidebar(); setFormOpen(false); setSettingsOpen(false); }
              setFullCanvas(!fullCanvas);
            } }, fullCanvas ? '退出全画布' : '全画布'),
            mvOpenDirect && mvDirectAgent && h(mvDirectLink, { key: activeAgentId, agent: mvDirectAgent, open: mvOpenDirect }),
            !fullCanvas && h('button', { type: 'button', style: uiButton(false), onClick: () => { setScope(layer); setFormOpen(value => !value); } }, '＋ 记忆'),
            !fullCanvas && h('button', { type: 'button', style: uiButton(false), onClick: () => setSettingsOpen(value => !value) }, '设置')),
          h('div', { className: 'mv-actions mv-toolbar-group' },
            h('button', { type: 'button', style: uiButton(false), onClick: async () => { setSyncNotice('同步中…'); try { const result = await requestMemory('marshal/memory/sync', { ...(activeAgentId ? { agentId: activeAgentId } : {}), ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}) }); setSyncNotice('推送 ' + (result.pushed ?? 0) + ' · 拉取 ' + (result.pulled ?? 0)); await refresh(); } catch (e) { if (lifetime.current) setSyncNotice(String(e.message || e)); } } }, '同步'),
            layer === 'global' && h('button', { type: 'button', style: uiButton(false), onClick: async () => { setSyncNotice('迁移旧同步…'); try { const result = await requestMemory('marshal/memory/migrate-legacy', {}); setSyncNotice(result.migrated ? '已绑定 ' + result.migrated + ' 条旧记录' : '没有待迁移的旧记录'); } catch (e) { if (!lifetime.current) return; if (e && (e.code === 'sign-in-to-approve' || String(e.message || '').includes('sign-in-to-approve'))) setApprovalNotice('请先登录机主账号后再审批全局记忆'); setSyncNotice(String(e.message || e)); } } }, '迁移旧同步'),
            h('button', { type: 'button', style: uiButton(false), onClick: () => { void refresh(); } }, '刷新')),
          h('span', { className: 'mv-tone-chip', 'aria-label': '星系统计',
            style: { '--mv-tone': '#8b93a1', marginLeft: 'auto' } },
            visibleGraph.nodes.length + ' 节点 · ' + visibleGraph.edges.length + ' 关联' +
            (health?.health?.length ? ' · 模糊 ' + health.health.reduce((sum, item) => sum + (item.fuzzy || 0), 0) + ' · 档案 ' + health.health.reduce((sum, item) => sum + (item.archived || 0), 0) : ''))),
        syncNotice !== '' && h('div', { style: { padding: '6px 18px', fontSize: 11, color: dswTheme.dim } }, syncNotice),
        !fullCanvas && settingsOpen && settings && h('div', { style: { padding: '10px 18px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, borderBottom: '1px solid #8883' } },
          [['autoSummary', '会话结束自动摘要'], ['autoRecall', '每轮自动召回'], ['allowGroupQuote', '群聊允许引用私有记忆']].map(([key, label]) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: settings[key] !== false, onChange: async event => { const next = { ...settings, [key]: event.target.checked }; setSettings(next); try { const saved = await requestMemory('marshal/memory/settings', { [key]: event.target.checked }); setSettings(saved.settings); } catch { /* keep local */ } } }), label)),
          h('span', { style: { color: dswTheme.dim, marginLeft: 'auto' } }, '摘要模型：空 = 本地启发式')),
        !fullCanvas && settingsOpen && settings && h('div', { style: { padding: '0 18px 10px', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, borderBottom: '1px solid #8883' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, '摘要 provider', h('input', { defaultValue: settings.summaryProvider ?? '', placeholder: 'empty = 本地', onBlur: async event => { const value = event.target.value.trim(); try { const saved = await requestMemory('marshal/memory/settings', { summaryProvider: value }); setSettings(saved.settings); } catch { /* keep local */ } }, style: { ...uiInput, width: 150 } })),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, '摘要模型', h('input', { defaultValue: settings.summaryModel ?? '', placeholder: 'empty = 本地', onBlur: async event => { const value = event.target.value.trim(); try { const saved = await requestMemory('marshal/memory/settings', { summaryModel: value }); setSettings(saved.settings); } catch { /* keep local */ } }, style: { ...uiInput, width: 180 } }))),
        error !== '' && h('div', { style: { padding: '8px 18px', color: dswTheme.danger, fontSize: 12 } }, error),
        !fullCanvas && layer === 'global' && h('section', { style: { maxHeight: '30%', overflow: 'auto', padding: '10px 18px', borderBottom: '1px solid #8883', display: 'grid', gap: 8 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '全局记忆审批' + (proposals.length > 0 ? ' · ' + proposals.length + ' 条待处理' : '')),
          approvalNotice !== '' && h('div', { style: { fontSize: 12, color: dswTheme.danger } }, approvalNotice),
          proposals.length === 0
            ? h('div', { style: { fontSize: 12, color: dswTheme.dim } }, '没有待审批的全局记忆。智能体提交的全局偏好会停在这里，同意后才会生效。')
            : proposals.map(item => {
              const draft = drafts[item.id] || { title: item.title, text: item.content, visibility: item.visibility === 'all' ? 'all' : 'no-group' };
              const patch = next => setDrafts(current => ({ ...current, [item.id]: { ...draft, ...next } }));
              return h('div', { key: item.id, style: { display: 'grid', gap: 6, padding: 8, border: '1px solid #8883', borderRadius: 10 } },
                h('div', { style: { fontSize: 11, color: dswTheme.dim } }, (item.agentId || '未知智能体') + ' · ' + new Date(item.createdAt || Date.now()).toLocaleString()),
                h('input', { value: draft.title, onChange: event => patch({ title: event.target.value }), style: uiInput }),
                h('textarea', { value: draft.text, rows: 3, onChange: event => patch({ text: event.target.value }), style: { ...uiInput, resize: 'vertical' } }),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('select', { value: draft.visibility, onChange: event => patch({ visibility: event.target.value }), style: { ...uiInput, width: 140 } }, h('option', { value: 'all' }, '所有会话'), h('option', { value: 'no-group' }, '仅单聊')),
                  h('button', { type: 'button', style: uiButton(true), onClick: () => { void decideProposal(item, 'approve'); } }, '同意'),
                  h('button', { type: 'button', style: uiButton(false), onClick: () => { void decideProposal(item, 'reject'); } }, '拒绝')));
            })),
        !fullCanvas && formOpen && h('div', { style: { padding: '12px 18px', display: 'grid', gap: 8, borderBottom: '1px solid #8883' } },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { value: title, onChange: event => setTitle(event.target.value), placeholder: '标题', style: { ...uiInput, flex: 1, minWidth: 180 } }),
            h('select', { value: scope, onChange: event => setScope(event.target.value), style: { ...uiInput, width: 140 } },
              h('option', { value: 'global' }, '全局记忆'),
              h('option', { value: 'agent' }, '智能体私有'),
              h('option', { value: 'workspace' }, '工作区共享')),
            scope === 'global' && h('select', { value: globalVisibility, onChange: event => setGlobalVisibility(event.target.value), style: { ...uiInput, width: 130 } }, h('option', { value: 'all' }, '所有会话'), h('option', { value: 'no-group' }, '仅单聊'))),
          scope !== 'global' && h('input', { value: cue, onChange: event => setCue(event.target.value), placeholder: '触发场景 Cue（可选，例如：改看板状态机或发版前）', style: uiInput }),
          h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 3, placeholder: '记忆内容…', style: { ...uiInput, resize: 'vertical' } }),
          scope === 'agent' && privateBackend === 'mnemon' && workspaceId && h('label', { style: { fontSize: 12 } },
            h('input', { type: 'checkbox', checked: allowTaskRecall, onChange: event => setAllowTaskRecall(event.target.checked) }),
            ' 允许本智能体在所选项目工作区的工单中使用这条记忆'),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h('button', { type: 'button', style: uiButton(false), onClick: () => setFormOpen(false) }, '取消'), h('button', { type: 'button', disabled: busy, style: uiButton(true), onClick: () => { void create(); } }, busy ? '保存中…' : '保存'))),
        visibleResults !== null && h('div', { style: { maxHeight: 180, overflow: 'auto', borderBottom: '1px solid #8883', padding: '8px 18px', display: 'grid', gap: 4 } },
          visibleResults.length === 0 ? h('div', { style: { fontSize: 12, color: dswTheme.dim } }, '没有匹配的记忆') : visibleResults.map(item => h('button', { key: item.id, type: 'button', onClick: () => { void selectMemory(item); }, style: { textAlign: 'left', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '5px 0' } }, '[' + item.scope + '] ' + item.title))),
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', padding: 14, gap: 14 } },
          h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, borderRadius: 14, overflow: 'hidden', border: '1px solid #8883' } }, h(MemoryGalaxy, { graph: visibleGraph, paused, selectedId: selected?.id, onSelect: selectMemory })),
          selected && h('aside', { className: 'mv-memory-detail', 'aria-label': '记忆详情' },
            h('div', { className: 'mv-memory-head' },
              h('div', { className: 'mv-tag-row' },
                mvMemoryChip(mvMemoryScopeLabel(selected.scope)[0], mvMemoryScopeLabel(selected.scope)[1], 'scope', true),
                mvMemoryChip(mvMemoryKindLabel(selected.kind)[0], mvMemoryKindLabel(selected.kind)[1], 'kind'),
                selected.scope === 'global' && mvMemoryChip(selected.visibility === 'all' ? '所有会话' : '仅单聊',
                  selected.visibility === 'all' ? '#2ea36a' : '#8b93a1', 'visibility'),
                selected.pinned && mvMemoryChip('已固定', '#d08a2a', 'pinned')),
              h('h3', { className: 'mv-memory-title' }, selected.title),
              h('div', { className: 'mv-memory-meta' },
                '清晰度 ' + mvMemoryClarity(selected.clarity),
                ' · 重要性 ' + Math.round((selected.importance || 0) * 100) + '%',
                ' · 访问 ' + (selected.accessCount || 0) + ' 次')),
            selected.cue && h('div', { className: 'mv-memory-cue' }, '触发场景 · ' + selected.cue),
            detailLoading ? h('p', { role: 'status', className: 'mv-muted' }, '正在读取记忆…') : selected.scope === 'global'
              ? h('div', { style: { display: 'grid', gap: 8 } },
                h('textarea', { value: editText, 'aria-label': '记忆正文', onChange: event => setEditText(editTextRef.current = event.target.value), rows: 6, style: { ...uiInput, resize: 'vertical' } }),
                h('select', { value: editVisibility, 'aria-label': '记忆可见性', onChange: event => setEditVisibility(editVisibilityRef.current = event.target.value), style: uiInput }, h('option', { value: 'all' }, '所有会话'), h('option', { value: 'no-group' }, '仅单聊')),
                detailConflict && h('div', { role: 'alert', className: 'mv-memory-conflict' },
                  h('p', null, detailConflict.deleted ? '远端记忆已被删除，本地草稿仍保留。' : '远端记忆已更新，本地草稿仍保留。'),
                  h('div', { className: 'mv-actions' },
                    h('button', { type: 'button', style: uiButton(false), disabled: saveBlocked, onClick: loadLatestConflict }, '载入最新版本'),
                    !detailConflict.deleted && h('button', { type: 'button', style: uiButton(false), disabled: saveBlocked, onClick: () => { void saveGlobal(true); } }, '覆盖保存'))),
                h('button', { type: 'button', style: uiButton(true), disabled: saveBlocked || !!detailConflict || typeof selected.content !== 'string', onClick: () => { void saveGlobal(); } }, '保存全局记忆'))
              : h('p', { className: 'mv-memory-body' }, selected.content),
            h('div', { className: 'mv-tag-row', style: { marginTop: 12 } }, (selected.tags || []).map(tag =>
              mvMemoryChip(tag, '#8b93a1', 'tag-' + tag))),
            h('div', { className: 'mv-actions', style: { marginTop: 16 } },
              h('button', { type: 'button', style: uiButton(false), onClick: () => { void forget(selected); } }, '删除'),
              h('button', { type: 'button', style: uiButton(false), onClick: () => { void selectMemory(null); } }, '关闭')))),
        graph.nodes.length === 0 && !searchActive && h('div', { style: { padding: '0 18px 18px', fontSize: 12, color: dswTheme.dim } },
          fullCanvas ? '当前没有可显示的记忆。' : layer === 'global' ? '还没有全局记忆。可点“＋ 记忆”写入，或审批智能体提交的偏好。'
            : layer === 'workspace' ? '所选项目工作区还没有共享记忆。工单总结会自动沉淀到这里，也可手动写入。'
              : '该智能体还没有私有记忆。会话结束后会自动生成摘要，也可点“＋ 记忆”手动写入。'));
    }

