    const MV_TASK_TAB = 'marshal-agent-tasks';
    const MV_TASK_TAB_ID = 'dsh-marshal/agent-tasks';
    const MV_TASK_TAB_RETRY_DELAYS = [50, 150, 400, 1000];
    const MV_TASK_TAB_UNAVAILABLE = '无法打开任务清单，请在智能体会话中重试。';
    const mvTaskTypes = { casual: '闲聊记录', direct: '直连任务', ticket: '关联工单' };
    const mvTaskStatuses = { queued: '待处理', running: '进行中', review: '待验收', done: '已完成', failed: '失败' };
    const mvRead = (path, signal) => fetchJson('marshal/' + path, undefined, true, signal);
    // A host that installs the standalone @linxin666/dsh-agents plugin serves its
    // own /api/run, whose body refuses any field it does not read. Only the bundled
    // build records `purpose`, so retry once without it rather than failing the open.
    async function mvRunDirectSession(agent, signal) {
      const body = { teamId: agent.teamId, memberId: agent.agentId, purpose: 'direct' };
      try {
        return await fetchJson('dsh-agents/api/run', body, false, signal);
      } catch (error) {
        if (signal?.aborted || error?.status !== 400 || error?.code !== 'invalid-request') throw error;
        const { purpose, ...compatible } = body;
        return await fetchJson('dsh-agents/api/run', compatible, false, signal);
      }
    }
    const mvAgentQuery = (path, agentKey) => path + '?' + new URLSearchParams({ agentKey });
    const mvSessionId = row => row?.sessionId ?? row?.id;
    const mvReadOnlyTask = task => task.id.startsWith('ticket:');
    const mvTicketLabel = ticket => '#' + String(ticket.ticketNo ?? ticket.id).replace(/^#/, '');
    const mvGuidanceLabel = ticket => ticket ? '汇总并同步指导至 ' + mvTicketLabel(ticket) : '汇总提交同步指导';
    const mvTaskError = (error, fallback) => error?.message ? fallback + '：' + error.message : fallback;
    const mvValidWorkspaceId = value => typeof value === 'string' && value.trim() && value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(value);
    async function mvReadTicketWorkspaces(signal) {
      const { workspaces = [] } = await mvRead('task-rooms/workspaces', signal);
      return workspaces.filter(ws => mvValidWorkspaceId(ws?.id) && !isPseudoAgentWorkspace(ws));
    }

    function mvService(ctx, name) {
      try { return ctx?.get?.(name) ?? ctx?.[name]; } catch {
        try { return ctx?.[name]; } catch { return undefined; }
      }
    }
    function mvWaitForTasksTab(delay, signal) {
      return new Promise(resolve => {
        if (signal?.aborted) { resolve(); return; }
        const stop = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        const timer = setTimeout(stop, delay);
        signal?.addEventListener('abort', stop, { once: true });
      });
    }
    async function mvOpenTasksTab(ctx, { sessionId, signal, isCurrent = () => true } = {}) {
      for (const delay of [0, ...MV_TASK_TAB_RETRY_DELAYS]) {
        if (signal?.aborted || !isCurrent()) return;
        if (delay) await mvWaitForTasksTab(delay, signal);
        if (signal?.aborted || !isCurrent()) return;
        try {
          const rightbar = mvService(ctx, 'sidebarRight');
          // On the official host, openTab acts on the on-screen surface. A
          // previous session can still be mounted after openSession resolves.
          if (sessionId && typeof rightbar?.screen === 'function' && rightbar.screen()?.sessionId !== sessionId) continue;
          if (typeof rightbar?.openTab === 'function' && await rightbar.openTab(MV_TASK_TAB) !== false) return;
        } catch { /* The destination surface or tab registry may still be mounting. */ }
      }
      if (!signal?.aborted && isCurrent()) return MV_TASK_TAB_UNAVAILABLE;
    }
    function mvRegisterTasksTab(registry) {
      return registry?.register?.({ id: MV_TASK_TAB_ID, kind: MV_TASK_TAB, title: () => '智能体任务',
        priority: 'extension', keepMounted: true });
    }
    async function mvOpenAgentDirectSession({ agent, ctx, uiWorkspace, onOpenAgentDirect, sessionBridge,
      openSessionRef, mvFocusedAgentStore, signal, sessionId, openDrawer }) {
      try {
        if (!agent?.agentKey || signal?.aborted) return;
        try { await mvService(ctx, 'layout')?.selectPanel?.(null); } catch { /* still try native navigation */ }
        if (signal?.aborted) return;
        // createSessionBridge creates a synthetic marshal-view binding, not a
        // resident DSH identity. Only use a bridge if it supplies a native opener.
        const openSession = async id => {
          for (const [owner, method] of [[sessionBridge, 'openSession'], [uiWorkspace, 'openSession'], [openSessionRef, 'current']]) {
            if (signal?.aborted) return false;
            try { if (typeof owner?.[method] === 'function' && await owner[method](id) !== false) return true; } catch {}
          }
          return false;
        };
        const resolved = sessionId ?? (onOpenAgentDirect ? await onOpenAgentDirect(agent, signal) :
          mvSessionId((await mvRead(mvAgentQuery('agent-direct-sessions', agent.agentKey), signal))?.mainSession));
        const id = typeof resolved === 'string' ? resolved : resolved?.sessionId;
        if (signal?.aborted) return;
        if (typeof id !== 'string' || !id.trim()) return '暂无 1:1 直连会话。';
        if (!await openSession(id)) return signal?.aborted ? undefined : '宿主无法打开 1:1 直连会话。';
        if (signal?.aborted) return;
        mvFocusedAgentStore?.set({ ...agent, agentKey: resolved?.agentKey ?? agent.agentKey, navigationSessionId: id });
        try {
          if (openDrawer) return await openDrawer(ctx, id, signal);
          if (mvService(ctx, 'sidebarRight')) return await mvOpenTasksTab(ctx, { sessionId: id, signal });
        } catch {
          if (!signal?.aborted) return MV_TASK_TAB_UNAVAILABLE;
        }
      } catch {
        if (!signal?.aborted) return '无法打开 1:1 直连会话，请稍后重试。';
      }
    }

    function mvTaskMutation(action, agentKey, fields, signal) {
      if (action !== 'create' && mvReadOnlyTask(fields)) throw Error('关联工单是只读记录。');
      return fetchJson('marshal/agent-tasks/' + action, { agentKey, ...fields }, true, signal);
    }
    function mvDirectLink({ agent, open, label = '1:1 直连' }) {
      const [state, setState] = React.useState(null);
      return h('span', { className: 'mv-scope mv-actions' },
        h(MvButton, { icon: 'chat', label, disabled: state?.busy, onClick: async () => {
          setState({ busy: true });
          const message = await open(agent);
          setState({ message });
        } }),
        state?.message && h('span', { className: 'mv-danger', role: 'status' }, state.message));
    }
    const mvRequiresGuidanceTarget = tasks => !tasks.length || tasks.some(task => task.type !== 'direct' || task.linkedTicketId);
    const mvLinkedTicketIds = tasks => [...new Set(tasks.map(task => task.linkedTicketId).filter(Boolean))];
    const MV_GUIDANCE_TICKET_CONFLICT = '请选择同一工单下的任务';
    function mvSubmitGuidance({ agentKey, tasks, targetTicketId, guidanceText }, signal) {
      const linked = mvLinkedTicketIds(tasks);
      if (linked.length > 1 || (linked.length && targetTicketId && targetTicketId !== linked[0])) {
        throw Error(MV_GUIDANCE_TICKET_CONFLICT);
      }
      const target = linked[0] ?? targetTicketId;
      if (!target && mvRequiresGuidanceTarget(tasks)) {
        throw Error('请选择目标工单，或改选直连任务。');
      }
      // The server resolves direct destinations from the stored tasks' sessionId.
      return fetchJson('marshal/agents/guidance-sync', { agentKey, taskIds: tasks.map(task => task.id),
        guidanceText: guidanceText.trim(), ...(target ? { targetTicketId: target, wakeTicket: true } : {}) }, true, signal);
    }

    function mvCreateAgentTasks() {
      const lifetime = new AbortController();
      const { signal } = lifetime;
      const directory = createMvStore({ agents: [], marshalAgents: [], rosters: {}, loading: true });
      const tickets = createMvStore({ items: [] });
      const focus = createMvStore(null);
      const modal = createMvStore(null);
      const drawer = createMvStore(null);
      const empty = { rows: [], selected: [], focusedId: '', loading: true };
      const noAgent = createMvStore(empty);
      const entries = new Map();
      const stops = [];
      const entryFor = key => {
        if (!key) return { store: noAgent };
        if (!entries.has(key)) entries.set(key, { store: createMvStore(empty), users: 0 });
        return entries.get(key);
      };
      function refreshTasks(key) {
        if (!key || signal.aborted) return;
        const entry = entryFor(key);
        if (entry.reading) { entry.pending = true; return entry.reading; }
        const load = async () => {
          do {
            entry.pending = false;
            try {
              const result = await mvRead(mvAgentQuery('agent-tasks', key), signal);
              if (signal.aborted) return;
              const rows = result.tasks ?? [];
              const ids = new Set(rows.map(task => task.id));
              const previous = entry.store.getSnapshot();
              entry.store.set({ rows, selected: previous.selected.filter(id => ids.has(id)),
                focusedId: ids.has(previous.focusedId) ? previous.focusedId : '', loading: false });
            } catch (error) {
              if (!signal.aborted) entry.store.set({ ...entry.store.getSnapshot(), loading: false,
                error: mvTaskError(error, '读取智能体任务失败') });
            }
          } while (entry.pending && !signal.aborted);
        };
        entry.reading = load().finally(() => { entry.reading = undefined; });
        return entry.reading;
      }
      async function refreshDirectory() {
        const [overview, rosterState, library] = await Promise.allSettled([
          mvRead('desktop/overview', signal), mvRead('rosters/state', signal),
          fetchJson('dsh-agents/api/state', undefined, false, signal),
        ]);
        if (signal.aborted) return;
        const previous = directory.getSnapshot();
        const agents = overview.value?.agents?.items ?? previous.agents;
        const teams = library.value?.teams ?? [];
        const marshalTeams = new Set(teams.filter(team => typeof team?.name === 'string' && isAgentTeam(team)).map(team => team.id));
        directory.set({ agents, marshalAgents: agents.filter(row => marshalTeams.has(row.teamId)),
          rosters: rosterState.value?.rosters ?? previous.rosters,
          loading: false, error: [overview, library].some(result => result.status === 'rejected') ?
            mvTaskError(overview.reason ?? library.reason, '读取智能体失败') : '' });
      }
      async function refreshTasksAndTickets() {
        if (signal.aborted) return;
        const refreshTickets = async () => {
          try {
            const result = await mvRead('tasks/state', signal);
            if (!signal.aborted) tickets.set({ items: (result.tasks ?? []).filter(ticket => ticket.archivedAt == null) });
          } catch (error) {
            if (!signal.aborted) tickets.set({ ...tickets.getSnapshot(), error: mvTaskError(error, '读取工单失败') });
          }
        };
        await Promise.all([
          refreshTickets(),
          ...[...entries].filter(([, entry]) => entry.users).map(([key]) => refreshTasks(key)),
        ]);
      }
      function activate() {
        if (stops.length || signal.aborted) return;
        const listen = (topics, refresh) => {
          try { stops.push(subscribeMarshalEvents(topics, refresh, { initial: true, debounceMs: 100 })); }
          catch { stops.push(() => {}); void refresh(); }
        };
        // The shared dispatcher coalesces to the latest topic. Keep directory
        // invalidations independent of high-frequency room messages.
        listen(['ready', 'agents.changed'], refreshDirectory);
        listen(['ready', 'room.message', 'tasks.changed', 'agents.changed'], refreshTasksAndTickets);
      }
      return { signal, directory, tickets, focus, drawer, modal, activate, refreshTasks,
        tasks: key => entryFor(key).store,
        setSelection(key, change) {
          if (signal.aborted) return;
          const { store } = entryFor(key);
          const value = store.getSnapshot();
          store.set({ ...value, ...change(value) });
        },
        retain(key) {
          if (!key || signal.aborted) return;
          const entry = entryFor(key);
          if (entry.users++ === 0) void refreshTasks(key);
          return () => { entry.users--; };
        },
        showModal(data) { if (!signal.aborted) { activate(); modal.set(data); } },
        dispose() {
          lifetime.abort();
          for (const stop of stops.splice(0)) stop();
          for (const store of [directory, tickets, focus, drawer, modal, noAgent, ...[...entries.values()].map(entry => entry.store)]) store.clear();
          focus.set(null); drawer.set(null); modal.set(null);
          entries.clear();
        },
      };
    }

    function mvUseTabInfo(props) {
      // The host supplies one stable hook shape for the lifetime of the seat.
      try { return props?.hooks?.tabInfo?.() || props?.useTabInfo?.(); } catch { return undefined; }
    }
    function mvUseSessionAgent(runtime, sessionId, allowFocused) {
      const focus = useMvSnapshot(runtime.focus);
      const { marshalAgents: agents, loading, error } = useMvSnapshot(runtime.directory);
      const [found, setFound] = React.useState(null);
      // A navigation target or overview match can identify the agent, but only
      // the direct-sessions response can authorize binding a task to the session.
      const visited = sessionId && focus?.navigationSessionId === sessionId ? focus : undefined;
      const candidate = sessionId ? (visited ? agents.find(row => row.agentKey === visited.agentKey) ?? visited :
        agents.find(row => row.sessionId === sessionId)) : undefined;
      const matchForSession = found && found.sessionId === sessionId &&
        (!candidate || found.agent.agentKey === candidate.agentKey) ? found.agent : undefined;
      const verified = matchForSession && found.agents === agents;
      const agent = candidate || (matchForSession && agents.find(row => row.agentKey === matchForSession.agentKey)) ||
        (!sessionId && allowFocused ? focus : null);
      React.useEffect(() => { runtime.activate(); }, [runtime]);
      React.useEffect(() => {
        if (!sessionId || verified || (!candidate && !agents.length) || runtime.signal.aborted) return;
        const controller = new AbortController();
        const { signal } = controller;
        const abort = () => controller.abort();
        runtime.signal.addEventListener('abort', abort, { once: true });
        const candidates = candidate ? [candidate] : agents;
        // Bound host lookups per batch when there is no overview candidate.
        const resolve = async () => {
          for (let i = 0; i < candidates.length && !signal.aborted; i += 4) {
            const batch = candidates.slice(i, i + 4);
            const results = await Promise.allSettled(batch.map(row => mvRead(mvAgentQuery('agent-direct-sessions', row.agentKey), signal)));
            if (signal.aborted) return;
            const match = batch.find((_, index) => {
              const data = results[index].value;
              return [data?.mainSession, ...(data?.subSessions ?? [])].some(row => mvSessionId(row) === sessionId);
            });
            if (match) {
              setFound({ sessionId, agents, agent: match });
              return;
            }
          }
          if (!signal.aborted) setFound(null);
        };
        void resolve().finally(() => runtime.signal.removeEventListener('abort', abort));
        return () => { runtime.signal.removeEventListener('abort', abort); abort(); };
      }, [runtime, sessionId, agents, candidate, verified]);
      return { agent, loading, error, focus, directSessionId: verified ? sessionId : undefined };
    }
    function mvUseAgentTasks(runtime, key) {
      const state = useMvSnapshot(runtime.tasks(key));
      React.useEffect(() => runtime.retain(key), [runtime, key]);
      return state;
    }
    function mvSelection(state, tickets) {
      const { selected, focusedId, rows } = state;
      const tasks = rows.filter(row => selected.length ? selected.includes(row.id) : row.id === focusedId);
      const targets = mvLinkedTicketIds(tasks);
      const id = targets.length === 1 ? targets[0] : undefined;
      return { tasks, ticket: id ? tickets.find(row => row.id === id) ?? { id } : undefined };
    }
    function mvTicketOptions(tickets) {
      return tickets.map(ticket => h('option', { key: ticket.id, value: ticket.id }, mvTicketLabel(ticket) + ' · ' + (ticket.title ?? '工单')));
    }
    function mvStartVoice(voice, call, agent, ticket) {
      if (call.status === 'idle') void voice.start(agent, { targetTicketId: ticket?.id, ticketNo: ticket?.ticketNo });
      else voice.setExpanded(true);
    }
    const mvIsCalling = call => ['connecting', 'active', 'ending'].includes(call.status);
    function mvGuidanceButton(runtime, agent, selection, dock = false) {
      return h(MvButton, { icon: 'send', className: 'mv-guidance-action',
        label: dock && !selection.ticket ? '同步指导' : mvGuidanceLabel(selection.ticket),
        onClick: () => runtime.showModal({ agent, ...selection }) });
    }

    function mvAgentTasksRightbarTab(props) {
      const { runtime, voiceLayer, idleVoice, navigation } = props;
      const info = mvUseTabInfo(props);
      const sessionId = info?.sessionId ?? info?.tab?.sessionId ?? props.sessionId;
      const { agent, loading, error, focus, directSessionId } = mvUseSessionAgent(runtime, sessionId, true);
      const voice = useMvSnapshot(voiceLayer);
      const call = useMvSnapshot(voice ?? idleVoice);
      const suggested = (mvIsCalling(call) ? call.agent : undefined) ?? focus;
      if (!agent) return h('div', { className: 'mv-scope mv-task-pane mv-stack' },
        h('p', { role: 'status' }, loading ? '正在读取智能体…' : '当前会话没有关联的智能体。'),
        error && h('span', { className: 'mv-danger', role: 'status' }, error),
        suggested && h(mvDirectLink, { agent: suggested, open: navigation.openAgent, label: '打开该智能体 1:1 会话' }));
      return h(mvAgentTaskList, { key: agent.agentKey, agent, runtime, voiceLayer, idleVoice, navigation, directSessionId });
    }
    function mvAgentTaskList({ agent, runtime, voiceLayer, idleVoice, navigation, directSessionId }) {
      const key = agent.agentKey;
      const state = mvUseAgentTasks(runtime, key);
      const { items: tickets, error: ticketError } = useMvSnapshot(runtime.tickets);
      const voice = useMvSnapshot(voiceLayer);
      const call = useMvSnapshot(voice ?? idleVoice);
      const [filter, setFilter] = React.useState('');
      const [type, setType] = React.useState('direct');
      const [title, setTitle] = React.useState('');
      const [ticketId, setTicketId] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [removeId, setRemoveId] = React.useState('');
      const [ticketWorkspace, setTicketWorkspace] = React.useState(null);
      const lock = React.useRef(false);
      const selection = mvSelection(state, tickets);
      const choose = change => runtime.setSelection(key, change);
      const run = async work => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try { await work(); } catch (e) { if (!runtime.signal.aborted) setError(mvTaskError(e, '操作失败')); }
        finally { lock.current = false; if (!runtime.signal.aborted) setBusy(false); }
      };
      const write = (action, fields, after) => run(async () => {
        await mvTaskMutation(action, key, fields, runtime.signal);
        if (runtime.signal.aborted) return;
        after?.();
        await runtime.refreshTasks(key);
      });
      const openTicket = (id, workspaceId) => run(async () => {
        if (!workspaceId) setTicketWorkspace(null);
        const card = tickets.find(row => row.id === id);
        const options = await navigation.openTicket(id, card, agent, workspaceId);
        if (!runtime.signal.aborted) setTicketWorkspace(options ? { id, card, options } : null);
      });
      const rows = state.rows.filter(task => !filter || task.status === filter);
      return h('section', { className: 'mv-scope mv-task-pane mv-stack', 'aria-label': '智能体任务' },
        h('header', { className: 'mv-stack' },
          h(MvButton, { icon: 'chat', label: '自由闲聊（不绑定任务）', className: 'mv-casual-card',
            'aria-pressed': !state.focusedId && !state.selected.length,
            onClick: () => { choose(() => ({ focusedId: '', selected: [] })); setType('casual'); } }),
          h('div', { className: 'mv-line' }, h(MvAvatar, { agent }),
            h('div', { className: 'mv-copy' }, h('strong', null, agent.name),
              h('div', { className: 'mv-muted' }, state.rows.find(row => row.id === state.focusedId)?.title ?? '自由闲聊')),
            voice && h(MvButton, { icon: 'phone', iconOnly: true, label: '语音通话', onClick: () => mvStartVoice(voice, call, agent, selection.ticket) })),
          mvGuidanceButton(runtime, agent, selection),
          !directSessionId && h('div', { className: 'mv-stack' },
            h('span', { className: 'mv-muted', role: 'status' }, '当前会话非 1:1 直连会话。新建直连任务将归入该智能体的主会话。'),
            h(mvDirectLink, { agent, open: navigation.openAgent, label: '打开该智能体 1:1 会话' })),
          h('form', { className: 'mv-stack', onSubmit: event => {
            event.preventDefault();
            if (!title.trim() || (type === 'ticket' && !ticketId)) return;
            return write('create', { type, title: title.trim(), ...(type === 'ticket' ? { linkedTicketId: ticketId } : {}),
              ...(directSessionId && type === 'direct' ? { sessionId: directSessionId } : {}) }, () => setTitle(''));
          } },
          h('input', { className: 'mv-field', 'aria-label': '新任务标题', placeholder: '新任务标题', value: title,
            maxLength: 512, required: true, onChange: event => setTitle(event.target.value) }),
          h('div', { className: 'mv-actions' },
            h('select', { className: 'mv-field mv-compact-field', 'aria-label': '新任务类型', value: type, onChange: event => setType(event.target.value) },
              Object.entries(mvTaskTypes).map(([value, label]) => h('option', { key: value, value }, label))),
            h(MvButton, { type: 'submit', label: '新建 1:1 任务', disabled: busy || !title.trim() || (type === 'ticket' && !ticketId) })),
          type === 'ticket' && h('select', { className: 'mv-field', 'aria-label': '关联工单', required: true, value: ticketId,
            onChange: event => setTicketId(event.target.value) }, h('option', { value: '' }, '请选择关联工单'), mvTicketOptions(tickets)),
          type === 'ticket' && ticketError && h('span', { className: 'mv-danger', role: 'status' }, ticketError))),
        h('div', { className: 'mv-stack' },
          h('div', { className: 'mv-actions', role: 'group', 'aria-label': '任务状态筛选' },
            ['', 'running', 'review', 'done'].map(value => h(MvButton, { key: value, className: 'mv-chip',
              label: mvTaskStatuses[value] ?? '全部', 'aria-pressed': filter === value, onClick: () => setFilter(value) }))),
          (error || state.error) && h('div', { className: 'mv-line mv-danger', role: 'status' }, error || state.error,
            state.error && h(MvButton, { icon: 'refresh', label: '重试', onClick: () => runtime.refreshTasks(key) })),
          ticketWorkspace && h('label', { className: 'mv-stack' },
            '为 ' + mvTicketLabel(ticketWorkspace.card ?? ticketWorkspace) + ' 选择工单工作区',
            h('select', { className: 'mv-field', 'aria-label': '选择目标工单工作区', value: '', disabled: busy,
              onChange: event => {
                const workspaceId = event.target.value;
                if (ticketWorkspace.options.some(ws => ws.id === workspaceId)) return openTicket(ticketWorkspace.id, workspaceId);
              },
            }, h('option', { value: '' }, '请选择工作区'),
            ticketWorkspace.options.map(ws => h('option', { key: ws.id, value: ws.id }, ws.title || ws.name || ws.id))))),
        h('div', { className: 'mv-stack mv-task-scroll' },
          state.loading ? h('p', { className: 'mv-muted', role: 'status' }, '正在读取任务…') :
          !rows.length ? h('p', { className: 'mv-muted' }, '暂无符合条件的任务') : rows.map(task => {
            const readOnly = mvReadOnlyTask(task);
            const active = state.focusedId === task.id;
            const picked = state.selected.includes(task.id);
            const ticket = task.linkedTicketId && (tickets.find(row => row.id === task.linkedTicketId) ?? { id: task.linkedTicketId });
            const ticketButton = ticket && h(MvButton, { icon: 'room', label: '打开工单群 ' + mvTicketLabel(ticket), onClick: () => openTicket(ticket.id) });
            return h('article', { key: task.id, className: 'mv-stack mv-task-item', 'data-focused': active },
              h('div', { className: 'mv-line' }, h('input', { type: 'checkbox', checked: picked,
                disabled: !picked && state.selected.length >= 32, 'aria-label': '选入同步指导：' + task.title,
                onChange: () => choose(prev => ({ selected: picked ? prev.selected.filter(id => id !== task.id) : [...prev.selected, task.id] })) }),
                readOnly ? h('strong', { className: 'mv-copy' }, task.title) : h(MvButton, { className: 'mv-row mv-copy', label: task.title,
                  'aria-pressed': active, onClick: () => choose(() => ({ focusedId: active ? '' : task.id, selected: [] })) }),
                h('span', { className: 'mv-model' }, mvTaskStatuses[task.status] ?? task.status)),
              h('span', { className: 'mv-muted' }, mvTaskTypes[task.type], ticket && !readOnly ? ' · 状态跟随工单' : '',
                task.lastSyncAt ? ' · 已同步指导' : ''),
              readOnly ? ticketButton : h('details', null, h('summary', null, '任务详情'),
                h('div', { className: 'mv-stack' },
                  task.subSessions?.map(sub => h(MvButton, { key: sub.id, icon: 'chat', label: sub.title || sub.role || sub.id,
                    onClick: () => run(() => navigation.openSubSession(agent, sub.id, task.id)) })),
                  ticketButton,
                  h('div', { className: 'mv-actions' },
                    !ticket && h('select', { className: 'mv-field mv-compact-field', 'aria-label': '任务状态：' + task.title,
                      value: task.status, disabled: busy, onChange: event => write('update', { id: task.id, patch: { status: event.target.value } }) },
                      Object.entries(mvTaskStatuses).map(([value, label]) => h('option', { key: value, value }, label))),
                    h(MvButton, { className: 'mv-danger', label: removeId === task.id ? '确认删除' : '删除任务', disabled: busy,
                      onClick: () => removeId === task.id ? write('delete', { id: task.id }, () => setRemoveId('')) : setRemoveId(task.id) }),
                    removeId === task.id && h(MvButton, { label: '取消', onClick: () => setRemoveId('') })))));
          })),
        h('footer', { className: 'mv-actions' }, h('span', { className: 'mv-muted' }, '已选 ' + selection.tasks.length + ' 项'),
          mvGuidanceButton(runtime, agent, selection)));
    }

    function mvAgentComposerDockBar({ runtime, voiceLayer, idleVoice, navigation, sessionId }) {
      const { agent: owner } = mvUseSessionAgent(runtime, sessionId, false);
      const voice = useMvSnapshot(voiceLayer);
      const call = useMvSnapshot(voice ?? idleVoice);
      const pendingDrawer = useMvSnapshot(runtime.drawer);
      const [drawerError, setDrawerError] = React.useState(null);
      const calling = mvIsCalling(call);
      const agent = owner ?? (calling ? call.agent : undefined);
      const state = mvUseAgentTasks(runtime, agent?.agentKey);
      const { items: tickets } = useMvSnapshot(runtime.tickets);
      const selection = mvSelection(state, tickets);
      const pending = state.rows.filter(row => row.status !== 'done').length;
      React.useEffect(() => {
        if (!sessionId || sessionId !== pendingDrawer) return;
        const controller = new AbortController();
        const isCurrent = () => !runtime.signal.aborted && runtime.drawer.getSnapshot() === sessionId;
        setDrawerError(null);
        // For hosts without a screen query, wait for the destination Composer
        // to commit before trying to open the tab on its surface.
        const id = setTimeout(async () => {
          const message = await navigation.openDrawer({ sessionId, signal: controller.signal, isCurrent });
          if (!controller.signal.aborted && isCurrent()) {
            if (message) setDrawerError({ sessionId, message });
            runtime.drawer.set(null);
          }
        }, 0);
        return () => { clearTimeout(id); controller.abort(); };
      }, [sessionId, pendingDrawer, runtime, navigation]);
      if (!agent) return null;
      return h('div', { className: 'mv-scope mv-actions mv-composer-dock', 'aria-label': '智能体会话快捷操作' },
        h(MvIcon, { name: 'agent' }), h('strong', { className: 'mv-truncate' }, agent.name),
        h(MvButton, { icon: 'room', 'aria-label': '任务清单 · ' + pending + ' 待处理',
          onClick: async () => {
            if (owner) { runtime.drawer.set(sessionId); return; }
            const message = await navigation.openAgent(agent);
            if (message && !runtime.signal.aborted) setDrawerError({ sessionId, message });
          } },
          '任务清单', h('span', { className: 'mv-model' }, pending)),
        mvGuidanceButton(runtime, agent, selection, true),
        voice && h(MvButton, { icon: 'phone', iconOnly: true, label: calling ? '查看语音通话' : '语音通话',
          onClick: () => mvStartVoice(voice, call, agent, selection.ticket) }),
        h('span', { className: 'mv-muted' }, 'SenseVoice 听写仍在输入框'),
        drawerError && drawerError.sessionId === sessionId && h('span', { className: 'mv-danger', role: 'status' }, drawerError.message));
    }

    function mvSyncGuidanceModal({ runtime, data }) {
      const { agent, tasks = [], ticket, onSuccess } = data;
      const { items, error: ticketError } = useMvSnapshot(runtime.tickets);
      const { agents, rosters } = useMvSnapshot(runtime.directory);
      const linked = mvLinkedTicketIds(tasks);
      const boundTarget = linked[0];
      const conflict = linked.length > 1;
      const [chosenTarget, setTarget] = React.useState('');
      const target = conflict ? '' : boundTarget ?? chosenTarget;
      const [guidance, setGuidance] = React.useState(() => (data.guidanceText ?? tasks.map(task => task.lastSummary).filter(Boolean).join('\n\n')).slice(0, 3000));
      const [instructions, setInstructions] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [workspaceResult, setWorkspaceResult] = React.useState(null);
      const [chosenWorkspace, setChosenWorkspace] = React.useState('');
      const dialogRef = React.useRef(null);
      const lock = React.useRef(false);
      const currentTicket = target ? items.find(row => row.id === target) ?? (target === ticket?.id ? ticket : { id: target }) : undefined;
      const ticketOptions = boundTarget ? (currentTicket ? [currentTicket] : []) : items;
      const needsRoom = Boolean(target) && !Boolean(currentTicket?.taskRoom?.id || currentTicket?.workflow?.workspaceId || currentTicket?.workspaceId);
      const agentWorkspace = mvValidWorkspaceId(agent?.workspaceId) ? agent.workspaceId : undefined;
      const lookupTarget = needsRoom && !agentWorkspace ? target : '';
      const workspaceLookup = lookupTarget && workspaceResult?.target === lookupTarget ? workspaceResult : null;
      const workspaceOptions = workspaceLookup?.options;
      const roomWorkspaceId = agentWorkspace ?? (workspaceOptions?.length === 1 ? workspaceOptions[0].id :
        workspaceOptions?.find(ws => ws.id === chosenWorkspace)?.id);
      const workspaceId = currentTicket?.workflow?.workspaceId ?? currentTicket?.taskRoom?.workspaceId ?? currentTicket?.workspaceId ?? roomWorkspaceId;
      const roster = rosters[workspaceId];
      const rosterKeys = [roster?.leaderId, roster?.coderId, roster?.reviewerId, ...(roster?.members ?? []),
        ...Object.values(currentTicket?.workflow?.plan?.members ?? {})];
      const names = [...new Set([agent.name, ...agents.filter(row => (workspaceId && row.workspaceId === workspaceId) ||
        rosterKeys.some(key => typeof key === 'string' && (row.agentKey === key || row.agentKey.endsWith('/' + key)))).map(row => row.name)].filter(Boolean))];
      const requiresTarget = mvRequiresGuidanceTarget(tasks);
      // The endpoint accepts text, so send @member instructions as explicit lines.
      const text = [guidance.trim(), ...Object.entries(instructions).filter(([, value]) => value.trim())
        .map(([name, value]) => '@' + name + ' ' + value.trim())].filter(Boolean).join('\n\n');
      const close = () => { if (!lock.current) runtime.modal.set(null); };
      React.useEffect(() => {
        const dialog = dialogRef.current;
        try { dialog?.showModal?.(); } catch {}
        return () => { if (dialog?.open) dialog.close(); };
      }, []);
      React.useEffect(() => {
        if (!lookupTarget || runtime.signal.aborted) return;
        let active = true;
        setWorkspaceResult(null);
        void mvReadTicketWorkspaces(runtime.signal).then(options => {
          if (active && !runtime.signal.aborted) setWorkspaceResult({ target: lookupTarget, options });
        }, error => {
          if (active && !runtime.signal.aborted) setWorkspaceResult({ target: lookupTarget, error: mvTaskError(error, '读取工单工作区失败') });
        });
        return () => { active = false; };
      }, [lookupTarget, runtime.signal]);
      const cannotSubmit = conflict || !text || text.length > 3000 || (!target && requiresTarget) || (needsRoom && !roomWorkspaceId);
      const submit = async event => {
        event.preventDefault();
        if (lock.current || status?.ok || cannotSubmit) return;
        // Keep the confirmed task IDs, but reject a link change observed while
        // the dialog was open rather than applying its old target to those IDs.
        const currentRows = runtime.tasks(agent.agentKey).getSnapshot().rows;
        const currentById = new Map(currentRows.map(task => [task.id, task]));
        if (tasks.some(task => currentById.has(task.id) &&
          (currentById.get(task.id).linkedTicketId || '') !== (task.linkedTicketId || ''))) {
          setStatus({ text: '任务关联已变更，请关闭弹窗后重新选择。' });
          return;
        }
        lock.current = true; setBusy(true); setStatus(null);
        let openingRoom = needsRoom;
        try {
          if (openingRoom) {
            const result = await fetchJson('marshal/task-rooms/open', { taskId: target, workspaceId: roomWorkspaceId }, true, runtime.signal);
            if (runtime.signal.aborted) return;
            if (!result?.room?.id) throw Error('未确认工单群已绑定。');
            openingRoom = false;
          }
          await mvSubmitGuidance({ agentKey: agent.agentKey, tasks, targetTicketId: target, guidanceText: text }, runtime.signal);
          if (runtime.signal.aborted) return;
          setStatus({ ok: true, text: target ? '已同步指导至 ' + mvTicketLabel(currentTicket) + '，已唤醒工单。' :
            '已同步指导至 1:1 直连会话。' });
          onSuccess?.();
          void runtime.refreshTasks(agent.agentKey);
        } catch (error) {
          if (!runtime.signal.aborted) setStatus({ text: openingRoom ? mvTaskError(error, '打开目标工单群失败') :
            error?.code === 'direct-session-not-found' ? '请先建立智能体的 1:1 直连会话。' : mvTaskError(error, '未确认同步，请先核对目标会话') });
        } finally { lock.current = false; if (!runtime.signal.aborted) setBusy(false); }
      };
      return h('dialog', { ref: dialogRef, className: 'mv-scope mv-dialog mv-guidance-dialog', 'aria-labelledby': 'mv-guidance-title',
        onCancel: event => { event.preventDefault(); close(); } },
        h('form', { className: 'mv-stack', onSubmit: submit },
          h('div', { className: 'mv-line' }, h('h2', { id: 'mv-guidance-title', className: 'mv-copy mv-voice-title' }, mvGuidanceLabel(currentTicket)),
            h(MvButton, { icon: 'close', iconOnly: true, label: '关闭同步指导', disabled: busy, onClick: close })),
          h('span', { className: 'mv-muted' }, '智能体：' + agent.name),
          h('div', { className: 'mv-actions' }, tasks.map(task => h('span', { key: task.id, className: 'mv-model' }, task.title)),
            !tasks.length && h('span', { className: 'mv-muted' }, '未绑定任务')),
          h('label', { className: 'mv-stack' }, '同步目标',
            h('select', { className: 'mv-field', value: target, required: requiresTarget, disabled: busy || status?.ok || Boolean(boundTarget),
              onChange: event => { setTarget(event.target.value); setChosenWorkspace(''); setInstructions({}); setStatus(null); } },
              h('option', { value: '' }, requiresTarget ? '请选择目标工单' : '智能体 1:1 直连会话'), mvTicketOptions(ticketOptions))),
          conflict ? h('p', { className: 'mv-danger', role: 'alert' }, MV_GUIDANCE_TICKET_CONFLICT) :
            !target && requiresTarget && h('p', { className: 'mv-muted' }, '请先选择工单，或返回任务清单改选直连任务。'),
          lookupTarget && (workspaceLookup?.error ? h('p', { className: 'mv-danger', role: 'alert' }, workspaceLookup.error) :
            !workspaceOptions ? h('p', { className: 'mv-muted', role: 'status' }, '正在读取工单工作区…') :
            !workspaceOptions.length ? h('p', { className: 'mv-danger', role: 'alert' }, '没有可用的工单工作区。') :
            workspaceOptions.length > 1 && h('label', { className: 'mv-stack' }, '工单群工作区',
              h('select', { className: 'mv-field', 'aria-label': '选择目标工单工作区', value: roomWorkspaceId ?? '',
                disabled: busy || status?.ok, onChange: event => { setChosenWorkspace(event.target.value); setStatus(null); } },
                h('option', { value: '' }, '请选择工单群工作区'),
                workspaceOptions.map(ws => h('option', { key: ws.id, value: ws.id }, ws.title || ws.name || ws.id))),
              !roomWorkspaceId && h('span', { className: 'mv-muted' }, '请先选择工单群工作区，再确认同步指导。'))),
          ticketError && h('span', { className: 'mv-muted', role: 'status' }, ticketError),
          h('label', { className: 'mv-stack' }, '决策要点', h('textarea', { className: 'mv-field', rows: 4, value: guidance,
            disabled: busy || status?.ok, maxLength: 3000, onChange: event => setGuidance(event.target.value) })),
          h('div', { className: 'mv-actions', role: 'group', 'aria-label': '@成员指令' }, names.map(name => h(MvButton, {
            key: name, label: '@' + name, className: 'mv-chip', disabled: busy || status?.ok, 'aria-pressed': Object.hasOwn(instructions, name),
            onClick: () => setInstructions(prev => { const next = { ...prev }; if (Object.hasOwn(next, name)) delete next[name]; else return { ...next, [name]: '' }; return next; }),
          }))),
          Object.entries(instructions).map(([name, value]) => h('label', { key: name, className: 'mv-stack' }, '@' + name + ' 的指令',
            h('input', { className: 'mv-field', value, maxLength: 512, disabled: busy || status?.ok,
              onChange: event => setInstructions(prev => ({ ...prev, [name]: event.target.value })) }))),
          text.length > 3000 && h('span', { className: 'mv-danger', role: 'status' }, '决策要点和成员指令合计不能超过 3000 字。'),
          status && h('div', { className: status.ok ? 'mv-online' : 'mv-danger', role: 'status' }, status.text),
          h('div', { className: 'mv-actions' }, status?.ok ? h(MvButton, { label: '完成', onClick: close }) :
            h(MvButton, { type: 'submit', icon: 'send', className: 'mv-guidance-action', label: busy ? '正在同步…' : '确认同步指导',
              disabled: busy || cannotSubmit }))));
    }
