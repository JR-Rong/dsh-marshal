    function MemoryGalaxy({ graph, selectedId, onSelect }) {
      const canvasRef = React.useRef(null);
      const stateRef = React.useRef(null);
      const selectRef = React.useRef(onSelect);
      selectRef.current = onSelect;
      const selectedRef = React.useRef(selectedId);
      selectedRef.current = selectedId;
      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !graph) return undefined;
        const nodes = (graph.nodes || []).slice(0, 420).map((node, index) => {
          const hash = (value) => { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
          const h = hash(node.id || String(index));
          const angle = (h % 1000) / 1000 * Math.PI * 2;
          const radius = 70 + ((h >>> 10) % 1000) / 1000 * 300;
          return { ...node, x: Math.cos(angle) * radius, y: ((h >>> 20) % 1000) / 1000 * 420 - 210, z: Math.sin(angle) * radius, vx: 0, vy: 0, vz: 0 };
        });
        const ids = new Map(nodes.map((node, index) => [node.id, index]));
        const edges = (graph.edges || []).map(edge => ({ ...edge, a: ids.get(edge.source), b: ids.get(edge.target) })).filter(edge => edge.a !== undefined && edge.b !== undefined && edge.a !== edge.b).slice(0, 1400);
        for (let iteration = 0; iteration < 110; iteration++) {
          for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
              const b = nodes[j];
              let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
              let d2 = dx * dx + dy * dy + dz * dz + 12;
              const force = 5200 / d2;
              const d = Math.sqrt(d2);
              dx /= d; dy /= d; dz /= d;
              a.vx += dx * force; a.vy += dy * force; a.vz += dz * force;
              b.vx -= dx * force; b.vy -= dy * force; b.vz -= dz * force;
            }
            a.vx -= a.x * 0.0007; a.vy -= a.y * 0.0007; a.vz -= a.z * 0.0007;
          }
          for (const edge of edges) {
            const a = nodes[edge.a], b = nodes[edge.b];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
            const force = (d - 170) * 0.008 * (0.4 + Number(edge.weight || 0.4));
            const fx = dx / d * force, fy = dy / d * force, fz = dz / d * force;
            a.vx += fx; a.vy += fy; a.vz += fz;
            b.vx -= fx; b.vy -= fy; b.vz -= fz;
          }
          for (const node of nodes) { node.vx *= 0.72; node.vy *= 0.72; node.vz *= 0.72; node.x += node.vx; node.y += node.vy; node.z += node.vz; }
        }
        let maxRadius = 1;
        for (const node of nodes) maxRadius = Math.max(maxRadius, Math.hypot(node.x, node.y, node.z));
        const spread = nodes.length <= 4 ? 360 : 300;
        for (const node of nodes) { const factor = spread / maxRadius; node.x *= factor; node.y *= factor; node.z *= factor; }
        const stars = Array.from({ length: 220 }, (_, index) => ({ x: (index * 73 % 997) / 997, y: (index * 151 % 991) / 991, r: (index % 7) / 7 * 1.2 + 0.2, phase: index }));
        const labelIds = new Set([...nodes].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (Number(b.importance) - Number(a.importance))).slice(0, 8).map(node => node.id));
        const camera = { yaw: 0.35, pitch: -0.16, zoom: 1, auto: true, dragging: false, moved: false, lastX: 0, lastY: 0, hover: undefined };
        stateRef.current = { nodes, edges, stars, camera, width: 0, height: 0 };
        let raf = 0;
        let disposed = false;
        const toScreen = (node, width, height) => {
          const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
          const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
          let x = node.x * cy - node.z * sy;
          let z = node.x * sy + node.z * cy;
          let y = node.y * cp - z * sp;
          z = node.y * sp + z * cp;
          const focal = 900;
          const scale = focal / (focal + z) * camera.zoom;
          return { x: width / 2 + x * scale, y: height / 2 + y * scale, scale, depth: z };
        };
        const draw = () => {
          if (disposed) return;
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const width = canvas.clientWidth || 600, height = canvas.clientHeight || 480;
          if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
          }
          stateRef.current.width = width; stateRef.current.height = height;
          const ctx = canvas.getContext('2d');
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
          gradient.addColorStop(0, '#111827'); gradient.addColorStop(1, '#05070d');
          ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
          for (const star of stars) {
            const alpha = 0.18 + 0.35 * (0.5 + 0.5 * Math.sin((performance.now() / 2400) + star.phase));
            ctx.fillStyle = 'rgba(180,210,255,' + alpha + ')';
            ctx.beginPath(); ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2); ctx.fill();
          }
          if (camera.auto && !camera.dragging) camera.yaw += 0.00045;
          const projected = nodes.map(node => ({ node, ...toScreen(node, width, height) })).sort((a, b) => b.depth - a.depth);
          for (const edge of edges) {
            const a = projected.find(entry => entry.node === nodes[edge.a]);
            const b = projected.find(entry => entry.node === nodes[edge.b]);
            if (!a || !b) continue;
            ctx.strokeStyle = edge.relation === 'session' ? 'rgba(120,180,255,0.10)' : 'rgba(160,140,255,0.13)';
            ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
          let hover = undefined;
          for (const entry of projected) {
            const node = entry.node;
            const base = 3.2 + Math.sqrt(Math.max(0.01, Number(node.importance))) * 8 + Math.log1p(Number(node.accessCount || 0)) * 1.6;
            const radius = Math.max(2, base * entry.scale);
            const clarityAlpha = node.clarity === 'fuzzy' ? 0.5 : node.clarity === 'trace' ? 0.28 : node.clarity === 'clear' ? 0.85 : 1;
            const alpha = Math.max(0.12, Math.min(1, 1 - (entry.depth + 350) / 900)) * clarityAlpha;
            const colors = { profile: '#f6c35c', decision: '#5aa7ff', fact: '#4fd1c5', episode: '#b18cff', handoff: '#ff9f5a', scene: '#7bd88f' };
            const color = colors[node.kind] || '#8fb4ff';
            if (selectedRef.current === node.id) {
              ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.4;
              ctx.beginPath(); ctx.arc(entry.x, entry.y, radius + 5, 0, Math.PI * 2); ctx.stroke();
            }
            const glow = ctx.createRadialGradient(entry.x, entry.y, 0, entry.x, entry.y, radius * 3.2);
            glow.addColorStop(0, color); glow.addColorStop(0.24, color + '55'); glow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = alpha * 0.55; ctx.fillStyle = glow;
            ctx.beginPath(); ctx.arc(entry.x, entry.y, radius * 3.2, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = alpha; ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(entry.x, entry.y, radius, 0, Math.PI * 2); ctx.fill();
            if (node.pinned) { ctx.strokeStyle = 'rgba(255,220,150,0.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(entry.x, entry.y, radius + 3, 0, Math.PI * 2); ctx.stroke(); }
            if (camera.hover === node.id || selectedRef.current === node.id || labelIds.has(node.id)) {
              hover = entry;
              ctx.globalAlpha = 0.95; ctx.fillStyle = '#e8edf7'; ctx.font = '11px sans-serif';
              const label = String(node.title || '').slice(0, 42);
              ctx.fillText(label, entry.x + radius + 7, entry.y + 3);
            }
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(200,215,235,0.55)'; ctx.font = '11px sans-serif';
          ctx.fillText(nodes.length + ' memories · ' + edges.length + ' links · drag to orbit · wheel to zoom', 14, height - 14);
          raf = requestAnimationFrame(draw);
        };
        const onPointerDown = event => { camera.dragging = true; camera.moved = false; camera.lastX = event.clientX; camera.lastY = event.clientY; canvas.setPointerCapture?.(event.pointerId); canvas.style.cursor = 'grabbing'; };
        const onPointerMove = event => {
          if (camera.dragging) {
            const dx = event.clientX - camera.lastX, dy = event.clientY - camera.lastY;
            if (Math.abs(dx) + Math.abs(dy) > 2) camera.moved = true;
            camera.yaw += dx * 0.008; camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + dy * 0.008));
            camera.lastX = event.clientX; camera.lastY = event.clientY;
            return;
          }
          const rect = canvas.getBoundingClientRect();
          const mx = event.clientX - rect.left, my = event.clientY - rect.top;
          let best; let bestDistance = 18;
          for (const node of nodes) {
            const p = toScreen(node, stateRef.current.width, stateRef.current.height);
            const distance = Math.hypot(p.x - mx, p.y - my);
            if (distance < bestDistance) { best = node; bestDistance = distance; }
          }
          camera.hover = best?.id;
          canvas.style.cursor = best ? 'pointer' : 'grab';
        };
        const onPointerUp = event => {
          if (camera.dragging && !camera.moved) {
            const rect = canvas.getBoundingClientRect();
            const mx = event.clientX - rect.left, my = event.clientY - rect.top;
            let best; let bestDistance = 24;
            for (const node of nodes) { const p = toScreen(node, stateRef.current.width, stateRef.current.height); const distance = Math.hypot(p.x - mx, p.y - my); if (distance < bestDistance) { best = node; bestDistance = distance; } }
            if (best) selectRef.current?.(best);
          }
          camera.dragging = false; canvas.style.cursor = 'grab';
        };
        const onWheel = event => { event.preventDefault(); camera.zoom = Math.max(0.35, Math.min(2.8, camera.zoom * (event.deltaY > 0 ? 0.92 : 1.08))); };
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointerleave', () => { camera.dragging = false; });
        canvas.addEventListener('wheel', onWheel, { passive: false });
        const observer = new ResizeObserver(() => {});
        observer.observe(canvas);
        raf = requestAnimationFrame(draw);
        return () => { disposed = true; cancelAnimationFrame(raf); observer.disconnect(); canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointermove', onPointerMove); canvas.removeEventListener('pointerup', onPointerUp); canvas.removeEventListener('wheel', onWheel); };
      }, [graph]);
      return h('canvas', { ref: canvasRef, style: { width: '100%', height: '100%', display: 'block', borderRadius: 14, background: '#05070d', cursor: 'grab', touchAction: 'none' } });
    }

    function MemoryPage({ initialAgentId = '', initialLayer = '', mvOpenDirect } = {}) {
      const [layer, setLayer] = React.useState(() => (initialLayer === 'agent' || initialLayer === 'workspace' || initialLayer === 'global') ? initialLayer : (initialAgentId ? 'agent' : 'global'));
      const [library, setLibrary] = React.useState(null);
      const [extraWorkspaces, setExtraWorkspaces] = React.useState([]);
      const [agentId, setAgentId] = React.useState(initialAgentId || '');
      const [workspaceId, setWorkspaceId] = React.useState('');
      const [graph, setGraph] = React.useState({ nodes: [], edges: [] });
      const [privateBackend, setPrivateBackend] = React.useState('');
      const [allowTaskRecall, setAllowTaskRecall] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
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
        setSelected(null);
        setResults(null);
      }, [layer]);

      React.useEffect(() => {
        if (layer === 'workspace' && !workspaceId && realWorkspaces.length > 0) {
          setWorkspaceId(realWorkspaces[0].id);
        }
      }, [layer, workspaceId, realWorkspaces]);

      const activeAgentId = layer === 'agent' ? agentId : '';
      const mvDirectAgent = agents.find(row => row.id === activeAgentId);
      const activeWorkspaceId = layer === 'workspace' ? workspaceId : '';
      const view = JSON.stringify([layer, activeAgentId, activeWorkspaceId]);
      const currentView = React.useRef(view);
      currentView.current = view;
      const graphRequest = React.useRef(0);
      const queryRequest = React.useRef(0);

      const load = async () => {
        try {
          const [data, wsData] = await Promise.all([
            loadAgentLibrary(),
            fetchJson('marshal/task-rooms/workspaces', undefined, true).catch(() => ({ workspaces: [] })),
          ]);
          setLibrary(data);
          setExtraWorkspaces(Array.isArray(wsData?.workspaces) ? wsData.workspaces : []);
          setError('');
          setAgentId(current => current || data.agents?.[0]?.id || '');
          const firstReal = [...(data.workspaces || []), ...(wsData?.workspaces || [])].find(ws => ws && ws.id && !isPseudoAgentWorkspace(ws));
          if (firstReal) setWorkspaceId(current => current || firstReal.id);
        }
        catch (e) { setError(friendlyError(e, '记忆')); }
      };

      const buildScopeQuery = () => {
        const parts = [];
        if (activeAgentId) parts.push('agentId=' + encodeURIComponent(activeAgentId));
        if (activeWorkspaceId) parts.push('workspaceId=' + encodeURIComponent(activeWorkspaceId));
        parts.push('scope=' + encodeURIComponent(layer));
        return '?' + parts.join('&');
      };

      const loadGraph = async () => {
        if (layer === 'agent' && !activeAgentId) { setGraph({ nodes: [], edges: [] }); return; }
        if (layer === 'workspace' && !activeWorkspaceId) { setGraph({ nodes: [], edges: [] }); return; }
        const request = ++graphRequest.current;
        const target = buildScopeQuery();
        try {
          const [data, nextHealth] = await Promise.all([
            fetchJson('marshal/memory/graph' + target),
            fetchJson('marshal/memory/health' + target).catch(() => null),
          ]);
          if (currentView.current !== view || request !== graphRequest.current) return;
          const rawGraph = data.graph || { nodes: [], edges: [] };
          const nodes = (rawGraph.nodes || []).filter(node => node.scope === layer);
          const idSet = new Set(nodes.map(n => n.id));
          const edges = (rawGraph.edges || []).filter(edge => idSet.has(edge.source) && idSet.has(edge.target));
          setGraph({ nodes, edges });
          setPrivateBackend(layer === 'global' ? '' : (data.privateBackend ?? ''));
          setHealth(nextHealth);
          setError('');
        }
        catch (e) { if (currentView.current === view && request === graphRequest.current) setError(friendlyError(e, '记忆')); }
      };

      const loadProposals = async () => {
        try {
          const data = await fetchJson('marshal/memory/proposals');
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
          setProposals([]);
          if (error && (error.code === 'sign-in-to-approve' || String(error.message || '').includes('sign-in-to-approve')))
            setApprovalNotice('请先登录机主账号后再审批全局记忆');
        }
      };

      React.useEffect(() => { void load(); void fetchJson('marshal/memory/settings/get').then(setSettings).catch(() => {}); void loadProposals(); }, []);
      React.useEffect(() => { void loadGraph(); }, [layer, activeAgentId, activeWorkspaceId]);

      const search = async () => {
        const request = ++queryRequest.current;
        if (query.trim() === '') { setResults(null); return; }
        try {
          const data = await fetchJson('marshal/memory/list' + buildScopeQuery() + '&query=' + encodeURIComponent(query));
          if (currentView.current !== view || request !== queryRequest.current) return;
          setResults((data.items || []).filter(item => item.scope === layer));
          setError('');
        }
        catch (e) { if (currentView.current === view && request === queryRequest.current) setError(friendlyError(e, '记忆检索')); }
      };

      const create = async () => {
        if (title.trim() === '' || text.trim() === '') return;
        setBusy(true);
        try {
          if (scope === 'global') {
            await fetchJson('marshal/memory/global', { title: title.trim(), text: text.trim(), kind: 'fact', importance: 0.6, tags: [], visibility: globalVisibility });
          }
          else if (scope === 'workspace') {
            if (!workspaceId) throw new Error('请先选择一个项目工作区');
            await fetchJson('marshal/memory/remember', { workspaceId, scope: 'workspace', title: title.trim(), text: text.trim(), ...(cue.trim() ? { cue: cue.trim() } : {}), kind: 'fact', importance: 0.6, tags: [] });
          }
          else {
            if (!agentId) throw new Error('请先选择一个智能体');
            await fetchJson('marshal/memory/remember', {
              agentId, ...(workspaceId ? { workspaceId } : {}), scope: 'agent',
              title: title.trim(), text: text.trim(), ...(cue.trim() ? { cue: cue.trim() } : {}), kind: 'fact', importance: 0.6, tags: [],
              ...(privateBackend === 'mnemon' && workspaceId && allowTaskRecall ? { visibility: 'group-safe' } : {}),
            });
          }
          setTitle(''); setText(''); setCue(''); setAllowTaskRecall(false); setFormOpen(false); await loadGraph();
        }
        catch (e) { setError(friendlyError(e, '写入记忆')); }
        finally { setBusy(false); }
      };

      const forget = async item => {
        if (!item || !window.confirm('删除这条记忆？')) return;
        try {
          if (item.scope === 'global') await fetchJson('marshal/memory/global/forget', { id: item.id });
          else await fetchJson('marshal/memory/forget', {
            ...(item.scope === 'agent' ? { agentId } : {}),
            ...(item.scope === 'workspace' ? { workspaceId } : {}),
            id: item.id,
          });
          setSelected(null); setResults(null); await loadGraph();
        }
        catch (e) { setError(friendlyError(e, '删除记忆')); }
      };

      const decideProposal = async (item, action) => {
        const draft = drafts[item.id] || { title: item.title, text: item.content, visibility: item.visibility === 'all' ? 'all' : 'no-group' };
        try {
          if (action === 'reject') await fetchJson('marshal/memory/proposals/reject', { id: item.id });
          else await fetchJson('marshal/memory/proposals/approve', { id: item.id, title: draft.title, text: draft.text, visibility: draft.visibility });
          await loadProposals();
          await loadGraph();
        }
        catch (e) {
          if (e && (e.code === 'sign-in-to-approve' || String(e.message || '').includes('sign-in-to-approve')))
            setApprovalNotice('请先登录机主账号后再审批全局记忆');
          else setError(friendlyError(e, '全局记忆审批'));
        }
      };

      const saveGlobal = async () => {
        if (!selected || selected.scope !== 'global') return;
        try {
          const saved = await fetchJson('marshal/memory/global/update', { id: selected.id, title: selected.title, text: editText, visibility: editVisibility });
          setSelected(saved.item);
          await loadGraph();
        }
        catch (e) { setError(friendlyError(e, '编辑全局记忆')); }
      };

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
          layer === 'agent' && h('select', { value: agentId, disabled: busy, onChange: event => {
            setAgentId(event.target.value); setSelected(null); setResults(null); setGraph({ nodes: [], edges: [] });
            setPrivateBackend(''); setHealth(null); setAllowTaskRecall(false); setError('');
          }, style: { ...uiInput, width: 170 } },
            agents.length === 0 ? h('option', { value: '' }, '暂无智能体') : agents.map(item => h('option', { key: item.id, value: item.id }, item.name))),
          layer === 'workspace' && h('select', { value: workspaceId, disabled: busy, onChange: event => {
            setWorkspaceId(event.target.value); setSelected(null); setResults(null); setGraph({ nodes: [], edges: [] });
            setHealth(null); setError('');
          }, style: { ...uiInput, width: 220 } },
            realWorkspaces.length === 0 ? h('option', { value: '' }, '暂无项目工作区') : realWorkspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.label))),
          layer !== 'global' && privateBackend === 'mnemon' && h('span', { style: { color: '#10b981', fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid color-mix(in srgb, #10b981 35%, transparent)', background: 'color-mix(in srgb, #10b981 12%, transparent)' } }, 'Mnemon · 意图图谱 + 推索引引擎'),
          h('input', { value: query, onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Enter') void search(); }, placeholder: '搜索当前层级记忆…', style: { ...uiInput, width: 190 } }),
          h('button', { type: 'button', style: uiButton(false), onClick: () => { void search(); } }, '搜索'),
          mvOpenDirect && mvDirectAgent && h(mvDirectLink, { key: activeAgentId, agent: mvDirectAgent, open: mvOpenDirect }),
          h('button', { type: 'button', style: uiButton(false), onClick: () => { setScope(layer); setFormOpen(value => !value); } }, '＋ 记忆'),
          h('button', { type: 'button', style: uiButton(false), onClick: () => setSettingsOpen(value => !value) }, '设置'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, color: dswTheme.dim } }, graph.nodes.length + ' 个节点 · ' + graph.edges.length + ' 条关联' + (health?.health?.length ? ' · 模糊 ' + health.health.reduce((sum, item) => sum + (item.fuzzy || 0), 0) + ' · 档案 ' + health.health.reduce((sum, item) => sum + (item.archived || 0), 0) : '')),
          h('button', { type: 'button', style: uiButton(false), onClick: async () => { setSyncNotice('同步中…'); try { const result = await fetchJson('marshal/memory/sync', { ...(activeAgentId ? { agentId: activeAgentId } : {}), ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}) }); setSyncNotice('推送 ' + (result.pushed ?? 0) + ' · 拉取 ' + (result.pulled ?? 0)); await loadGraph(); } catch (e) { setSyncNotice(String(e.message || e)); } } }, '同步'),
          layer === 'global' && h('button', { type: 'button', style: uiButton(false), onClick: async () => { setSyncNotice('迁移旧同步…'); try { const result = await fetchJson('marshal/memory/migrate-legacy', {}); setSyncNotice(result.migrated ? '已绑定 ' + result.migrated + ' 条旧记录' : '没有待迁移的旧记录'); } catch (e) { if (e && (e.code === 'sign-in-to-approve' || String(e.message || '').includes('sign-in-to-approve'))) setApprovalNotice('请先登录机主账号后再审批全局记忆'); setSyncNotice(String(e.message || e)); } } }, '迁移旧同步'),
          h('button', { type: 'button', style: uiButton(false), onClick: () => { void loadGraph(); void loadProposals(); } }, '刷新')),
        syncNotice !== '' && h('div', { style: { padding: '6px 18px', fontSize: 11, color: dswTheme.dim } }, syncNotice),
        settingsOpen && settings && h('div', { style: { padding: '10px 18px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, borderBottom: '1px solid #8883' } },
          [['autoSummary', '会话结束自动摘要'], ['autoRecall', '每轮自动召回'], ['allowGroupQuote', '群聊允许引用私有记忆']].map(([key, label]) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: settings[key] !== false, onChange: async event => { const next = { ...settings, [key]: event.target.checked }; setSettings(next); try { const saved = await fetchJson('marshal/memory/settings', { [key]: event.target.checked }); setSettings(saved.settings); } catch { /* keep local */ } } }), label)),
          h('span', { style: { color: dswTheme.dim, marginLeft: 'auto' } }, '摘要模型：空 = 本地启发式')),
        settingsOpen && settings && h('div', { style: { padding: '0 18px 10px', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, borderBottom: '1px solid #8883' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, '摘要 provider', h('input', { defaultValue: settings.summaryProvider ?? '', placeholder: 'empty = 本地', onBlur: async event => { const value = event.target.value.trim(); try { const saved = await fetchJson('marshal/memory/settings', { summaryProvider: value }); setSettings(saved.settings); } catch { /* keep local */ } }, style: { ...uiInput, width: 150 } })),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, '摘要模型', h('input', { defaultValue: settings.summaryModel ?? '', placeholder: 'empty = 本地', onBlur: async event => { const value = event.target.value.trim(); try { const saved = await fetchJson('marshal/memory/settings', { summaryModel: value }); setSettings(saved.settings); } catch { /* keep local */ } }, style: { ...uiInput, width: 180 } }))),
        error !== '' && h('div', { style: { padding: '8px 18px', color: dswTheme.danger, fontSize: 12 } }, error),
        layer === 'global' && h('section', { style: { padding: '10px 18px', borderBottom: '1px solid #8883', display: 'grid', gap: 8 } },
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
        formOpen && h('div', { style: { padding: '12px 18px', display: 'grid', gap: 8, borderBottom: '1px solid #8883' } },
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
        results !== null && h('div', { style: { maxHeight: 180, overflow: 'auto', borderBottom: '1px solid #8883', padding: '8px 18px', display: 'grid', gap: 4 } },
          results.length === 0 ? h('div', { style: { fontSize: 12, color: dswTheme.dim } }, '没有匹配的记忆') : results.map(item => h('button', { key: item.id, type: 'button', onClick: () => { setSelected(item); if (item.scope === 'global') { setEditText(item.content || ''); setEditVisibility(item.visibility === 'all' ? 'all' : 'no-group'); } }, style: { textAlign: 'left', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '5px 0' } }, '[' + item.scope + '] ' + item.title))),
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', padding: 14, gap: 14 } },
          h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, borderRadius: 14, overflow: 'hidden', border: '1px solid #8883' } }, h(MemoryGalaxy, { graph, selectedId: selected?.id, onSelect: item => {
            setSelected(item);
            if (item?.scope !== 'global') return;
            setEditVisibility(item.visibility === 'all' ? 'all' : 'no-group');
            if (typeof item.content === 'string' && item.content !== '') { setEditText(item.content); return; }
            void fetchJson('marshal/memory/get?id=' + encodeURIComponent(item.id) + '&scope=global').then(data => {
              setSelected(data.item);
              setEditText(data.item?.content || '');
              setEditVisibility(data.item?.visibility === 'all' ? 'all' : 'no-group');
            }).catch(e => setError(friendlyError(e, '读取全局记忆')));
          } })),
          selected && h('aside', { style: { width: 300, flexShrink: 0, overflow: 'auto', padding: 16, border: '1px solid #8883', borderRadius: 14, background: 'color-mix(in srgb, currentColor 3%, transparent)' } },
            h('div', { style: { fontSize: 11, color: dswTheme.dim, textTransform: 'uppercase', letterSpacing: '.06em' } }, selected.scope + ' · ' + selected.kind + (selected.scope === 'global' ? ' · ' + (selected.visibility === 'all' ? '所有会话' : '仅单聊') : '')),
            h('h3', { style: { margin: '6px 0 10px', fontSize: 16 } }, selected.title),
            selected.cue && h('div', { style: { fontSize: 11, color: dswTheme.dim, marginBottom: 8, padding: '4px 8px', borderRadius: 6, background: 'color-mix(in srgb, currentColor 6%, transparent)' } }, '触发场景：' + selected.cue),
            selected.scope === 'global'
              ? h('div', { style: { display: 'grid', gap: 8 } },
                h('textarea', { value: editText || selected.content || '', onChange: event => setEditText(event.target.value), rows: 6, style: { ...uiInput, resize: 'vertical' } }),
                h('select', { value: editVisibility, onChange: event => setEditVisibility(event.target.value), style: uiInput }, h('option', { value: 'all' }, '所有会话'), h('option', { value: 'no-group' }, '仅单聊')),
                h('button', { type: 'button', style: uiButton(true), onClick: () => { void saveGlobal(); } }, '保存全局记忆'))
              : h('p', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.65 } }, selected.content),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 } }, (selected.tags || []).map(tag => h('span', { key: tag, style: { fontSize: 11, padding: '3px 7px', borderRadius: 999, background: 'color-mix(in srgb, currentColor 8%, transparent)' } }, tag))),
            h('div', { style: { marginTop: 14, fontSize: 11, color: dswTheme.dim } }, '清晰度 ' + ({ vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象' }[selected.clarity] || selected.clarity || '清晰') + ' · 重要性 ' + Math.round((selected.importance || 0) * 100) + '% · 访问 ' + (selected.accessCount || 0) + ' 次' + (selected.pinned ? ' · 已固定' : '')),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
              h('button', { type: 'button', style: uiButton(false), onClick: () => { void forget(selected); } }, '删除'),
              h('button', { type: 'button', style: uiButton(false), onClick: () => setSelected(null) }, '关闭')))),
        graph.nodes.length === 0 && results === null && h('div', { style: { padding: '0 18px 18px', fontSize: 12, color: dswTheme.dim } },
          layer === 'global' ? '还没有全局记忆。可点“＋ 记忆”写入，或审批智能体提交的偏好。'
            : layer === 'workspace' ? '所选项目工作区还没有共享记忆。工单总结会自动沉淀到这里，也可手动写入。'
              : '该智能体还没有私有记忆。会话结束后会自动生成摘要，也可点“＋ 记忆”手动写入。'));
    }

