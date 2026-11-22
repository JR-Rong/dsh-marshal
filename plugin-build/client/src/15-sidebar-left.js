    const mvGlyphs = {
      phone: 'M7 4H4v3a13 13 0 0 0 13 13h3v-4l-5-2-2 2a10 10 0 0 1-5-5l2-2-2-5Z',
      hangup: 'M3 14a14 14 0 0 1 18 0v4h-5v-3a10 10 0 0 0-8 0v3H3Z',
      chat: 'M4 4h16v12H9l-5 4V4Z M8 9h8M8 12h5',
      room: 'M7 3h10v3h3v15H4V6h3V3Zm0 3h10M8 11h8M8 15h5',
      agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8v-1a7 7 0 0 1 14 0v1',
      dot: 'M12 12h.01',
      chevron: 'm9 5 7 7-7 7',
      down: 'm5 9 7 7 7-7',
      mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Zm-4 6a7 7 0 0 0 14 0m-7 7v4m-3 0h6',
      mute: 'M3 3l18 18M9 5a3 3 0 0 1 6 0v6m-6-1v1a3 3 0 0 0 4 3M5 11a7 7 0 0 0 12 5m2-5a7 7 0 0 1-.3 2M12 18v4m-3 0h6',
      close: 'm6 6 12 12M18 6 6 18',
      save: 'M5 3h12l3 3v15H4V3h1Zm3 0v6h8V3M8 21v-7h8v7',
      send: 'm22 2-7 20-4-9-9-4 20-7ZM22 2 11 13',
      back: 'm10 5-7 7 7 7M3 12h18',
      refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-1l3 4M4 14l3 4a7 7 0 0 0 11-1',
    };
    function MvIcon({ name, className = '', size = 16 }) {
      return h('svg', { className: 'mv-svg ' + className, width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: name === 'dot' ? 8 : 1.7, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: mvGlyphs[name] }));
    }
    function MvButton({ icon, label, iconOnly = false, className = '', children, ...props }) {
      return h('button', { type: 'button', className: 'mv-btn ' + (iconOnly ? 'mv-icon-button ' : '') + className,
        title: iconOnly ? label : undefined, 'aria-label': iconOnly ? label : undefined, ...props },
        icon && h(MvIcon, { name: icon }), iconOnly ? null : (children ?? label));
    }
    function MvAvatar({ agent, breathing }) {
      return h('span', { className: 'mv-avatar', 'aria-hidden': true, 'data-breathing': breathing },
        agent?.name ? agentInitial(agent.name) : h(MvIcon, { name: 'agent' }));
    }

    function createMvStore(initial) {
      let current = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => current,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(value) {
          if (Object.is(current, value)) return;
          current = value;
          for (const listener of listeners) listener();
        },
        clear() { listeners.clear(); },
      };
    }
    function useMvSnapshot(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    }

    function createMarshalSidebarData() {
      const empty = { rooms: [], groups: [], agents: [], count: 0, loading: true, incomplete: false };
      const store = createMvStore(empty);
      const lifetime = new AbortController();
      const { signal } = lifetime;
      const read = (path, auth = false) => fetchJson('marshal/' + path, undefined, auth, signal);
      const readRooms = async () => {
        const { workspaces = [] } = await read('task-rooms/workspaces', true);
        const results = await Promise.allSettled(workspaces.filter(ws => !isPseudoAgentWorkspace(ws)).map(ws =>
          read('task-rooms/list?' + new URLSearchParams({ workspaceId: ws.id }), true)));
        const rooms = new Map();
        let incomplete = false;
        for (const result of results) {
          if (result.status === 'rejected') { incomplete = true; continue; }
          incomplete ||= Boolean(result.value.hubError);
          for (const room of result.value.rooms ?? []) if (room.id) rooms.set(room.id, room);
        }
        return { items: [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt), incomplete };
      };
      let epoch = 0, affected = new Set(), crossRequest;
      const failures = new Set();
      const groupLists = { groups: [], cross: [] };
      const markRooms = rooms => rooms.map(room => ({ ...room, incident: affected.has(room.taskId) }));
      signal.addEventListener('abort', () => crossRequest?.abort(), { once: true });
      const readCrossGroups = async () => {
        const controller = crossRequest = new AbortController();
        let onAbort;
        // Settle even if a transport does not reject its pending read on abort.
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          return await Promise.race([fetchJson('marshal/cross-groups/state', undefined, false, controller.signal), cancelled]);
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          if (crossRequest === controller) crossRequest = undefined;
        }
      };
      const load = async () => {
        const currentEpoch = ++epoch;
        crossRequest?.abort();
        const isCurrent = () => !signal.aborted && currentEpoch === epoch;
        const merge = (source, incomplete, patch) => {
          if (!isCurrent()) return;
          if (incomplete) failures.add(source);
          else failures.delete(source);
          const previous = store.getSnapshot();
          store.set({ ...previous, ...patch?.(previous), incomplete: failures.size > 0 });
        };
        const mergeGroups = (kind, request) => request.then(data => merge(kind, false, () => {
          groupLists[kind] = (data?.groups ?? []).map(group => ({ ...group, kind }));
          return { groups: [...groupLists.groups, ...groupLists.cross] };
        }), () => merge(kind, true));
        void readRooms().then(rooms => merge('rooms', rooms.incomplete, () => ({ rooms: markRooms(rooms.items) })),
          () => merge('rooms', true));
        void mergeGroups('groups', read('groups/state'));
        void mergeGroups('cross', readCrossGroups());

        const results = await Promise.allSettled([
          read('desktop/overview', true), read('incidents/summary', true),
          fetchJson('dsh-agents/api/state', undefined, false, signal),
        ]);
        if (!isCurrent()) return;
        const [overview, incidents, library] = results.map(result => result.value);
        const summary = incidents ?? overview?.incidents;
        const memory = overview?.memory?.pendingProposalCount ?? summary?.countsByKind?.['memory-proposal'] ?? 0;
        affected = new Set((summary?.items ?? []).filter(item => item.kind !== 'memory-proposal').map(item => item.targetId));
        const incidentCount = summary?.items
          ? affected.size : Math.max(0, (summary?.totalCount ?? 0) - (summary?.countsByKind?.['memory-proposal'] ?? 0));
        // Team display order is editable; the fixed primary follows member creation time.
        const directory = new Map((overview?.agents?.items ?? []).map(agent => [agent.agentKey, agent]));
        const agents = (library?.teams ?? []).filter(isAgentTeam).flatMap(team => (team.members ?? []).flatMap(member => {
          const agent = directory.get(`${overview?.host?.deviceId}/${team.id}/${member.id}`);
          return agent ? [{ ...agent, model: member.model, name: member.name || agent.name,
            createdAt: member.createdAt ?? team.createdAt }] : [];
        })).sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));
        merge('core', results.some(result => result.status === 'rejected'), previous => ({
          loading: false,
          count: incidentCount + memory, agents,
          rooms: markRooms(previous.rooms),
        }));
      };
      // Keep one trailing read when a browser event or SSE invalidates an in-flight snapshot.
      let refreshing = false, pending = false;
      const refresh = async () => {
        if (signal.aborted) return;
        pending = true;
        if (refreshing) return;
        refreshing = true;
        try {
          while (pending && !signal.aborted) {
            pending = false;
            await load();
          }
        } finally { refreshing = false; }
      };
      const hostWindow = typeof window === 'undefined' ? undefined : window;
      const hostDocument = typeof document === 'undefined' ? undefined : document;
      const onRefresh = () => { void refresh().catch(() => {}); };
      const onVisibility = () => { if (hostDocument.visibilityState === 'visible') onRefresh(); };
      let unsubscribe;
      try {
        unsubscribe = subscribeMarshalEvents(
          ['tasks.changed', 'groups.changed', 'agents.changed', 'incidents.changed', 'memory.changed', 'ready'],
          refresh, { initial: true, debounceMs: 100 });
      } catch { store.set({ ...empty, loading: false, incomplete: true }); }
      hostWindow?.addEventListener?.('marshal:agents-changed', onRefresh);
      hostWindow?.addEventListener?.('focus', onRefresh);
      hostDocument?.addEventListener?.('visibilitychange', onVisibility);
      return { ...store, dispose() {
        lifetime.abort();
        hostWindow?.removeEventListener?.('marshal:agents-changed', onRefresh);
        hostWindow?.removeEventListener?.('focus', onRefresh);
        hostDocument?.removeEventListener?.('visibilitychange', onVisibility);
        unsubscribe?.();
        store.clear();
      } };
    }

    function MarshalSidebarPanelItem({ sidebar, openPanel, size }) {
      const { count } = useMvSnapshot(sidebar);
      // DSH renders the keyboard-accessible button; stay an icon, not a nested button.
      return h('span', { className: 'mv-entry', title: count ? '调度官 · ' + count + ' 项待处理' : '调度官',
        onClick: event => { if (openPanel(PANEL)) event.stopPropagation(); } },
        h('svg', { width: size ?? 18, height: size ?? 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M7 2h10v7H7ZM12 9v5M5 17v-3h14v3M2 17h6v5H2Zm14 0h6v5h-6Z' })),
        count > 0 && h('span', { className: 'mv-badge' }, count > 99 ? '99+' : count));
    }
    function MarshalSessionActionHoc({ wide, children, sidebar, voice, onOpenAgentDirect, voiceAvailable }) {
      const agent = useMvSnapshot(sidebar).agents[0];
      const call = useMvSnapshot(voice);
      const compact = wide === false;
      const [direct, setDirect] = React.useState(null);
      const directState = direct?.key === agent?.agentKey ? direct : null;
      const hasError = Boolean(directState?.message) || ['error', 'failed'].includes(agent?.status);
      const running = ['active', 'running'].includes(agent?.status);
      const statusClass = hasError ? 'mv-danger' : running || agent?.sessionId ? 'mv-online' : 'mv-muted';
      const statusLabel = directState?.message ? '直连异常：' + directState.message
        : hasError ? '智能体运行异常' : running ? '智能体运行中' : agent?.sessionId ? '已建立会话' : '智能体未激活';
      const openDirect = async () => {
        if (directState?.busy || !onOpenAgentDirect) return;
        setDirect({ key: agent.agentKey, busy: true });
        const message = await onOpenAgentDirect(agent, true);
        setDirect({ key: agent.agentKey, message });
      };
      const inCall = voiceAvailable && call.status !== 'idle' && call.status !== 'summary';
      if (!agent && !inCall) return children;
      return h('div', { className: 'mv-session-actions' }, h('div', { className: 'mv-native-session' }, children),
        agent && h('section', { className: 'mv-scope mv-agent-card', 'data-compact': compact, 'aria-label': '主智能体' },
          !compact && h('div', { className: 'mv-line' },
            h(MvAvatar, { agent }), h('div', { className: 'mv-copy' },
              h('div', { className: 'mv-line' },
                h('span', { className: statusClass, role: 'img', 'aria-label': statusLabel, title: statusLabel },
                  h(MvIcon, { name: 'dot', size: 12 })),
                h('strong', { className: 'mv-truncate', title: agent.name }, agent.name),
                h('span', { className: 'mv-muted' }, '主智能体')),
              h('span', { className: 'mv-model mv-truncate', title: agent.model }, agent.model || '默认模型'))),
          h('div', { className: 'mv-actions' },
            h(MvButton, { icon: 'chat', label: compact ? '1:1 直连 · ' + agent.name : '1:1 直连', iconOnly: compact,
              disabled: directState?.busy, onClick: openDirect }),
            voiceAvailable && h(MvButton, { icon: 'phone', label: '语音通话 · ' + agent.name, iconOnly: true,
              onClick: () => { if (call.status === 'idle') void voice.start(agent); else voice.setExpanded(true); } })),
          directState?.message && h('div', { className: 'mv-danger', role: 'status' }, directState.message)),
        inCall &&
          h('div', { className: 'mv-scope' }, h(MvButton, { icon: 'phone', className: 'mv-mini', iconOnly: compact,
            label: mvVoiceLabels[call.status] + ' · ' + call.agent.name, onClick: () => voice.setExpanded(true) })));
    }

    const mvFoldKey = 'marshal.sidebar.sections.vnext';
    function readMvFold() {
      try { return JSON.parse(window.localStorage?.getItem(mvFoldKey)) ?? {}; } catch { return {}; }
    }
    function MarshalSidebarSections({ sidebar, openRoom, onOpenAgentDirect }) {
      const { rooms, groups, agents, loading, incomplete } = useMvSnapshot(sidebar);
      const [folded, setFolded] = React.useState(readMvFold);
      const toggle = key => {
        const next = { ...folded, [key]: !folded[key] };
        setFolded(next);
        try { window.localStorage?.setItem(mvFoldKey, JSON.stringify(next)); } catch {}
      };
      const sections = [
        ['taskRooms', '工单群', 'room', rooms, room => openRoom('taskRooms', room)],
        ['groups', '群聊', 'chat', groups, group => openRoom(group.kind, group)],
        ['agents', '智能体', 'agent', agents, agent => onOpenAgentDirect?.(agent)],
      ];
      return h('nav', { className: 'mv-scope mv-sections', 'aria-label': '调度官会话快捷入口' },
        ...sections.map(([key, label, icon, rows, open]) => h('section', { key },
          h('button', { className: 'mv-row mv-section-label', type: 'button', 'aria-expanded': !folded[key],
            'aria-controls': 'mv-sidebar-' + key, onClick: () => toggle(key) },
            h(MvIcon, { name: folded[key] ? 'chevron' : 'down' }), label, h('span', { className: 'mv-muted' }, rows.length)),
          h('ul', { id: 'mv-sidebar-' + key, className: 'mv-row-list', hidden: Boolean(folded[key]) },
            rows.length === 0 ? h('li', { className: 'mv-muted' }, loading ? '正在读取…' : incomplete ? '暂无可显示的内容' : '暂无' + label)
              : rows.map(row => h('li', { key: row.agentKey ?? (row.kind ?? key) + ':' + row.id },
                h('button', { type: 'button', className: 'mv-row', onClick: () => open(row), title: row.title ?? row.name },
                  h(MvIcon, { name: icon }), h('span', { className: 'mv-copy mv-truncate' }, row.title || row.name || '未命名'),
                  row.incident && h('span', { role: 'img', 'aria-label': '有待处理异常' }, h(MvIcon, { name: 'dot', className: 'mv-danger', size: 12 })))))))),
        incomplete && h('span', { className: 'mv-muted', role: 'status' }, '部分列表暂不可用'));
    }

    function mountSidebarSectionsPortal() {
      const store = createMvStore(null);
      if (typeof document === 'undefined' || !document.body) return { ...store, dispose() {} };
      const root = document.createElement('div');
      root.id = 'marshal-sidebar-sections-portal';
      let disposed = false;
      const sync = () => {
        if (disposed) return;
        const scrollport = document.querySelector('[data-sidebar-scrollport]');
        const anchor = scrollport?.querySelector('[data-slot="sidebar.workspaces"]');
        if (anchor?.parentElement) {
          if (root.parentElement !== anchor.parentElement || root.nextSibling !== anchor) anchor.parentElement.insertBefore(root, anchor);
          store.set(root);
        } else {
          root.remove();
          store.set(null);
        }
      };
      // Also handles the native sidebar switching between compact and wide in place.
      const observer = typeof MutationObserver === 'function' ? new MutationObserver(records => {
        if (records.some(record => record.target !== root && !root.contains(record.target))) sync();
      }) : null;
      observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-scrollport', 'data-slot'] });
      sync();
      return { ...store, dispose() { if (disposed) return; disposed = true; observer?.disconnect(); store.set(null); root.remove(); store.clear(); } };
    }
    function MarshalSidebarPortal({ target, ...props }) {
      const root = useMvSnapshot(target);
      if (!root) return null;
      const children = h(MarshalSidebarSections, props);
      if (typeof window.ReactDOM?.createPortal === 'function') return window.ReactDOM.createPortal(children, root);
      // DSH 0.2.2-rc.5 only: its loader exposes React but not react-dom.
      // This fallback mirrors that host renderer's internal Portal record.
      return { $$typeof: Symbol.for('react.portal'), key: 'marshal-sidebar', children, containerInfo: root, implementation: null };
    }

    function marshalCrossGroupMentions(text) {
      return [...new Set(Array.from(text.matchAll(/@([^\s@]+)/g), match => match[1]))];
    }
    function marshalCrossGroupDeliveryError(result) {
      if (!Array.isArray(result?.deliveries)) return '';
      const failed = result.deliveries.filter(item => item.state === 'failed');
      return failed.length ? '部分成员失败：' + failed.map(item => item.name + ' ' + (item.code || '')).join('、') : '';
    }
    function validateSidebarGroupMentions(text, group, cross) {
      // Local groups parse text again server-side; mirror their punctuation and
      // @全体 alias so validation and actual delivery select the same targets.
      const pattern = cross ? /@([^\s@]+)/g : /@([^\s@,，。；;]+)/g;
      const mentions = cross ? marshalCrossGroupMentions(text) : [...new Set(Array.from(text.matchAll(pattern), match => {
        const name = match[1].replace(/[：:]+$/, '');
        return name === '全体' ? 'all' : name;
      }))];
      if (text.replace(pattern, '').includes('@') || mentions.includes('')) throw Error('无法解析 @ 提及，请输入完整成员名');
      const unknown = mentions.filter(name => !(!cross && name === 'all') && !group.members?.some(member => member.name === name));
      if (unknown.length) throw Error('未找到 @ 成员：' + unknown.join('、'));
      return mentions;
    }

    // The existing group list views own unseeded selection. A shortcut opens a
    // targeted group directly, without reaching into those views or clicking host DOM.
    function MarshalSidebarGroupRoom({ route, ownerSignal }) {
      const cross = route.kind === 'cross';
      const prefix = cross ? 'marshal/cross-groups/' : 'marshal/groups/';
      const id = route.item.id;
      const [group, setGroup] = React.useState(null);
      const [error, setError] = React.useState('');
      const [sendError, setSendError] = React.useState('');
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const live = React.useRef(null);
      React.useEffect(() => {
        if (ownerSignal.aborted) return;
        const controller = new AbortController();
        const { signal } = controller;
        let reading, queued = false;
        const read = async () => {
          try {
            const result = await fetchJson(prefix + (cross ? 'state' : 'get?id=' + encodeURIComponent(id)), undefined, false, signal);
            if (!signal.aborted) {
              const next = cross ? result.groups?.find(item => item.id === id) : result.group;
              setGroup(next ?? null);
              setError(next ? '' : '群聊不可用');
            }
          } catch { if (!signal.aborted) { setGroup(null); setError('无法读取群聊'); } }
        };
        const refresh = () => {
          if (signal.aborted) return;
          queued = true;
          reading ??= Promise.resolve().then(async () => {
            while (queued && !signal.aborted) { queued = false; await read(); }
          }).finally(() => { reading = undefined; if (queued) refresh(); });
          return reading;
        };
        live.current = { signal, refresh };
        const unsubscribe = subscribeMarshalEvents(['ready', 'groups.changed'], refresh, { initial: true, debounceMs: 80 });
        const cleanup = () => {
          controller.abort();
          live.current = null;
          unsubscribe();
          ownerSignal.removeEventListener('abort', cleanup);
        };
        ownerSignal.addEventListener('abort', cleanup, { once: true });
        return cleanup;
      }, [id, prefix, ownerSignal]);
      const send = async event => {
        event.preventDefault();
        if (!live.current || !text.trim() || !group || busy) return;
        const { signal, refresh } = live.current;
        setBusy(true);
        setSendError('');
        try {
          const message = text.trim();
          const mentions = validateSidebarGroupMentions(message, group, cross);
          const result = await fetchJson(prefix + 'send', { id, text: message, mentions }, false, signal);
          if (result.error === 'leader-unavailable') throw Error('leader 所在设备离线，这个群暂时不可用');
          if (result.error) throw Error(result.error);
          if (!signal.aborted) {
            const deliveryError = cross ? marshalCrossGroupDeliveryError(result) : '';
            if (result.unknown?.length) setSendError('未找到 @ 成员：' + result.unknown.join('、') + (deliveryError ? '；' + deliveryError : ''));
            else if (deliveryError) setSendError(deliveryError);
            else if (result.offline?.length) setSendError('成员离线：' + result.offline.join('、') +
              (result.fallback ? '；已通知 leader 新建临时智能体或改派' : ''));
            setText('');
            void refresh();
          }
        } catch (e) { if (!signal.aborted) setSendError('发送失败：' + (e.message || e)); }
        finally { if (!signal.aborted) setBusy(false); }
      };
      return h('section', { className: 'mv-scope mv-room', 'aria-label': route.item.name },
        h('div', { className: 'mv-line' }, h('h2', { className: 'mv-voice-title mv-copy' }, group?.name || route.item.name),
          h(MvButton, { icon: 'refresh', label: '刷新群聊', iconOnly: true, onClick: () => void live.current?.refresh() })),
        error && h('div', { role: 'status', className: 'mv-danger' }, error),
        sendError && h('div', { role: 'status', className: 'mv-danger' }, sendError),
        h('div', { className: 'mv-room-log', role: 'log', 'aria-label': '群聊记录' },
          (group?.messages ?? []).map(message => h('div', { key: message.id, className: 'mv-room-message' },
            h('div', { className: 'mv-muted' }, message.author === 'user' ? '我'
              : group.members?.find(member => member.memberId === message.authorMemberId)?.name || (cross ? message.author : '成员')),
            message.text))),
        h('form', { onSubmit: send, className: 'mv-stack' },
          h('textarea', { className: 'mv-field', rows: 2, 'aria-label': '群聊消息', value: text, onChange: event => setText(event.target.value) }),
          h('div', null, h(MvButton, { icon: 'send', label: busy ? '正在发送…' : '发送消息', type: 'submit', disabled: !group || !text.trim() || busy }))));
    }
