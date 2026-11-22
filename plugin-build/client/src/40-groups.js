    function GroupsPage({ openSession, onOpenAgents }) {
      const [state, setState] = React.useState(null);
      const [library, setLibrary] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [group, setGroup] = React.useState(null);
      const [text, setText] = React.useState('');
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

      const load = async () => {
        try {
          const [groupsState, agentLibrary] = await Promise.all([fetchJson('marshal/groups/state'), loadAgentLibrary()]);
          setState(groupsState);
          setLibrary(agentLibrary);
          setError('');
        }
        catch (e) { setError(friendlyError(e, '智能体/群聊')); }
      };
      const reloadGroup = async () => {
        if (!group) return;
        const fresh = await fetchJson('marshal/groups/get?id=' + encodeURIComponent(group.id));
        setGroup(fresh.group);
      };
      React.useEffect(() => { void load(); }, []);
      React.useEffect(() => {
        if (!selected) { setGroup(null); return; }
        let alive = true;
        const pull = () => {
          fetchJson('marshal/groups/get?id=' + encodeURIComponent(selected))
            .then(data => { if (alive) setGroup(data.group); })
            .catch(e => { if (alive) setError('读取群失败：' + (e.message || e)); });
        };
        pull();
        const timer = setInterval(pull, 2000);
        return () => { alive = false; clearInterval(timer); };
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
          const created = await fetchJson('marshal/groups/create', { name: draftName.trim(), members, leaderKey });
          const id = created.group.id;
          for (const agent of chosen) {
            try {
              const run = await fetchJson('dsh-agents/api/run', { teamId: agent.squadId, memberId: agent.id });
              const sessionId = run && run.run && run.run.sessionId;
              if (sessionId) await fetchJson('marshal/groups/bind', { id, key: deviceId + '/' + agent.squadId + '/' + agent.id, sessionId });
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

      const send = async () => {
        if (!group || !text.trim()) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/groups/send', { id: group.id, text });
          if (result && result.error === 'leader-unavailable') {
            throw new Error('leader 所在设备离线，这个群暂时不可用');
          }
          if (result && Array.isArray(result.offline) && result.offline.length > 0) {
            setNotice('成员离线：' + result.offline.join('、') + (result.fallback ? '；已通知 leader 新建临时智能体或改派' : ''));
          }
          setText('');
          await reloadGroup();
          setState(await fetchJson('marshal/groups/state'));
        }
        catch (e) { setError('发送失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const convertToTask = async (message) => {
        if (!group) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const data = await fetchJson('marshal/groups/task', { id: group.id, messageId: message.id });
          setNotice('已创建任务：' + ((data && data.task && data.task.title) || ''));
          await reloadGroup();
        }
        catch (e) { setError('建任务失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const ensureSession = async (member) => {
        if (!group || !library) return;
        setBusy(true);
        setError('');
        try {
          const key = [(state && state.deviceId) || '', member.squadId, member.memberId].join('/');
          const run = await fetchJson('dsh-agents/api/run', { teamId: member.squadId, memberId: member.memberId });
          const sessionId = run && run.run && run.run.sessionId;
          if (!sessionId) throw new Error('no-session');
          await fetchJson('marshal/groups/bind', { id: group.id, key, sessionId });
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

      const memberChip = member => h('button', {
        key: member.memberId, type: 'button',
        onClick: () => { if (member.sessionId) { if (openSession) openSession(member.sessionId); } else void ensureSession(member); },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid ' + dswTheme.border2,
          background: 'transparent', color: dswTheme.text, borderRadius: 999, padding: '4px 10px 4px 4px',
          fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
        },
      }, h(Avatar, { name: member.name, size: 22 }), member.name,
        h('span', { style: { color: member.sessionId ? dswTheme.faint : dswTheme.brand, fontSize: 11 } }, member.sessionId ? '打开' : '建会话'));

      const messageView = message => {
        const mine = message.author === 'user';
        const name = mine ? '我' : ((group && group.members.find(member => member.memberId === message.authorMemberId)) || {}).name || '成员';
        return h('div', { key: message.id, style: { display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: mine ? 'row-reverse' : 'row' } },
          h(Avatar, { name, size: 28 }),
          h('div', { style: { maxWidth: '74%' } },
            h('div', { style: { fontSize: 11, color: dswTheme.faint, marginBottom: 4, textAlign: mine ? 'right' : 'left' } },
              name + ' · ' + new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
            h('div', { style: { padding: '9px 12px', borderRadius: 12, background: mine ? dswTheme.layer3 : dswTheme.layer, border: '1px solid ' + dswTheme.border, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.6 } }, message.text),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, justifyContent: mine ? 'flex-end' : 'flex-start' } },
              message.deliveries && message.deliveries.length > 0 && h('span', { style: { fontSize: 11, color: dswTheme.faint } },
                message.deliveries.map(delivery => delivery.memberKey.split('/').pop() + (delivery.state === 'accepted' ? ' ✓' : ' ✕ ' + (delivery.code || ''))).join('  ')),
              mine && (message.taskId
                ? h('span', { style: { fontSize: 11, color: dswTheme.faint } }, '已建任务')
                : h('button', { type: 'button', style: { ...uiButton(false), padding: '2px 8px', fontSize: 11 }, onClick: () => { void convertToTask(message); } }, '变任务')))));
      };

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

      return h('section', { style: { flex: 1, minHeight: 0, display: 'flex', position: 'relative', background: dswTheme.bg, color: dswTheme.text } },
        h('aside', { style: { width: 292, flexShrink: 0, background: dswTheme.layer, borderRight: '1px solid ' + dswTheme.border, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h('div', { style: { padding: '14px 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', null,
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, '群聊'),
              h('div', { style: uiMuted }, groups.length + ' 个会话')),
            h('button', { type: 'button', style: uiButton(true), onClick: () => setCreateOpen(true) }, '＋ 新建')),
          h('div', { style: { flex: 1, overflow: 'auto', padding: '2px 8px 10px' } },
            groups.map(groupRow),
            groups.length === 0 && h('p', { style: { ...uiMuted, padding: '10px 6px' } }, '还没有群聊')),
          agents.length === 0 && h('div', { style: { padding: 12, borderTop: '1px solid ' + dswTheme.border } },
            h('div', { style: { fontSize: 12, color: dswTheme.faint, lineHeight: 1.7, marginBottom: 8 } }, '还没有智能体。先创建智能体，再拉群。'),
            h('button', { type: 'button', style: uiButton(false), onClick: onOpenAgents }, '去创建智能体'))),
        h('main', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          error && h('div', { style: { padding: '8px 18px', fontSize: 12, color: dswTheme.danger, borderBottom: '1px solid ' + dswTheme.border } }, error),
          group
            ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
                h('header', { style: { padding: '14px 20px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 } },
                  h('div', null,
                    h('div', { style: { fontSize: 15, fontWeight: 600 } }, group.name),
                    h('div', { style: uiMuted }, group.members.length + ' 个智能体 · 不 @ 由 leader 回')),
                  h('button', { type: 'button', style: uiButton(false), onClick: () => { void reloadGroup(); } }, '刷新')),
                h('div', { style: { padding: '10px 20px', display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid ' + dswTheme.border, flexShrink: 0 } }, group.members.map(memberChip)),
                h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 } },
                  (group.messages || []).length === 0
                    ? h('div', { style: { margin: 'auto', textAlign: 'center', color: dswTheme.faint, fontSize: 12, lineHeight: 1.8 } }, '还没有消息', h('br'), '@ 某个智能体，或直接说话让 leader 接。')
                    : (group.messages || []).map(messageView)),
                h('div', { style: { padding: '12px 20px', borderTop: '1px solid ' + dswTheme.border, display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 } },
                  h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 2, placeholder: '@成员名 或 @all；不 @ 时由 leader 回', style: { ...uiInput, flex: 1, resize: 'none', minHeight: 44, lineHeight: 1.5 } }),
                  h('button', { type: 'button', disabled: busy || !text.trim(), style: { ...uiButton(true), opacity: busy || !text.trim() ? .5 : 1 }, onClick: () => { void send(); } }, '发送')))
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
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [, setTick] = React.useState(0);
      const reveal = React.useRef(new Map());
      const seenMessages = React.useRef(false);
      const lastGroupId = React.useRef('');
      const groups = (state && state.groups) || [];
      const group = groups.find(item => item.id === selected) || null;
      const devices = (catalog && catalog.devices) || [];

      const load = async () => {
        try {
          const [nextState, nextCatalog] = await Promise.all([
            fetchJson('marshal/cross-groups/state'),
            fetchJson('marshal/cross-groups/catalog'),
          ]);
          setState(nextState);
          setCatalog(nextCatalog);
          setError('');
        }
        catch (e) { setError('跨设备路由不可用：' + (e.message || e)); }
      };
      React.useEffect(() => { void load(); }, []);
      React.useEffect(() => {
        let alive = true;
        const timer = setInterval(() => {
          fetchJson('marshal/cross-groups/state')
            .then(next => { if (alive) setState(next); })
            .catch(() => {});
        }, 350);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const messageSignature = group === null ? '' : group.messages.map(message => message.id + ':' + message.text.length).join(',');
      React.useEffect(() => {
        if (group === null) return;
        const map = reveal.current;
        if (lastGroupId.current !== group.id) {
          lastGroupId.current = group.id;
          map.clear();
          for (const message of group.messages) map.set(message.id, message.text.length);
          seenMessages.current = true;
          setTick(value => value + 1);
          return;
        }
        if (!seenMessages.current) {
          for (const message of group.messages) map.set(message.id, message.text.length);
          seenMessages.current = true;
          setTick(value => value + 1);
          return;
        }
        for (const message of group.messages) {
          if (!map.has(message.id)) map.set(message.id, message.streaming === true ? message.text.length : 0);
        }
        const timer = setInterval(() => {
          let changed = false;
          for (const message of group.messages) {
            const target = message.text.length;
            const current = map.get(message.id) ?? target;
            if (current >= target) continue;
            map.set(message.id, Math.min(target, current + 2));
            changed = true;
          }
          if (changed) setTick(value => value + 1);
        }, 25);
        return () => clearInterval(timer);
      }, [group === null ? '' : group.id, messageSignature]);

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
          });
          setSelected(data.group.id);
          setCreateOpen(false); setName(''); setPicked({});
          await load();
        }
        catch (e) { setError('创建失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const send = async () => {
        if (!group || !text.trim()) return;
        const mentions = [];
        const pattern = /@([^\s@]+)/g;
        let match;
        while ((match = pattern.exec(text)) !== null) if (!mentions.includes(match[1])) mentions.push(match[1]);
        setBusy(true); setError('');
        try {
          const result = await fetchJson('marshal/cross-groups/send', { id: group.id, text, mentions });
          if (result && Array.isArray(result.deliveries)) {
            const failed = result.deliveries.filter(item => item.state === 'failed');
            if (failed.length > 0) setError('部分成员失败：' + failed.map(item => item.name + ' ' + (item.code || '')).join('、'));
          }
          setText('');
          await load();
        }
        catch (e) { setError('发送失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
        h('aside', { style: { width: 260, borderRight: '1px solid ' + dswTheme.border, display: 'flex', flexDirection: 'column' } },
          h('div', { style: { padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '跨设备群聊'),
            h('button', { type: 'button', style: uiButton(true), onClick: () => setCreateOpen(value => !value) }, '＋ 新建')),
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
            : h(React.Fragment, null,
              h('header', { style: { padding: '12px 16px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', null,
                  h('div', { style: { fontSize: 14, fontWeight: 600 } }, group.name),
                  h('div', { style: uiMuted }, group.members.map(member => member.name + ' · ' + member.deviceId).join(' / '))),
                h('button', { type: 'button', style: uiButton(false), onClick: () => { void load(); } }, '刷新')),
              h('div', { style: { flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 } },
                group.messages.length === 0 ? h('p', { style: uiMuted }, '还没有消息') : group.messages.map(message => h('div', {
                  key: message.id,
                  'data-group-message': message.id,
                  'data-group-role': message.role,
                  style: { alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: '8px 10px', borderRadius: 10, background: message.role === 'user' ? 'color-mix(in srgb, #4c8bf5 18%, transparent)' : 'color-mix(in srgb, currentColor 8%, transparent)' },
                },
                  h('div', { style: { fontSize: 11, opacity: .6 } }, message.author + ' · ' + new Date(message.at).toLocaleTimeString()),
                  (() => { const shown = message.role === 'user' || message.streaming === true ? message.text : message.text.slice(0, reveal.current.get(message.id) ?? message.text.length); return h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 } }, shown); })())),
                (group.active || []).length > 0 && h('div', { style: { alignSelf: 'flex-start', color: dswTheme.dim, fontSize: 12 } }, '成员正在生成…')),
              h('div', { style: { padding: 12, borderTop: '1px solid ' + dswTheme.border, display: 'flex', gap: 8 } },
                h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 2, placeholder: '@成员名 或直接说话让 leader 接', style: { ...uiInput, flex: 1, resize: 'vertical' } }),
                h('button', { type: 'button', disabled: busy, style: { ...uiButton(true), opacity: busy ? .6 : 1 }, onClick: () => { void send(); } }, '发送')))));
    }

