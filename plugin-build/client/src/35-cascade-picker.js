    const MV_CASCADE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
    const MV_CONTEXT_KINDS = [
      ['sessions', '近期会话'], ['tickets', '关联工单'], ['memory', '记忆片段'], ['files', '本地文件/附件'],
    ];
    const MV_LINK_KEYS = ['sessionIds', 'proposalIds', 'docPaths'];
    const MV_ATTACHMENT_LIMIT = 8;
    const MV_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;
    // Keep in sync with AGENT_CONFIG_SLOTS in groups/task-plans.
    const MV_AGENT_CONFIG_SLOTS = new Set([
      'leader', 'coder', 'reviewer', 'critic', 'codexCritic', 'writer', 'researcher',
      'checker', 'collaborator', 'codexCoding', 'codexReview',
    ]);

    function mvUsePickerPopup() {
      const [open, setOpen] = React.useState(false);
      const root = React.useRef(null);
      const id = React.useId();
      React.useEffect(ensureMarshalVnextStyles, []);
      React.useEffect(() => {
        if (!open) return;
        const panel = root.current?.querySelector('.mv-picker-popover');
        const place = () => {
          if (!panel) return;
          const start = root.current?.getBoundingClientRect().left;
          if (start === undefined) return;
          const viewport = document.documentElement.clientWidth;
          panel.style.setProperty('--mv-picker-offset', Math.min(0, viewport - start - panel.offsetWidth) + 'px');
        };
        place();
        const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false); };
        document.addEventListener('pointerdown', dismiss);
        window.addEventListener('resize', place);
        return () => {
          document.removeEventListener('pointerdown', dismiss);
          window.removeEventListener('resize', place);
        };
      }, [open]);
      const close = () => { setOpen(false); root.current?.querySelector('.mv-picker-trigger')?.focus(); };
      return { open, setOpen, id, close, rootProps: { ref: root, onKeyDown: event => {
        if (open && event.key === 'Escape') { event.stopPropagation(); close(); }
      } } };
    }

    function mvPickerTrigger(popup, label) {
      return h(MvButton, { className: 'mv-picker-trigger', 'aria-expanded': popup.open, 'aria-controls': popup.open ? popup.id : undefined,
        onClick: () => popup.setOpen(!popup.open) }, label,
        h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
          h('path', { d: 'M2 4h8L6 8Z', fill: 'currentColor' })));
    }

    function mvPickerColumn(label, children) {
      return h('section', { className: 'mv-cascade3-col', 'aria-label': label },
        h('strong', { className: 'mv-cascade3-label' }, label), children);
    }

    function mvPickerChoice(key, label, selected, onClick, subtitle, disabled) {
      return h('button', { key, type: 'button', className: 'mv-cascade3-choice', 'aria-pressed': selected, disabled, onClick },
        h('span', null, label), subtitle && h('small', null, subtitle));
    }

    function mvAgentConfigSlot(agent, workflow) {
      if (!agent) return undefined;
      if (MV_AGENT_CONFIG_SLOTS.has(agent.configKey)) return agent.configKey;
      if (agent.id && workflow?.leaderId === agent.id) return 'leader';
      const slots = Object.entries(workflow?.plan?.members ?? {}).filter(([slot, memberId]) =>
        agent.id && memberId === agent.id && MV_AGENT_CONFIG_SLOTS.has(slot));
      return slots.length === 1 ? slots[0][0] : undefined;
    }

    // Each agent has { id, name, role, status, configKey?, models: [{ route, label?, efforts? }] }.
    // task.workflow can resolve a slot when configKey isn't supplied. Without a
    // task + slot, onApply is the persistence adapter rather than a notification.
    function mvAgentModelCascade({ agents = [], task, taskId = task?.id, onApply, onSaved }) {
      const popup = mvUsePickerPopup();
      const [agentKey, setAgentKey] = React.useState('');
      const [modelRoute, setModelRoute] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const pending = React.useRef(false);
      const agent = agents.find(row => row.id === agentKey);
      const models = agent?.models ?? [];
      const model = models.find(row => row.route === modelRoute);
      const efforts = model ? MV_CASCADE_EFFORTS.filter(id => id === 'off' || !Array.isArray(model.efforts) || model.efforts.includes(id)) : [];
      const slot = mvAgentConfigSlot(agent, task?.id === taskId ? task?.workflow : undefined);
      const saveToTask = Boolean(taskId && slot);
      const canApply = saveToTask || typeof onApply === 'function';
      const apply = async reasoningEffort => {
        if (!agent || !model || !canApply || pending.current) return;
        pending.current = true;
        setBusy(true);
        setError('');
        try {
          const config = { model: model.route, reasoningEffort };
          const selection = { agentId: agent.id, ...config };
          let result;
          if (saveToTask) {
            const saving = fetchJson('marshal/tasks/agent-configs', {
              taskId, agentConfigs: { [slot]: config },
            }, true);
            void Promise.resolve().then(() => onApply?.(selection)).catch(failure => {
              setError(failure.message || String(failure));
            });
            result = await saving;
          } else if (await onApply?.(selection) === false) throw new Error('未能应用模型配置。');
          popup.close();
          await onSaved?.(result, selection);
        } catch (failure) { setError(failure.message || String(failure)); }
        finally { pending.current = false; setBusy(false); }
      };
      return h('div', { ...popup.rootProps, className: 'mv-scope mv-picker' },
        mvPickerTrigger(popup, `Agent 模型与思考 (${agents.length})`),
        popup.open && h('div', { className: 'mv-picker-popover', id: popup.id, 'aria-label': 'Agent 模型与思考', role: 'group' },
          h('div', { className: 'mv-cascade3-grid' },
            mvPickerColumn('Agent', agents.length ? agents.map(row => mvPickerChoice(row.id, row.name || row.id, row.id === agentKey,
              () => { setAgentKey(row.id); setModelRoute(''); setError(''); }, [row.role, row.status].filter(Boolean).join(' · '), busy)) : '暂无 Agent'),
            mvPickerColumn('模型', models.length ? models.map(row => mvPickerChoice(row.route, row.label || row.route, row.route === modelRoute,
              () => { setModelRoute(row.route); setError(''); }, undefined, busy)) : (agent ? '暂无可选模型' : '请选择 Agent')),
            mvPickerColumn('思考强度', efforts.length ? efforts.map(id => mvPickerChoice(id, id,
              agent.model === model.route && agent.reasoningEffort === id, () => void apply(id), undefined, busy || !canApply)) : '请选择模型')),
          busy && h('div', { role: 'status' }, '正在保存配置…')),
        error && h('div', { role: 'alert' }, error));
    }

    function mvValidatePickerAttachmentBudget(selected, chosen = []) {
      if (selected.length + chosen.length > MV_ATTACHMENT_LIMIT) throw new Error('最多添加 8 个附件。');
      const total = selected.reduce((sum, item) => {
        if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error('无法确认已选附件的大小，请移除后重新添加。');
        return sum + item.bytes;
      }, 0) + chosen.reduce((sum, file) => sum + file.size, 0);
      if (total > MV_ATTACHMENT_TOTAL_BYTES) throw new Error('附件总大小不能超过 32 MiB。');
    }

    // Pass the currently selected wire attachments to validate the entire
    // selection before uploading. Retain successful uploads on partial failure.
    async function mvUploadPickerAttachments(e, selected = [], signal) {
      const chosen = Array.from(e.target.files || []);
      e.target.value = '';
      for (const file of chosen) {
        if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024) {
          throw new Error('文件「' + file.name + '」为空或超过 10 MB 限制。');
        }
      }
      mvValidatePickerAttachmentBudget(selected, chosen);
      const results = await Promise.allSettled(chosen.map(async file => {
        const mediaType = inferAttachmentMediaType(file);
        const kind = /^image\/(png|jpeg|webp|gif)$/.test(mediaType) ? 'image' : 'file';
        const qs = new URLSearchParams({ kind, name: file.name || 'attachment', mediaType });
        const response = await fetch(new URL('api/task-board/attachments/upload?' + qs, document.baseURI), {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file, signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.attachment) throw new Error(data?.error || data?.message || ('HTTP ' + response.status));
        return serializeAttachmentForWire(data.attachment);
      }));
      return { attachments: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
        errors: results.flatMap((result, i) => result.status === 'rejected'
          ? [chosen[i].name + '：' + (result.reason?.message || result.reason)] : []) };
    }

    function mvContextLinkValid(key, id) {
      return typeof id === 'string' && id.length <= 256 && id === id.trim() && !/[\x00-\x1f\x7f]/.test(id) && (key === 'docPaths'
        ? !/[:\\%]/.test(id) && id.split('/').every(part => part && part !== '.' && part !== '..')
        : !!id && !/[\\/]/.test(id));
    }

    async function mvReadContextRows(scopeId, kind, scopedAgentKey, signal) {
      if (kind === 'sessions') {
        const direct = Boolean(scopeId && scopedAgentKey);
        const data = await fetchJson(direct ? 'marshal/agent-direct-sessions?' + new URLSearchParams({ agentKey: scopedAgentKey })
          : 'marshal/agents/sessions', undefined, true, signal);
        const rows = direct ? [data.mainSession, ...(data.subSessions ?? [])].filter(Boolean) : data.sessions ?? [];
        return rows.filter(row => !row.archived && (direct || !scopeId || row.workspaceId === scopeId))
          .map(row => ({ key: 'sessionIds', id: row.sessionId ?? row.id, label: row.title || row.sessionId || row.id, subtitle: row.agentName || row.status }));
      }
      if (kind === 'tickets') {
        const { tasks = [] } = await fetchJson('marshal/tasks/state', undefined, true, signal);
        return tasks.filter(row => !scopeId || (row.taskRoom?.workspaceId ?? row.workflow?.workspaceId ?? row.workspaceId) === scopeId)
          .map(row => ({ key: 'proposalIds', id: row.id, label: row.title || row.id, subtitle: row.ticketNo }));
      }
      const query = new URLSearchParams(scopeId ? { scope: 'workspace', workspaceId: scopeId } : { scope: 'global' });
      const { items = [] } = await fetchJson('marshal/memory/list?' + query, undefined, true, signal);
      return items.map((row, index) => {
        const proposalId = row.proposalId || row.id;
        const key = row.docPath ? 'docPaths' : mvContextLinkValid('proposalIds', proposalId) ? 'proposalIds' : 'sessionIds';
        const id = key === 'docPaths' ? row.docPath : key === 'proposalIds' ? proposalId : row.sourceSession;
        const scopeTag = scopeId || 'global';
        const itemKey = row.id || row.proposalId || row.docPath || (row.sourceSession ? 'src:' + row.sourceSession + ':' + index : 'idx:' + index);
        const rowId = 'memory:' + scopeTag + ':' + (row.key || '') + ':' + itemKey;
        return { key, id, rowId, label: row.title || row.id, subtitle: row.content, memory: row };
      });
    }

    // value/onChange use { links: { sessionIds, proposalIds, docPaths }, attachments }.
    // directAgentSessions opts in to agent-only sessions in its workspace (never globally).
    // resolveMemoryLink(item) may return { key, id } for host-backed memory.
    function mvCascadeContextPicker({ workspaces, agentKey, agentWorkspaceId, directAgentSessions = false, value, onChange, resolveMemoryLink, onUploadState, disableUpload }) {
      const popup = mvUsePickerPopup();
      const [scopeId, setScopeId] = React.useState(null);
      const [kind, setKind] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [host, setHost] = React.useState({ rows: [], loading: true });
      const [result, setResult] = React.useState(null);
      const [stored, setStored] = React.useState({ links: {}, attachments: [] });
      const [storedRows, setStoredRows] = React.useState(() => new Map());
      const [uploading, setUploading] = React.useState(false);
      const [uploadFailures, setUploadFailures] = React.useState([]);
      const [uploadValidation, setUploadValidation] = React.useState('');
      const [error, setError] = React.useState('');
      const [retry, setRetry] = React.useState(0);
      const pending = React.useRef(false);
      const lifetime = React.useRef(null);
      const current = React.useRef(null);
      const activeValue = value ?? stored;
      const links = Object.fromEntries(MV_LINK_KEYS.map(key => [key, activeValue.links?.[key] ?? []]));
      const attachments = activeValue.attachments ?? [];
      // Multiple selected rows can own the same deduplicated wire link.
      const selectedRows = new Map([...storedRows].filter(([, { key, id }]) => links[key].includes(id)));
      const hasReference = (rows, key, id) => {
        for (const row of rows.values()) if (row.key === key && row.id === id) return true;
        return false;
      };
      current.current = { links, attachments, onChange, selectedRows, onUploadState };
      React.useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        if (pending.current) {
          pending.current = false;
          setUploading(false);
          current.current.onUploadState?.(false);
        }
        return () => controller.abort();
      }, [disableUpload]);
      const commit = (nextLinks, nextAttachments) => {
        const next = { links: nextLinks, attachments: nextAttachments };
        current.current = { ...current.current, ...next };
        setStored(next);
        current.current.onChange?.(next);
      };
      const scopes = [{ id: '', title: '全局上下文' }, ...(workspaces ?? host.rows).filter(row => row.id && !isPseudoAgentWorkspace(row))];
      const scope = scopes.find(row => row.id === scopeId);
      const hasScope = !!scope;
      const scopedAgentKey = directAgentSessions && scopeId && scopeId === agentWorkspaceId ? agentKey : undefined;
      const requestKey = JSON.stringify([scopeId, kind, scopedAgentKey, retry]);
      React.useEffect(() => {
        if (!popup.open || workspaces) return;
        const controller = new AbortController();
        setHost(previous => ({ rows: previous.rows, loading: true }));
        void fetchJson('marshal/task-rooms/workspaces', undefined, true, controller.signal).then(data => {
          if (!controller.signal.aborted) setHost({ rows: data.workspaces ?? [] });
        }).catch(failure => {
          if (!controller.signal.aborted) setHost({ rows: [], error: failure.message || String(failure) });
        });
        return () => controller.abort();
      }, [popup.open, workspaces, retry]);
      React.useEffect(() => {
        if (!popup.open || !hasScope || !kind || kind === 'files') return;
        const controller = new AbortController();
        setResult(null);
        void mvReadContextRows(scopeId, kind, scopedAgentKey, controller.signal).then(rows => {
          if (!controller.signal.aborted) setResult({ requestKey, rows });
        }).catch(failure => {
          if (!controller.signal.aborted) setResult({ requestKey, error: failure.message || String(failure) });
        });
        return () => controller.abort();
      }, [popup.open, hasScope, requestKey]);
      const toggle = (rowKey, ref, label) => {
        const { links, attachments, selectedRows } = current.current;
        const { key, id } = selectedRows.get(rowKey) ?? ref;
        const existing = links[key];
        if (!existing.includes(id) && existing.length >= 32) { setError('每类上下文最多添加 32 条。'); return; }
        setError('');
        const nextRows = new Map(selectedRows);
        const remove = nextRows.delete(rowKey) ||
          (rowKey === key + ':' + id && existing.includes(id) && !hasReference(selectedRows, key, id));
        if (!remove) nextRows.set(rowKey, { key, id, label: label || id });
        current.current.selectedRows = nextRows;
        setStoredRows(nextRows);
        let nextIds = existing;
        if (remove && !hasReference(nextRows, key, id)) nextIds = existing.filter(item => item !== id);
        else if (!remove && !existing.includes(id)) nextIds = [...existing, id];
        commit({ ...links, [key]: nextIds }, attachments);
      };
      const upload = async e => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted || pending.current || disableUpload) return;
        pending.current = true;
        setUploading(true);
        setUploadValidation('');
        const failures = [];
        let validation = '';
        try {
          const request = mvUploadPickerAttachments(e, current.current.attachments, signal);
          onUploadState?.(true);
          const uploaded = await request;
          if (signal?.aborted) return;
          failures.push(...uploaded.errors);
          const latest = current.current;
          const unique = new Map(latest.attachments.map(item => [item.attachmentId, item]));
          for (const item of uploaded.attachments) unique.set(item.attachmentId, item);
          if (uploaded.attachments.length) {
            const next = [...unique.values()];
            // The host may have changed its controlled selection during upload.
            mvValidatePickerAttachmentBudget(next);
            commit(latest.links, next);
          }
        } catch (failure) { validation = failure.message || String(failure); }
        finally {
          if (!signal.aborted) {
            pending.current = false;
            setUploading(false);
            // The controlled form owns its failure history and submission guard.
            if (onUploadState) onUploadState(false, validation ? [...failures, validation] : failures);
            else {
              // Without a host submission guard, selection validation is per attempt.
              setUploadValidation(validation);
              if (failures.length) setUploadFailures(previous => [...previous, ...failures]);
            }
          }
        }
      };
      const loaded = result?.requestKey === requestKey ? result : null;
      const keyword = query.trim().toLowerCase();
      const rows = loaded?.rows?.filter(row => [row.label, row.subtitle, row.id].some(text => String(text ?? '').toLowerCase().includes(keyword)));
      const retryButton = () => h(MvButton, { label: '重试', onClick: () => setRetry(n => n + 1) });
      const chip = (id, label, remove) => h(MvButton, { key: id, className: 'mv-picker-chip', icon: 'close',
        'aria-label': '移除 ' + label, onClick: remove }, label);
      return h('div', { ...popup.rootProps, className: 'mv-scope mv-picker' },
        mvPickerTrigger(popup, '添加上下文'),
        h('div', { className: 'mv-picker-chips', 'aria-label': '已选上下文' },
          [...selectedRows].map(([rowKey, row]) => chip(rowKey, row.label, () => toggle(rowKey, row, row.label))),
          MV_LINK_KEYS.flatMap(key => links[key].filter(id => !hasReference(selectedRows, key, id)).map(id =>
            chip(key + ':' + id, id, () => toggle(key + ':' + id, { key, id }, id)))),
          attachments.map(item => chip(item.attachmentId, item.name, () =>
            commit(links, attachments.filter(row => row.attachmentId !== item.attachmentId))))),
        popup.open && h('div', { className: 'mv-picker-popover', id: popup.id, 'aria-label': '上下文选择器', role: 'group' },
          h('div', { className: 'mv-cascade3-grid' },
            mvPickerColumn('工作区', [scopes.map(row => mvPickerChoice(row.id, row.title || row.name || row.id, scopeId === row.id,
              () => { setScopeId(row.id); setKind(''); setQuery(''); })),
              !workspaces && host.loading && h('span', { key: 'pending', role: 'status' }, '正在读取工作区…'),
              !workspaces && host.error && h('div', { key: 'failure', role: 'alert' }, host.error, retryButton())]),
            mvPickerColumn('上下文类型', scope ? MV_CONTEXT_KINDS.map(([key, label]) => mvPickerChoice(key, label, key === kind,
              () => { setKind(key); setQuery(''); })) : '请选择工作区'),
            mvPickerColumn('选择内容', !scope || !kind ? '请选择上下文类型' : kind === 'files'
              ? h('label', null, '选择文件', h('input', { type: 'file', multiple: true, disabled: disableUpload || uploading || attachments.length >= MV_ATTACHMENT_LIMIT,
                onChange: e => void upload(e) }))
              : h(React.Fragment, null, h('input', { type: 'search', className: 'mv-field', 'aria-label': '筛选上下文',
                placeholder: '筛选上下文', value: query, onChange: e => setQuery(e.target.value) }),
                !loaded ? h('span', { role: 'status' }, '正在读取上下文…') : loaded.error
                  ? h('div', { role: 'alert' }, loaded.error, retryButton()) : rows.length ? rows.map((row, index) => {
                    const rowKey = row.rowId || (row.key + ':' + row.id);
                    const ref = row.memory && resolveMemoryLink?.(row.memory) || row;
                    const { key, id } = ref;
                    const linkKey = key + ':' + id;
                    const valid = MV_LINK_KEYS.includes(key) && mvContextLinkValid(key, id);
                    const selected = valid && (selectedRows.has(rowKey) ||
                      (rowKey === linkKey && links[key].includes(id) && !hasReference(selectedRows, key, id)));
                    const subtitle = [!valid ? '暂无可引用标识' : row.memory && key === 'sessionIds' && '引用来源会话',
                      row.subtitle].filter(Boolean).join(' · ');
                    return mvPickerChoice(valid ? rowKey : row.rowId || 'unavailable:' + index, row.label, selected,
                      () => { if (valid) toggle(rowKey, ref, row.label); }, subtitle, !valid);
                  }) : '没有匹配的上下文')))),
        uploading && h('div', { role: 'status' }, '正在上传附件…'),
        uploadValidation && h('div', { role: 'alert' }, uploadValidation),
        uploadFailures.length > 0 && h('div', { role: 'alert' }, uploadFailures.join('；'),
          h(MvButton, { label: '仅保留已上传附件', disabled: uploading, onClick: () => setUploadFailures([]) })),
        error && h('div', { role: 'alert' }, error));
    }

    // Public names for sibling shards sharing the client factory.
    const mvCascadePicker = {
      MarshalAgentModelCascade: mvAgentModelCascade,
      MarshalCascadeContextPicker: mvCascadeContextPicker,
      mvUploadPickerAttachments,
    };
