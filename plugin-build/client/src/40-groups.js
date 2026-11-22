    // Reuse the sidebar helpers without changing the sidebar entry points.
    function mvValidateSidebarGroupMentions(text, group, cross) {
      return validateSidebarGroupMentions(text, group, cross);
    }
    function mvCrossGroupDeliveryError(result) {
      return marshalCrossGroupDeliveryError(result);
    }

    function GroupsPage({ openSession, onOpenAgents }) {
      const [state, setState] = React.useState(null);
      const [library, setLibrary] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [loadedGroup, setGroup] = React.useState(null);
      const group = loadedGroup?.id === selected ? loadedGroup : null;
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [createOpen, setCreateOpen] = React.useState(false);
      const [draftName, setDraftName] = React.useState('');
      const [picked, setPicked] = React.useState({});
      const [leaderId, setLeaderId] = React.useState('');
      const [creating, setCreating] = React.useState(false);
      const agents = library && Array.isArray(library.agents) ? library.agents : [];
      const groups = (state && state.groups) || [];

      const listRefresh = React.useRef(null);
      const detailRefresh = React.useRef(null);
      const load = () => listRefresh.current?.request();
      const reloadGroup = () => detailRefresh.current?.request();
      React.useEffect(() => {
        const refresh = createVisibleMarshalRefresh(async signal => {
          try {
            const [groupsState, agentLibrary] = await Promise.all([fetchJson('marshal/groups/state', undefined, true, signal), loadAgentLibrary()]);
            if (!signal.aborted) { setState(groupsState); setLibrary(agentLibrary); }
          } catch (e) { if (!signal.aborted) setError(friendlyError(e, '智能体/群聊')); }
        });
        listRefresh.current = refresh;
        const unsubscribe = subscribeMarshalEvents(['ready', 'groups.changed', 'agents.changed'], refresh.request, { initial: true, debounceMs: 80 });
        return () => { listRefresh.current = null; unsubscribe(); refresh.dispose(); };
      }, []);
      React.useEffect(() => {
        if (!selected) return;
        const refresh = createVisibleMarshalRefresh(async signal => {
          try {
            const data = await fetchJson('marshal/groups/get?' + new URLSearchParams({ id: selected }), undefined, true, signal);
            if (!signal.aborted) setGroup(data.group);
          } catch (e) { if (!signal.aborted) setError('读取群失败：' + e.message); }
        });
        detailRefresh.current = refresh;
        const unsubscribe = subscribeMarshalEvents(['ready', 'groups.changed', 'agents.changed'], refresh.request, { initial: true, debounceMs: 80 });
        return () => { detailRefresh.current = null; unsubscribe(); refresh.dispose(); };
      }, [selected]);

      const create = async () => {
        if (!draftName.trim()) { setError('请填写群名称'); return; }
        const chosen = agents.filter(agent => picked[agent.id]);
        if (chosen.length < 2) { setError('至少选择 2 个智能体'); return; }
        if (!library) return;
        setCreating(true);
        setError('');
        try {
          const deviceId = (state && state.deviceId) || '';
          const members = chosen.map(agent => ({
            squadId: agent.squadId,
            memberId: agent.id,
            name: agent.name,
            ...(agent.preset ? { preset: agent.preset } : {}),
            ...(agent.permission ? { permission: agent.permission } : {}),
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          }));
          const leader = chosen.find(agent => agent.id === (leaderId || chosen[0].id)) || chosen[0];
          const leaderKey = deviceId + '/' + leader.squadId + '/' + leader.id;
          const created = await fetchJson('marshal/groups/create', { name: draftName.trim(), members, leaderKey }, true);
          const id = created.group.id;
          for (const agent of chosen) {
            try {
              const run = await fetchJson('dsh-agents/api/run', { teamId: agent.squadId, memberId: agent.id });
              const sessionId = run && run.run && run.run.sessionId;
              if (sessionId) await fetchJson('marshal/groups/bind', { id, key: deviceId + '/' + agent.squadId + '/' + agent.id, sessionId }, true);
            }
            catch (e) { setError('会话创建失败（' + agent.name + '）：' + (e.message || e)); }
          }
          setCreateOpen(false);
          setDraftName('');
          setPicked({});
          setLeaderId('');
          setSelected(id);
          await load();
        }
        catch (e) { setError('建群失败：' + (e.message || e)); }
        finally { setCreating(false); }
      };

      const send = async (text, context) => {
        const mentions = mvValidateSidebarGroupMentions(text, group, false);
        const result = await fetchJson('marshal/groups/send', { id: group.id, text: mvChatWireText(text, context), mentions }, true);
        if (result?.error === 'leader-unavailable') throw new Error('群主所在设备离线，这个群暂时不可用');
        if (result?.offline?.length) setNotice('成员离线：' + result.offline.join('、'));
        void reloadGroup();
        void load();
      };
      const changeModel = async ({ agentId, model, reasoningEffort }) => {
        const member = group.members.find(row => mvChatMemberId(row) === agentId);
        const agent = agents.find(row => row.id === member?.memberId && row.squadId === member?.squadId);
        if (!agent) throw new Error('只能更新本机智能体的默认模型与思考。');
        const { id, name, brief, preset, permission } = agent;
        await fetchJson('dsh-agents/api/member', { teamId: agent.squadId, member: { id, name, brief, preset, permission, model, reasoningEffort } });
        setNotice('已更新智能体默认模型与思考；现有常驻会话不受影响。');
        void load();
      };

      const convertToTask = async (message) => {
        if (!group) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const data = await fetchJson('marshal/groups/task', { id: group.id, messageId: message.id }, true);
          setNotice('已创建任务：' + ((data && data.task && data.task.title) || ''));
          await reloadGroup();
        }
        catch (e) { setError('建任务失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const ensureSession = async (member) => {
        if (!group || !library || busy) return;
        setBusy(true);
        setError('');
        try {
          const key = [(state && state.deviceId) || '', member.squadId, member.memberId].join('/');
          const run = await fetchJson('dsh-agents/api/run', { teamId: member.squadId, memberId: member.memberId });
          const sessionId = run && run.run && run.run.sessionId;
          if (!sessionId) throw new Error('no-session');
          await fetchJson('marshal/groups/bind', { id: group.id, key, sessionId }, true);
          await reloadGroup();
        }
        catch (e) { setError('创建会话失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const groupRow = item => h('button', {
        key: item.id, type: 'button', onClick: () => setSelected(item.id),
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '10px', marginBottom: 2,
          border: 0, borderRadius: 8, background: selected === item.id ? dswTheme.layer3 : 'transparent',
          color: 'inherit', font: 'inherit', cursor: 'pointer',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, fontWeight: 500 } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
          h('span', { style: { fontSize: 11, color: dswTheme.faint, flexShrink: 0 } }, item.memberCount + ' 人')),
        h('div', { style: { fontSize: 11, color: dswTheme.faint, marginTop: 3 } }, item.messageCount + ' 条消息' + (item.mode === 'discussion' ? ' · 讨论' : '')));

      const createDialog = () => h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, padding: 20 } },
        h('div', { role: 'dialog', 'aria-label': '新建群聊', style: { width: 480, maxWidth: '100%', maxHeight: '86%', overflow: 'auto', background: dswTheme.layer, border: '1px solid ' + dswTheme.border2, borderRadius: 14, padding: 20, boxShadow: '0 24px 60px rgba(0,0,0,.45)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 } },
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '新建群聊'),
            h('button', { type: 'button', style: uiButton(false), onClick: () => setCreateOpen(false) }, '关闭')),
          h(Field, { label: '群名称' }, h('input', { value: draftName, onChange: event => setDraftName(event.target.value), placeholder: '例如：前端联调', style: uiInput })),
          h('div', { style: { marginTop: 14 } },
            h('div', { style: { fontSize: 12, color: dswTheme.dim, marginBottom: 8 } }, '选择智能体（至少 2 个）'),
            agents.length === 0 && h('div', { style: { fontSize: 12, color: dswTheme.faint, lineHeight: 1.7 } }, '还没有智能体。先到「智能体」创建。'),
            h('div', { style: { display: 'grid', gap: 6, maxHeight: 240, overflow: 'auto' } },
              agents.map(agent => h('label', {
                key: agent.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  border: '1px solid ' + (picked[agent.id] ? dswTheme.brand : dswTheme.border),
                  borderRadius: 10, cursor: 'pointer',
                  background: picked[agent.id] ? dswTheme.layer3 : 'transparent',
                },
              },
                h('input', { type: 'checkbox', checked: !!picked[agent.id], onChange: () => setPicked(prev => ({ ...prev, [agent.id]: !prev[agent.id] })) }),
                h(Avatar, { name: agent.name, size: 26 }),
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: { fontSize: 13 } }, agent.name),
                  h('div', { style: { fontSize: 11, color: dswTheme.faint } }, [agent.preset, agent.permission, agent.model].filter(Boolean).join(' · ') || '默认')))))),
          h('div', { style: { marginTop: 14 } },
            h(Field, { label: 'leader（不 @ 时由它接话）' },
              h('select', { value: leaderId, onChange: event => setLeaderId(event.target.value), style: uiInput },
                h('option', { value: '' }, '默认：第一个选中的智能体'),
                agents.filter(agent => picked[agent.id]).map(agent => h('option', { key: agent.id, value: agent.id }, agent.name))))),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
            h('button', { type: 'button', style: uiButton(false), onClick: () => setCreateOpen(false) }, '取消'),
            h('button', { type: 'button', disabled: creating, style: { ...uiButton(true), opacity: creating ? .6 : 1 }, onClick: () => { void create(); } }, creating ? '创建中…' : '创建并开会话'))));

      return h('section', { className: 'mv-scope mv-room-fill', style: { position: 'relative' }, 'aria-label': '群聊' },
        h('aside', { style: { width: 292, flexShrink: 0, background: dswTheme.layer, borderRight: '1px solid ' + dswTheme.border, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h('div', { style: { padding: '14px 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', null,
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, '群聊'),
              h('div', { style: uiMuted }, groups.length + ' 个会话')),
            h('button', { type: 'button', style: uiButton(true), onClick: () => setCreateOpen(true) }, '新建')),
          h('div', { style: { flex: 1, overflow: 'auto', padding: '2px 8px 10px' } },
            groups.map(groupRow),
            groups.length === 0 && h('p', { style: { ...uiMuted, padding: '10px 6px' } }, '还没有群聊')),
          agents.length === 0 && h('div', { style: { padding: 12, borderTop: '1px solid ' + dswTheme.border } },
            h('div', { style: { fontSize: 12, color: dswTheme.faint, lineHeight: 1.7, marginBottom: 8 } }, '还没有智能体。先创建智能体，再拉群。'),
            h('button', { type: 'button', style: uiButton(false), onClick: onOpenAgents }, '去创建智能体'))),
        h('main', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          error && h('div', { style: { padding: '8px 18px', fontSize: 12, color: dswTheme.danger, borderBottom: '1px solid ' + dswTheme.border } }, error),
          group
            ? h(mvGroupConversation, { key: group.id, group, onSend: send, changeModel,
                members: group.members.map(member => {
                  const agent = agents.find(row => row.id === member.memberId && row.squadId === member.squadId);
                  const model = agent?.model || member.model;
                  return { ...member, model, reasoningEffort: agent?.reasoningEffort || member.reasoningEffort,
                    models: agent ? mvChatModelsWithCurrent(mvChatModels(library?.models), model) : [] };
                }), onMember: member => member.sessionId ? openSession?.(member.sessionId) : ensureSession(member),
                onRebuildSession: ensureSession,
                onTask: convertToTask, busy, notice }, mvGroupRefreshButton(reloadGroup))
            : h(EmptyState, { title: '选择一个群聊', hint: '群里的智能体各自有一个常驻会话。\n@ 谁谁回，@all 全体回，不 @ 由 leader 回。', action: '新建群聊', onAction: () => setCreateOpen(true) })),
        createOpen && createDialog());
    }



    function CrossGroupsPage() {
      const [state, setState] = React.useState(null);
      const [catalog, setCatalog] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [error, setError] = React.useState('');
      const [createOpen, setCreateOpen] = React.useState(false);
      const [name, setName] = React.useState('');
      const [picked, setPicked] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const refreshRef = React.useRef(null);
      const groups = (state && state.groups) || [];
      const group = groups.find(item => item.id === selected) || null;
      const devices = (catalog && catalog.devices) || [];

      React.useEffect(() => {
        // The local SSE stream does not relay changes made on the Hub.
        const refresh = createVisibleMarshalRefresh(async signal => {
          const [nextState, nextCatalog] = await Promise.allSettled([
            fetchJson('marshal/cross-groups/state', undefined, true, signal),
            fetchJson('marshal/cross-groups/catalog', undefined, true, signal),
          ]);
          if (signal.aborted) return;
          if (nextState.status === 'fulfilled') setState(nextState.value);
          if (nextCatalog.status === 'fulfilled') setCatalog(nextCatalog.value);
          const failure = [nextState, nextCatalog].find(result => result.status === 'rejected');
          setError(failure ? '跨设备路由不可用：' + (failure.reason?.message || failure.reason) : '');
        }, 12_000);
        refreshRef.current = refresh;
        refresh.setPolling(true);
        const unsubscribe = subscribeMarshalEvents(['ready', 'groups.changed', 'agents.changed'],
          refresh.request, { initial: true, debounceMs: 80 });
        return () => {
          refreshRef.current = null;
          refresh.dispose();
          unsubscribe();
        };
      }, []);
      const load = () => refreshRef.current?.request();
      const candidates = [];
      for (const device of devices) {
        for (const member of device.members || []) {
          if (!member.sessionId) continue;
          candidates.push({ key: device.id + '/' + member.sessionId, deviceId: device.id, deviceName: device.name || device.id, sessionId: member.sessionId, name: member.name, agent: 'dsh' });
        }
      }

      const create = async () => {
        if (!name.trim()) { setError('请填写群名称'); return; }
        const members = candidates.filter(item => picked[item.key]);
        if (members.length < 2) { setError('至少选择 2 个有常驻会话的成员'); return; }
        setBusy(true); setError('');
        try {
          const data = await fetchJson('marshal/cross-groups/create', {
            name: name.trim(),
            members: members.map(item => ({ deviceId: item.deviceId, agent: item.agent, sessionId: item.sessionId, name: item.name })),
          }, true);
          setSelected(data.group.id);
          setCreateOpen(false); setName(''); setPicked({});
          await load();
        }
        catch (e) { setError('创建失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const send = async (text, context) => {
        const mentions = mvValidateSidebarGroupMentions(text, group, true);
        const result = await fetchJson('marshal/cross-groups/send', { id: group.id, text: mvChatWireText(text, context), mentions }, true);
        void load();
        return mvCrossGroupDeliveryError(result);
      };

      return h('div', { className: 'mv-scope mv-room-fill', 'aria-label': '跨设备群聊' },
        h('aside', { style: { width: 260, borderRight: '1px solid ' + dswTheme.border, display: 'flex', flexDirection: 'column' } },
          h('div', { style: { padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '跨设备群聊'),
            h('button', { type: 'button', style: uiButton(true), onClick: () => setCreateOpen(value => !value) }, '新建')),
          createOpen && h('div', { style: { padding: 12, borderBottom: '1px solid ' + dswTheme.border, display: 'grid', gap: 8 } },
            h('input', { value: name, onChange: event => setName(event.target.value), placeholder: '群名称', style: uiInput }),
            candidates.length === 0 && h('div', { style: uiMuted }, '没有带常驻会话的成员；先在各设备打开智能体私聊。'),
            candidates.map(item => h('label', { key: item.key, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
              h('input', { type: 'checkbox', checked: picked[item.key] === true, onChange: event => setPicked(current => ({ ...current, [item.key]: event.target.checked })) }),
              item.name + ' · ' + item.deviceName)),
            h('button', { type: 'button', disabled: busy, style: { ...uiButton(true), opacity: busy ? .6 : 1 }, onClick: () => { void create(); } }, busy ? '创建中…' : '创建跨设备群')),
          h('div', { style: { flex: 1, overflow: 'auto', padding: 8, display: 'grid', gap: 6 } },
            groups.length === 0 ? h('p', { style: uiMuted }, '还没有跨设备群') : groups.map(item => h('button', {
              key: item.id, type: 'button',
              style: { ...uiButton(false), textAlign: 'left', background: item.id === selected ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent' },
              onClick: () => setSelected(item.id),
            }, item.name + ' · ' + item.members.length + ' 人')))),
        h('section', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
          error && h('div', { style: { padding: '8px 16px', color: dswTheme.danger, fontSize: 12 } }, error),
          group === null
            ? h(EmptyState, { title: '选择一个跨设备群', hint: '成员各自在自己的设备上，用常驻会话回复。' })
            : h(mvGroupConversation, { key: group.id, cross: true, group, members: group.members.map(member => {
                const device = devices.find(item => item.id === member.deviceId);
                const current = device?.members?.find(item => item.sessionId === member.sessionId);
                return { ...member, deviceName: device?.name || member.deviceName,
                  model: current?.model || member.model, reasoningEffort: current?.reasoningEffort || member.reasoningEffort };
              }),
                onSend: send, busy }, mvGroupRefreshButton(load), (group.messages ?? []).map(row =>
                  mvChatMessage({ mine: row.role === 'user', name: row.author, at: row.at, text: row.text,
                    streaming: row.streaming, messageId: row.id, children: mvChatDeliveries(row.deliveries) })))));
    }

    function mvChatModels(models = []) {
      const rows = models.map(item => ({ ...item, route: item.route || (item.provider && item.model ? item.provider + '/' + item.model : item.id),
        efforts: item.efforts ?? item.reasoning?.efforts?.map(e => typeof e === 'string' ? e : e.id).filter(Boolean) }));
      return [...new Map(rows.filter(row => row.route).map(row => [row.route, row])).values()];
    }

    function mvChatModelsWithCurrent(models, model) {
      return model && !models.some(item => item.route === model) ? [{ route: model }, ...models] : models;
    }

    function mvChatLinks(context) {
      const links = Object.fromEntries(Object.entries(context.links ?? {}).filter(([, ids]) => ids.length));
      return Object.keys(links).length ? links : undefined;
    }

    function mvChatWireText(text, context) {
      // Group endpoints accept text only. Use reference IDs, not local paths to
      // uploaded files, and avoid interpreting @ in reference labels as delivery targets.
      const links = mvChatLinks(context);
      if (!links) return text;
      const labels = { sessionIds: '会话', proposalIds: '工单或记忆', docPaths: '文档' };
      return text + '\n\n关联上下文：\n' + Object.entries(links).flatMap(([key, ids]) =>
        ids.map(id => `${labels[key] || key}：${id.replaceAll('@', '＠')}`)).join('\n');
    }

    function mvChatMemberId(member) {
      return member.key || [member.deviceId, member.squadId, member.memberId || member.sessionId || member.name].filter(Boolean).join('/');
    }

    function mvChatMentions({ members, usage, all, input, setText }) {
      const chip = (key, name, role) => {
        const count = usage?.get(name);
        return h('button', { type: 'button', key, className: 'mv-btn mv-chip', onClick: () => {
          setText(current => (current.trimEnd() ? current.trimEnd() + ' ' : '') + '@' + name + ' ');
          input.current?.focus();
        } }, '@' + name, role && ' · ' + role, count > 0 && ' · ' + formatTokenCount(count) + ' tok');
      };
      return h('div', { className: 'mv-actions', 'aria-label': '提及成员' },
        members.map(member => chip(member.id || mvChatMemberId(member), member.name, member.role)), all && chip('all', '全体'));
    }

    function mvChatMessage({ mine, name, at, phase, text, trace, live, streaming, messageId, children }) {
      const u = trace?.usage;
      const total = Number(u?.totalTokens) || Number(u?.inputTokens || 0) + Number(u?.outputTokens || 0);
      return h('article', { key: messageId, className: 'mv-room-message', style: { marginInlineStart: mine ? 'var(--mv-xl)' : undefined,
        marginInlineEnd: mine ? undefined : 'var(--mv-xl)', background: mine ? 'var(--dsw-alias-marshal-tint)' : undefined } },
        h('div', { className: 'mv-actions mv-muted' }, h('strong', null, mine ? '我' : name),
          at != null && h('time', null, new Date(at).toLocaleTimeString()),
          phase && taskPhases[phase] && h('span', null, taskPhases[phase]),
          total > 0 && h('span', { className: 'mv-time', title: formatUsageTitle(u) },
            formatTokenCount(total) + ' tok (入 ' + (formatTokenCount(Number(u.inputTokens)) || '0') + ' · 出 ' + (formatTokenCount(Number(u.outputTokens)) || '0') + ')'),
          (live || streaming) && h('span', null, live ? '思考/处理中' : '生成中')),
        trace && h(AgentTracePanel, { trace, live, hasBody: Boolean(text?.trim()) }),
        text && (streaming ? h('div', null, text) : h(RichMarkdown, { text, phase })), children);
    }

    function mvChatDeliveries(deliveries) {
      return deliveries?.length > 0 && h('p', { className: 'mv-muted' }, deliveries.map(item =>
        (item.name || item.memberKey?.split('/').pop() || '成员') + (item.state === 'accepted' ? ' 已送达' : ' ' + (item.code || item.state))).join(' · '));
    }

    function mvGroupRefreshButton(refresh) {
      return h('button', { type: 'button', className: 'mv-btn', onClick: refresh }, '刷新');
    }

    function mvGroupConversation({ cross, group, members, onSend, changeModel, onMember, onRebuildSession, onTask, busy, notice, children }) {
      const [refreshButton, crossTranscript] = Array.isArray(children) ? children : [children];
      const [draft, setDraft] = React.useState('');
      const [context, setContext] = React.useState({});
      const [sending, setSending] = React.useState(false);
      const [error, setError] = React.useState('');
      const [panel, setPanel] = React.useState(false);
      const input = React.useRef(null);
      const stream = React.useRef(null);
      const stick = React.useRef(true);
      const pending = React.useRef(false);
      const messages = group.messages ?? [];
      const messageVersion = messages.map(row => row.id + ':' + row.text?.length).join(',');
      React.useEffect(() => {
        if (stick.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight;
      }, [messageVersion]);
      const send = async () => {
        if (!draft.trim() || pending.current) return;
        if (context.attachments?.length) { setError('当前群聊只支持上下文引用。请移除文件后再发送。'); return; }
        pending.current = true;
        setSending(true); setError('');
        try {
          const warning = await onSend(draft.trim(), context);
          setDraft(current => current === draft ? '' : current);
          setContext(current => current === context ? {} : current);
          if (warning) setError(warning);
          stick.current = true;
        } catch (e) { setError('发送失败：' + e.message); }
        finally { pending.current = false; setSending(false); }
      };
      const roster = h('div', { className: 'mv-stack' }, members.map(member => h('div', { key: mvChatMemberId(member), className: 'mv-task-item' },
        h('strong', null, member.name), h('div', { className: 'mv-muted' }, [member.deviceName || member.deviceId,
          member.model || (cross ? '模型未上报' : '默认模型'), member.reasoningEffort].filter(Boolean).join(' · ')),
        onMember && h('button', { type: 'button', className: 'mv-btn', disabled: !member.sessionId && busy, onClick: () => onMember(member) }, member.sessionId ? '打开会话' : '建立会话'),
        member.sessionId && onRebuildSession && h('button', { type: 'button', className: 'mv-btn', disabled: busy, onClick: () => onRebuildSession(member) }, '重建会话'))),
        h('strong', null, '关联工单'),
        [...new Set(messages.map(row => row.taskId).filter(Boolean))].map(id => h('div', { key: id }, id)),
        !messages.some(row => row.taskId) && h('span', { className: 'mv-muted' }, '暂无关联工单'));
      return h('div', { className: 'mv-room-fill' }, h('section', { className: 'mv-room', style: { overflow: 'visible' } },
        h('header', { className: 'mv-dag-header mv-actions' }, h('strong', { className: 'mv-copy mv-truncate' }, group.name),
          refreshButton,
          h('button', { type: 'button', className: 'mv-btn', 'aria-pressed': panel, onClick: () => setPanel(v => !v) }, '群聊成员')),
        (notice || error) && h('div', { role: error ? 'alert' : 'status', className: error ? 'mv-danger' : 'mv-muted' }, error || notice),
        h('div', { ref: stream, className: 'mv-room-log', 'aria-label': '群聊记录', onScroll: e => {
          const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        } }, messages.length === 0 && h('p', { className: 'mv-muted' }, '还没有消息'),
        crossTranscript ?? messages.map(message => {
          const mine = message.role === 'user' || message.author === 'user';
          const name = members.find(member => member.memberId === message.authorMemberId)?.name || '成员';
          return h(mvChatMessage, { key: message.id, mine, name, at: message.at ?? message.ts, text: message.text, streaming: message.streaming },
            onTask && mine && !message.taskId && h('button', { type: 'button', className: 'mv-btn', disabled: busy, onClick: () => onTask(message) }, '创建工单'),
            mvChatDeliveries(message.deliveries));
        }), group.active?.length > 0 && h('p', { className: 'mv-muted' }, '成员正在生成…')),
        h('footer', { className: 'mv-composer-dock' },
          h(mvChatMentions, { members, all: !cross, input, setText: setDraft }),
          h('textarea', { ref: input, className: 'mv-field', value: draft, rows: 2, 'aria-label': '群聊消息', placeholder: '输入消息或 @成员', onChange: e => setDraft(e.target.value) }),
          h('div', { className: 'mv-actions' },
            !cross && h(mvCascadePicker.MarshalAgentModelCascade, {
              agents: members.map(member => ({ ...member, id: mvChatMemberId(member), models: member.models ?? [] })), onApply: changeModel }),
            h('span', { className: 'mv-muted' }, cross ? '跨设备成员模型只读（由所在设备管理）' : '默认模型与思考，新会话生效'),
            h(mvCascadePicker.MarshalCascadeContextPicker, { value: context, onChange: setContext }),
            context.attachments?.length > 0 && h('span', { className: 'mv-muted' }, '此群只能发送关联引用，不能发送文件。'),
            h('button', { type: 'button', className: 'mv-btn mv-guidance-action', disabled: busy || sending || !draft.trim(), onClick: send }, '发送')))),
        panel && h(mvDagSidebar.MarshalVerticalDagSidebar, { members: roster }));
    }
