    const MV_HUB_TASK_TOPICS = ['ready', 'tasks.changed', 'incidents.changed'];
    const MV_HUB_INCIDENTS = signal => fetchJson('marshal/incidents/summary', undefined, true, signal);
    const MV_HUB_KANBAN_READS = {
      board: signal => fetchJson('marshal/tasks/state', undefined, true, signal),
      incidents: MV_HUB_INCIDENTS,
      orchestration: signal => fetchJson('marshal/tasks/orchestration', undefined, true, signal),
      models: signal => fetchJson('api/task-board/model-catalog', undefined, false, signal),
      workspaces: signal => fetchJson('marshal/task-rooms/workspaces', undefined, true, signal),
    };

    function mvUseHubSnapshot(topics, reads, version) {
      const [snapshot, setSnapshot] = React.useState({ loading: true });
      const refresh = React.useRef(null);
      React.useEffect(() => {
        const visible = createVisibleMarshalRefresh(async signal => {
          const keys = Object.keys(reads);
          const results = await Promise.allSettled(keys.map(key => reads[key](signal)));
          if (signal.aborted) return;
          const patch = {};
          const errors = [];
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') patch[keys[index]] = result.value;
            else errors.push(result.reason?.message || String(result.reason));
          });
          setSnapshot(previous => ({ ...previous, ...patch, loading: false, error: errors.join('；') }));
        });
        refresh.current = visible.request;
        let stop;
        try { stop = subscribeMarshalEvents(topics, visible.request, { debounceMs: 80 }); }
        catch { /* The initial read and visibility refresh still work without SSE. */ }
        void visible.request();
        return () => { stop?.(); visible.dispose(); refresh.current = null; };
      }, [topics, reads, version]);
      return [snapshot, () => refresh.current?.(), patch => setSnapshot(previous => ({ ...previous, ...patch }))];
    }

    function mvHubPlainNotice(value) {
      return String(value ?? '').replace(/[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u{E0020}-\u{E007F}]/gu, '').trim();
    }

    function mvUseHubAction(refresh) {
      const lifetime = React.useRef(null);
      const pending = React.useRef(false);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNoticeText] = React.useState('');
      const setNotice = value => setNoticeText(mvHubPlainNotice(value));
      React.useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => controller.abort();
      }, []);
      const run = async work => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted || pending.current) return;
        pending.current = true;
        setBusy(true);
        setNotice('');
        try { await work(signal); }
        catch (error) { if (!signal.aborted) setNotice(error.message || String(error)); }
        finally {
          pending.current = false;
          if (!signal.aborted) { setBusy(false); void refresh(); }
        }
      };
      return { run, busy, notice, setNotice };
    }

    const MV_HUB_LANES = [['queued', '待办'], ['running', '运行中'], ['review', '待验收'], ['failed', '阻塞失败'], ['done', '已完成']];
    // One compact palette shared by tag pills, priority chips and card rails so a
    // ticket keeps the same colour in the lane, the drawer and the incident card.
    const MV_HUB_TONE_COLORS = ['#4e93e8', '#2ea36a', '#d08a2a', '#b456c8', '#cf5f7a', '#4a9fb5'];
    const MV_HUB_PRIORITY_COLORS = ['#cf5f7a', '#d08a2a', '#4e93e8', '#8b93a1'];
    function mvHubToneColor(name) {
      const tone = taskTagTone(name);
      return tone[0] === 'p' ? MV_HUB_PRIORITY_COLORS[Number(tone[1])] : MV_HUB_TONE_COLORS[Number(tone)] || MV_HUB_TONE_COLORS[0];
    }
    function mvHubToneChip(label, name, key, solid = false) {
      return h('span', { className: 'mv-tone-chip', key, 'data-solid': solid ? 'true' : undefined,
        style: { '--mv-tone': mvHubToneColor(name) } }, label);
    }
    const mvHubPriority = row => row.priority || row.tags?.find(tag => /^P[0-3]$/.test(tag.name))?.name;
    const mvHubPhase = (row, label) => taskPhases[row.workflow?.phase] || row.workflow?.phase || label;
    const mvHubTagNames = row => (row.tags ?? []).map(tag => tag.name).filter(name => name && !/^P[0-3]$/i.test(name)).slice(0, 3);
    const mvHubWorkspace = task => task.taskRoom?.workspaceId || task.workflow?.workspaceId || task.workspaceId || '';
    function mvHubLane(task) {
      const state = task.workflow?.state;
      if (task.status === 'done' || task.taskRoom?.closed) return 'done';
      if (['failed', 'permission-blocked', 'interrupted', 'cancelled'].includes(state) || task.permissionBlock || task.status === 'failed') return 'failed';
      if (state === 'running' || task.status === 'running' || task.openExecution) return 'running';
      if (['waiting', 'review-blocked', 'handed-off'].includes(state) || ['waiting', 'review'].includes(task.status)) return 'review';
      return state === 'done' ? 'done' : 'queued';
    }
    const mvHubIsLive = task => mvHubLane(task) === 'running' || Boolean(task?.openExecution);
    const mvHubIsTaskIncident = row => row.targetType === 'task' && ['failed', 'review-blocked', 'tool-anomaly'].includes(row.kind);
    const MV_HUB_PERMISSION_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };
    function mvHubHasPermissionBlock(task, incidentOrItems, sessionDefaultPermission = 'read-only', localBlocked = false) {
      if (task && mvHubLane(task) === 'done') return false;
      if (localBlocked || task?.permissionBlock || task?.workflow?.state === 'permission-blocked') return true;
      if (task && !task.archivedAt && task.permission && !task.permissionConfirmedAt &&
        (MV_HUB_PERMISSION_RANK[task.permission] ?? 0) > (MV_HUB_PERMISSION_RANK[sessionDefaultPermission] ?? 0)) return true;
      const rows = Array.isArray(incidentOrItems) ? incidentOrItems : incidentOrItems ? [incidentOrItems] : [];
      return rows.some(row => row && row.targetType === 'task' && (!task || row.targetId === task.id) &&
        (Boolean(row.permissionBlock) || (row.kind === 'failed' && Boolean(task) && task.status !== 'failed' &&
          task.workflow?.state !== 'failed' && !mvHubIsLive(task))));
    }
    const mvHubRunIssue = result => result.permissionBlocked || result.movedToReview || result.error || result.accepted === false
      ? result.ambiguityReason || result.permissionBlock?.summary || result.error?.message || result.error || result.message || '需人工确认'
      : '';
    function mvHubSelect(label, value, choices, onChange, disabled = false, empty = '默认') {
      return h(Field, { label }, h('select', { className: 'mv-field', 'aria-label': label, value, disabled, onChange: e => onChange(e.target.value) },
        h('option', { value: '' }, empty),
        value && !choices.some(([id]) => id === value) && h('option', { value }, value),
        choices.map(([id, text]) => h('option', { key: id, value: id }, text))));
    }
    function mvHubModelFields(label, config, models, change, disabled = false, fallback = '') {
      const efforts = models.find(model => model.route === (config.model || fallback))?.efforts;
      const available = [...new Set(['off', ...(efforts?.length ? efforts : ['low', 'medium', 'high', 'xhigh']), config.reasoningEffort].filter(Boolean))];
      return h('div', { className: 'mv-actions' },
        mvHubSelect(label + '模型', config.model || '', models.map(model => [model.route, model.label]), value => change({ model: value }), disabled),
        mvHubSelect(label + '思考模式', config.reasoningEffort || '', available.map(value => [value, value === 'off' ? '关闭' : value]),
          value => change({ reasoningEffort: value }), disabled));
    }
    function mvHubText(label, value, change, props = {}, element = 'input') {
      return h(Field, { label }, h(element, { className: 'mv-field', 'aria-label': label, value, onChange: e => change(e.target.value), ...props }));
    }
    const MV_HUB_ROLE_LABELS = { leader: 'Leader', coder: 'Coder', reviewer: 'Reviewer' };

    function MarshalHubKanbanView({ openSession, openTaskRoom, focusedTask, openNativeBoard, onOpenRosters }) {
      const [data, refresh, patchSnapshot] = mvUseHubSnapshot(MV_HUB_TASK_TOPICS, MV_HUB_KANBAN_READS);
      const action = mvUseHubAction(refresh);
      const [query, setQuery] = React.useState('');
      const [scope, setScope] = React.useState('');
      const [selected, select] = React.useState(focusedTask || '');
      const [form, setForm] = React.useState(null);
      const [edit, setEdit] = React.useState(null);
      const [blockedIds, setBlockedIds] = React.useState([]);
      const markBlocked = (taskId, blocked) => setBlockedIds(previous => blocked
        ? (previous.includes(taskId) ? previous : [...previous, taskId])
        : previous.filter(id => id !== taskId));
      const tasks = (data.board?.tasks ?? []).filter(row => row.archivedAt == null);
      const workspaceRows = (data.workspaces?.workspaces ?? []).filter(row => !isPseudoAgentWorkspace(row));
      const workspaceOptions = workspaceRows.map(row => [row.id, row.name || row.title || row.id]);
      const models = flattenModelCatalog(data.models);
      const task = tasks.find(row => row.id === selected);
      const editing = task && edit?.taskId === task.id;
      const permissionBlocked = mvHubHasPermissionBlock(task, data.incidents?.items, data.board?.sessionDefaultPermission, Boolean(task && blockedIds.includes(task.id)));
      const keyword = query.trim().toLowerCase();
      const visible = tasks.filter(row => (!scope || scope === mvHubWorkspace(row)) &&
        [row.title, row.ticketNo, row.id, row.description].some(value => String(value ?? '').toLowerCase().includes(keyword)));
      const lanes = MV_HUB_LANES.map(([id, label]) => [id, label, visible.filter(row => mvHubLane(row) === id)]);
      const focusReady = !!focusedTask && tasks.some(row => row.id === focusedTask);
      React.useEffect(() => { if (focusedTask) select(focusedTask); }, [focusedTask]);
      const scrollToTask = React.useLayoutEffect || React.useEffect;
      scrollToTask(() => {
        if (focusReady) document.getElementById?.('marshal-ticket-' + focusedTask)?.scrollIntoView?.({ block: 'nearest' });
      }, [focusedTask, focusReady]);
      const chooseTask = row => { select(row.id); setEdit(null); action.setNotice(''); };
      const applyBoard = result => { if (Array.isArray(result.tasks)) patchSnapshot({ board: { ...data.board, ...result } }); };
      const mutate = (path, body) => action.run(async signal => {
        const result = await fetchJson(path, body, true, signal);
        if (!signal.aborted) {
          applyBoard(result);
          if (path === 'marshal/tasks/run' && body?.taskId) markBlocked(body.taskId, Boolean(result.permissionBlocked));
          if (path === 'marshal/tasks/confirm-permission' && body?.taskId && !result.permissionBlocked) markBlocked(body.taskId, false);
          action.setNotice(mvHubRunIssue(result) || result.notice || result.message || '已保存');
        }
      });
      const detailFields = row => {
        const wf = row.workflow;
        if (!wf) return mvHubModelFields('工单', row, models.options, patch => mutate('marshal/tasks/update', { taskId: row.id, ...patch }), action.busy, models.defaultRoute);
        const configs = { ...wf.agentConfigs, ...wf.plan?.agentConfigs };
        const leaders = data.orchestration?.leaders ?? [];
        const roles = Object.entries(MV_HUB_ROLE_LABELS);
        const codexModels = (data.orchestration?.codexModels ?? []).map(model => ({ route: model.id, efforts: model.reasoningEfforts, label: model.model }));
        const change = (role, patch) => mutate('marshal/tasks/agent-configs', { taskId: row.id, agentConfigs: { [role]: patch } });
        return h('div', { className: 'mv-stack' },
          roles.map(([role, label]) => h('div', { key: role }, mvHubModelFields(label + ' ', configs[role] ?? {}, models.options,
            patch => change(role, patch), action.busy, leaders.find(member => member.id === (role === 'leader' ? wf.leaderId : wf.plan?.members?.[role]))?.model || models.defaultRoute))),
          wf.plan?.codex && [['coding', 'codexCoding', 'Codex · 编码执行子 Agent'], ['review', 'codexReview', 'Codex · 审查复核子 Agent']].map(([slot, key, label]) => {
            const mode = wf.plan.codex[slot];
            const efforts = codexModels.find(model => model.route === mode)?.efforts ?? ['low', 'medium', 'high', 'xhigh'];
            return h('div', { key, className: 'mv-actions' },
              mvHubSelect(label + ' 模型', mode === null ? 'off' : mode || '', [['off', '关闭'], ...codexModels.map(model => [model.route, model.label])],
                value => mutate('marshal/tasks/agent-configs', { taskId: row.id,
                  codex: { [slot]: value === 'off' ? null : value || 'auto' }, agentConfigs: { [key]: { model: value === 'off' ? '' : value } },
                }), action.busy, '自动'),
              mvHubSelect(label + ' 思考模式', configs[key]?.reasoningEffort || '', efforts.map(value => [value, value]),
                value => change(key, { reasoningEffort: value }), action.busy || mode === null));
          }));
      };
      const saveEdit = steerNow => {
        if (!editing) return;
        const { taskId: targetId, revision: submitRevision, draft: submittedDraft, original } = edit;
        if (!edit.dirty) { action.setNotice('没有需要保存的修改'); return; }
        const patch = Object.fromEntries(Object.entries(submittedDraft).filter(([key, value]) => value !== original[key]));
        void action.run(async signal => {
          const result = await fetchJson('marshal/tasks/update', { taskId: targetId, ...patch, steerNow: Boolean(steerNow) }, true, signal);
          if (!signal.aborted) {
            applyBoard(result);
            if (!result.error && result.ok !== false) setEdit(current => {
              if (current?.taskId !== targetId) return current;
              if (current.revision === submitRevision && current.draft === submittedDraft) return null;
              if (current.original !== original) return current;
              // Preserve newer edits while diffing the next save against the submitted values.
              return { ...current, original: submittedDraft,
                dirty: Object.keys(current.draft).some(key => current.draft[key] !== submittedDraft[key]) };
            });
            action.setNotice(result.notice || (result.steered ? '已保存并发送插话' : '已保存'));
          }
        });
      };
      const beginEdit = () => {
        const values = { title: task.title, description: task.description ?? '', prompt: task.prompt ?? '' };
        setEdit({ taskId: task.id, revision: 0, original: values, draft: values, dirty: false });
      };
      const changeEdit = (key, value) => setEdit(current => {
        if (current?.taskId !== task.id || current.draft[key] === value) return current;
        const draft = { ...current.draft, [key]: value };
        return { ...current, revision: current.revision + 1, draft,
          dirty: Object.keys(draft).some(field => draft[field] !== current.original[field]) };
      });
      const openForm = row => { setForm({ task: row, workspace: (row && mvHubWorkspace(row)) || scope || (workspaceRows.length === 1 ? workspaceRows[0].id : '') }); action.setNotice(''); };
      return h('section', { className: 'mv-scope mv-room', 'aria-label': '工单看板' },
        h('header', { className: 'mv-actions' }, h('h2', { className: 'mv-copy mv-voice-title' }, '工单看板'),
          openNativeBoard && h(MvButton, { label: '原生看板', onClick: openNativeBoard }),
          onOpenRosters && h(MvButton, { label: '默认阵容', onClick: onOpenRosters }),
          h(MvButton, { label: '新建工单', onClick: () => openForm() })),
        h('div', { className: 'mv-actions' }, mvHubText('搜索工单', query, setQuery, { type: 'search' }),
          mvHubSelect('筛选工作区', scope, workspaceOptions, setScope, false, '全部工作区')),
        h('div', { className: 'mv-actions', 'aria-label': '工单统计' }, h('strong', null, '共 ' + visible.length),
          lanes.map(([id, label, rows]) => h('span', { className: 'mv-model', key: id }, label + ' ' + rows.length))),
        data.loading && h('p', { role: 'status' }, '正在读取工单…'),
        data.error && h('div', { role: 'alert' }, data.error, h(MvButton, { label: '刷新', onClick: refresh })),
        action.notice && !form && h('p', { role: 'status' }, action.notice),
        h('div', { className: 'mv-room-fill', style: { flexWrap: 'wrap', alignContent: 'start', gap: 'var(--mv-md)' } },
          h('div', { className: 'mv-copy', style: { display: 'grid', flex: '1 1 var(--mv-float-width)', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, calc(10 * var(--mv-lg))), 1fr))', gap: 'var(--mv-sm)', alignItems: 'start' } },
            lanes.map(([id, label, rows]) => h('section', { key: id, 'aria-label': label },
              h('h3', { className: 'mv-lane-head' }, h('span', { className: 'mv-tone-dot', 'data-tone': id }),
                label, h('span', { className: 'mv-tone-count' }, rows.length)),
              rows.map(row => h('article', { id: 'marshal-ticket-' + row.id, key: row.id, className: 'mv-agent-card',
                'data-tone': id, onClick: () => chooseTask(row) },
                h('button', { type: 'button', className: 'mv-row', 'aria-pressed': task?.id === row.id, onClick: event => { event.stopPropagation(); chooseTask(row); } }, row.title),
                h('div', { className: 'mv-tag-row' }, h('span', { className: 'mv-muted' }, row.ticketNo || row.id),
                  [mvHubPriority(row), mvHubPhase(row, label)].filter(Boolean)
                    .map((text, index) => mvHubToneChip(text, text, 'state-' + index, index === 0)),
                  mvHubTagNames(row).map((name, index) => mvHubToneChip(name, name, 'tag-' + index))),
                h(MvButton, { label: '工单群', 'aria-label': '进入工单群 · ' + row.title, onClick: event => { event.stopPropagation(); openTaskRoom(row); } })))))),
          task && h('aside', { className: 'mv-drawer mv-stack', style: { flex: '1 1 var(--mv-float-width)', height: 'auto', boxSizing: 'border-box', overflowWrap: 'anywhere' }, 'aria-label': '工单详情' },
            h('div', { className: 'mv-actions' }, h('strong', { className: 'mv-copy' }, task.title), h(MvButton, { label: '关闭', onClick: () => { select(''); setEdit(null); } })),
            h('div', { className: 'mv-muted' }, task.ticketNo || task.id),
            !editing && h('div', { style: { whiteSpace: 'pre-wrap' } }, task.description),
            mvHubIsLive(task) && h('div', { className: 'mv-muted' }, '运行中可随时切换 · 下一轮生效并通知工单群'),
            detailFields(task),
            h('div', { className: 'mv-actions' },
              h(MvButton, { label: '进入工单群', onClick: () => openTaskRoom(task) }),
              task.sessionId && openSession && h(MvButton, { label: '执行会话', onClick: () => openSession(task.sessionId) }),
              !editing && h(MvButton, { label: mvHubIsLive(task) ? '实时编辑' : '编辑', onClick: beginEdit }),
              !task.workflow && !mvHubIsLive(task) && mvHubLane(task) !== 'done' && h(MvButton, {
                label: permissionBlocked || mvHubLane(task) === 'failed' ? '重试运行' : '运行工单', disabled: action.busy,
                onClick: () => mutate('marshal/tasks/run', { taskId: task.id }),
              }),
              permissionBlocked && mvHubLane(task) !== 'done' && h(MvButton, { label: '单次放行', disabled: action.busy,
                onClick: () => mutate('marshal/tasks/confirm-permission', { taskId: task.id }),
              }),
              !task.workflow && h(MvButton, { label: '启用编排', onClick: () => openForm(task) })),
            editing && h('div', { className: 'mv-stack' },
              ...[['title', '标题', 'input'], ['description', '描述', 'textarea'], ['prompt', '执行指令', 'textarea']].map(([key, label, element]) =>
                h('div', { key }, mvHubText(label, edit.draft[key], value => changeEdit(key, value), {}, element))),
              h('div', { className: 'mv-actions' }, h(MvButton, { label: '保存', disabled: action.busy, onClick: () => saveEdit(false) }),
                mvHubIsLive(task) && h(MvButton, { label: '保存并立即插话发送', disabled: action.busy, onClick: () => saveEdit(true) }),
                h(MvButton, { label: '取消', onClick: () => setEdit(null) })),
              mvHubIsLive(task) && h('div', { className: 'mv-muted' }, '立即以插话形式将修改后的内容发送给正在运行的 Agent')))),
        form && h(mvHubTicketForm, { form, workspaceRows, workspaceOptions, models, catalog: data.orchestration,
          close: () => { setForm(null); action.setNotice(''); }, action, applyBoard, markBlocked }));
    }

    function mvHubTicketForm({ form, workspaceRows, workspaceOptions, models, catalog, close, action, applyBoard, markBlocked }) {
      const dialog = React.useRef(null);
      const heading = React.useId();
      const [draft, setDraft] = React.useState({ title: '', description: '', workspaceId: form.workspace, template: '', leaderId: '', prUrl: '', members: {}, configs: {}, path: ['', '', ''], run: false });
      const [context, setContext] = React.useState({ links: {}, attachments: [] });
      const latestContext = React.useRef(context);
      const changeContext = next => { latestContext.current = next; setContext(next); };
      const upload = React.useRef({ pending: false, uploadFailures: [] });
      const [uploadState, setUploadState] = React.useState(upload.current);
      const changeUploadState = (pending, failures = [], discardFailures = false) => {
        const next = { pending, uploadFailures: discardFailures ? [] : [...upload.current.uploadFailures, ...failures.map(mvHubPlainNotice)] };
        upload.current = next;
        setUploadState(next);
      };
      React.useEffect(() => {
        const node = dialog.current;
        const previous = document.activeElement;
        node?.showModal();
        return () => { if (node?.open) node.close(); previous?.focus(); };
      }, []);
      const update = patch => setDraft(previous => ({ ...previous, ...patch }));
      const change = key => value => update({ [key]: value });
      const templates = [catalog?.plainTemplate, ...(catalog?.templates ?? [])].filter(Boolean);
      const template = templates.find(row => row.id === draft.template);
      const codeWork = template?.id === 'development';
      const slots = ((codeWork ? template?.codingRoles : template?.roles) ?? []).filter(role => role.id !== 'codexCritic');
      const leaders = (catalog?.leaders ?? []).filter(row => row.global || row.workspaceId === draft.workspaceId);
      const members = leaders.map(row => [row.id, row.name]);
      const isOrchestrated = !!template;
      const submit = event => {
        event.preventDefault();
        if (upload.current.pending || upload.current.uploadFailures.length) return;
        const { links, attachments } = latestContext.current;
        const title = draft.title.trim();
        const description = draft.description.trim();
        const cascadePath = draft.path.map(value => value.trim());
        const prUrl = draft.prUrl.trim();
        if (!form.task && !title) { action.setNotice('请填写标题'); return; }
        if (cascadePath.some(Boolean) && !cascadePath.every(Boolean)) { action.setNotice('请填写完整的三级分类'); return; }
        if ((form.task || isOrchestrated) && (!template || !draft.workspaceId || !draft.leaderId || slots.some(role => role.required && !draft.members[role.id]))) {
          action.setNotice('请选择工作区、编排模板并指派必需角色'); return;
        }
        if (template?.id === 'pr-review' && !prUrl) { action.setNotice('请填写 PR 链接'); return; }
        const orchestration = template && {
          workspaceId: draft.workspaceId, leaderId: draft.leaderId, choice: template.id === 'none' ? 'none' : 'template',
          ...(template.id !== 'none' ? { templateId: template.id } : {}), ...(prUrl ? { prUrl } : {}),
          plan: { templateId: template.id, codeWork, members: Object.fromEntries(Object.entries(draft.members).filter(([, id]) => id)), agentConfigs: draft.configs },
        };
        void action.run(async signal => {
          const before = !form.task && draft.run ? await fetchJson('marshal/tasks/state', undefined, true, signal) : null;
          const result = form.task ? await fetchJson('marshal/tasks/plan', { taskId: form.task.id, orchestration }, true, signal)
            : await fetchJson('marshal/tasks/create', { title, description,
              ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}), ...(orchestration ? { orchestration } : {}),
              ...(cascadePath.every(Boolean) ? { cascadePath } : {}), links,
              attachments: attachments.map(serializeAttachmentForWire) }, true, signal);
          if (signal.aborted) return;
          applyBoard(result);
          close();
          if (!before) { action.setNotice(form.task ? '已启用编排' : '工单已创建'); return; }
          if (result.movedToReview) { action.setNotice('工单已创建，内容待确认，未立即运行'); return; }
          const known = new Set((before.tasks ?? []).map(row => row.id));
          const added = (result.tasks ?? []).filter(row => !known.has(row.id));
          const created = added.length === 1 && added[0];
          // Older hosts return a snapshot, not a created ID. Never run an ambiguous match.
          if (!created || created.title !== title || mvHubWorkspace(created) !== draft.workspaceId) {
            action.setNotice('工单已创建，无法确认运行目标，请从工单群手动启动'); return;
          }
          try {
            const running = await fetchJson('marshal/tasks/run', { taskId: created.id }, true, signal);
            if (!signal.aborted) {
              applyBoard(running);
              markBlocked?.(created.id, Boolean(running.permissionBlocked));
              const issue = mvHubRunIssue(running);
              action.setNotice(issue ? '工单已创建，运行受阻或人工确认：' + issue : '工单已创建并启动');
            }
          } catch (error) { if (!signal.aborted) action.setNotice('工单已创建，启动请求未确认：' + error.message); }
        });
      };
      const roleOptions = role => leaders.filter(row => row.id !== draft.leaderId &&
        (role !== 'coder' || ['workspace-write', 'danger-full-access'].includes(row.permission)) &&
        !Object.entries(draft.members).some(([key, id]) => key !== role && row.id === id)).map(row => [row.id, row.name]);
      const configFields = (id, label) => mvHubModelFields(label + ' ', draft.configs[id] ?? {}, models.options,
        patch => update({ configs: { ...draft.configs, [id]: { ...draft.configs[id], ...patch } } }), action.busy, models.defaultRoute);
      return h('dialog', { ref: dialog, className: 'mv-scope mv-dag-dialog', 'aria-labelledby': heading,
        onCancel: event => { event.preventDefault(); if (!action.busy) close(); } },
        h('header', { className: 'mv-dag-header' }, h('strong', { id: heading }, form.task ? '启用编排' : '新建工单'),
          h(MvButton, { icon: 'close', iconOnly: true, label: '关闭', disabled: action.busy, onClick: close })),
        h('form', { className: 'mv-dag-dialog-body mv-stack', onSubmit: submit },
          !form.task && mvHubText('工单标题', draft.title, change('title'), { required: true, autoFocus: true }),
          !form.task && mvHubText('工单描述', draft.description, change('description'), {}, 'textarea'),
          mvHubSelect('工作区', draft.workspaceId, workspaceOptions, value => update({ workspaceId: value, leaderId: '', members: {} }),
            !!(form.task && form.workspace) || action.busy, '选择工作区'),
          !form.task && h('div', { className: 'mv-actions', 'aria-label': '工单分类路径' }, draft.path.map((value, index) =>
            h('div', { key: index }, mvHubText(['一级分类', '二级分类', '三级分类'][index], value,
              next => update({ path: draft.path.map((part, i) => i === index ? next : part) }), { maxLength: 128 })))),
          mvHubSelect('编排模板', draft.template, templates.map(row => [row.id, row.name]), value => update({ template: value, members: {}, configs: {} }),
            action.busy, form.task ? '选择模板' : '不启用编排'),
          isOrchestrated && h('div', { className: 'mv-stack' },
            template.id === 'pr-review' && mvHubText('PR 链接', draft.prUrl, change('prUrl'), { type: 'url', required: true }),
            mvHubSelect('Leader 人选', draft.leaderId, members, value => update({ leaderId: value, members: {} }), action.busy, '选择 Leader'),
            configFields('leader', 'Leader'),
            slots.map(role => h('div', { key: role.id, className: 'mv-stack' },
              mvHubSelect(role.name + ' 人选', draft.members[role.id] || '', roleOptions(role.id), value => update({ members: { ...draft.members, [role.id]: value } }),
                action.busy, role.required ? '请选择' : '暂不指派'), configFields(role.id, role.name)))),
          !form.task && h(mvCascadePicker.MarshalCascadeContextPicker, { workspaces: workspaceRows, value: context,
            onChange: changeContext, onUploadState: changeUploadState, disableUpload: action.busy }),
          uploadState.uploadFailures.length > 0 && h('div', { role: 'alert' }, '附件上传失败：' + uploadState.uploadFailures.join('；'),
            h(MvButton, { label: '仅保留已上传附件', disabled: uploadState.pending, onClick: () => {
              if (!upload.current.pending) changeUploadState(false, [], true);
            } })),
          !form.task && h('label', { className: 'mv-line' }, h('input', { type: 'checkbox', checked: draft.run, onChange: e => change('run')(e.target.checked) }), '创建后立即运行'),
          action.notice && h('p', { role: 'alert' }, action.notice),
          h('button', { className: 'mv-btn', type: 'submit', disabled: action.busy || uploadState.pending || uploadState.uploadFailures.length > 0 }, form.task ? '保存编排' : '创建工单')));
    }
