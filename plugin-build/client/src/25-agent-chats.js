    function AgentDirectChatsView({ openSession, mvOpenDirect, onOpenAgents, initialAgentId = '' }) {
      const [library, setLibrary] = React.useState(null);
      const [sessions, setSessions] = React.useState([]);
      const [selectedAgentId, setSelectedAgentId] = React.useState(initialAgentId || 'all');
      const [search, setSearch] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [renamingId, setRenamingId] = React.useState('');
      const [renameDraft, setRenameDraft] = React.useState('');
      const [summarizingId, setSummarizingId] = React.useState('');

      const load = async () => {
        try {
          const [lib, sess] = await Promise.all([
            loadAgentLibrary(),
            fetchJson('marshal/agents/sessions'),
          ]);
          setLibrary(lib);
          setSessions(Array.isArray(sess?.sessions) ? sess.sessions : []);
          setError('');
        }
        catch (e) { setError(friendlyError(e, '智能体单聊')); }
      };
      React.useEffect(() => { void load(); }, []);
      React.useEffect(() => { if (initialAgentId) setSelectedAgentId(initialAgentId); }, [initialAgentId]);

      const agents = library?.agents ?? [];
      const selectedAgent = selectedAgentId !== 'all' ? agents.find(a => a.id === selectedAgentId) : undefined;
      const countForAgent = agent => sessions.filter(s => s.memberId === agent.id || (s.teamId === agent.squadId && s.agentName === agent.name)).length;

      const filtered = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return sessions.filter(item => {
          if (selectedAgent) {
            const match = item.memberId === selectedAgent.id || (item.teamId === selectedAgent.squadId && item.agentName === selectedAgent.name);
            if (!match) return false;
          }
          if (q) {
            const hay = [item.title, item.agentName, item.sessionId].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
      }, [sessions, selectedAgent, search]);

      const saveRename = async sessionId => {
        if (!sessionId) return;
        setError('');
        try {
          await fetchJson('marshal/agents/sessions/rename', { sessionId, title: renameDraft.trim() });
          setRenamingId('');
          setRenameDraft('');
          await load();
        }
        catch (e) { setError('重命名失败：' + (e.message || e)); }
      };
      const summarizeTitle = async sessionId => {
        if (!sessionId || summarizingId) return;
        setSummarizingId(sessionId);
        setError('');
        try {
          await fetchJson('marshal/agents/sessions/summarize', { sessionId, clearCustom: true });
          await load();
        }
        catch (e) { setError('总结标题失败：' + (e.message || e)); }
        finally { setSummarizingId(''); }
      };
      const startNewChat = async agent => {
        if (!agent || busy) return;
        setBusy(true);
        setError('');
        try {
          const data = await fetchJson('dsh-agents/api/run', { teamId: agent.squadId, memberId: agent.id });
          const sessionId = data?.run?.sessionId;
          if (!sessionId) throw new Error('未能创建会话');
          // Bind a Workspace first: an unbound session makes the composer ask for one.
          await mvAttachSessionWorkspace(sessionId);
          await load();
          openSession && openSession(sessionId);
        }
        catch (e) { setError('新建闲聊失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' } },
        h('aside', { style: { width: 210, flexShrink: 0, borderRight: '1px solid ' + dswTheme.border, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontSize: 11, color: dswTheme.faint, padding: '4px 8px', fontWeight: 600 } }, '按智能体筛选'),
          h('button', {
            type: 'button',
            style: { ...tabStyle(selectedAgentId === 'all'), textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px' },
            onClick: () => setSelectedAgentId('all'),
          }, h('span', null, '全部闲聊'), h('span', { style: { fontSize: 11, opacity: .65 } }, String(sessions.length))),
          agents.map(agent => h('button', {
            key: agent.id, type: 'button',
            style: { ...tabStyle(selectedAgentId === agent.id), textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' },
            onClick: () => setSelectedAgentId(agent.id),
          },
            h(Avatar, { name: agent.name, size: 22 }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agent.name),
            h('span', { style: { fontSize: 11, opacity: .65 } }, String(countForAgent(agent)))))),
        h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          h('div', { style: { padding: '12px 16px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, selectedAgent ? selectedAgent.name + ' · 闲聊历史' : '全部智能体单聊历史'),
            h('input', { value: search, onChange: event => setSearch(event.target.value), placeholder: '搜索历史会话标题或智能体…', style: { ...uiInput, width: 220, marginLeft: 'auto' } }),
            selectedAgent && mvOpenDirect && h(mvDirectLink, { key: selectedAgent.id, agent: selectedAgent, open: mvOpenDirect }),
            selectedAgent && h('button', { type: 'button', disabled: busy, style: uiButton(true), onClick: () => { void startNewChat(selectedAgent); } }, busy ? '创建中…' : '＋ 新建闲聊'),
            h('button', { type: 'button', style: uiButton(false), onClick: () => { void load(); } }, '刷新')),
          error && h('div', { style: { padding: '8px 16px', color: dswTheme.danger, fontSize: 12 } }, error),
          h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 } },
            filtered.length === 0
              ? h(EmptyState, {
                title: selectedAgent ? '还没有与「' + selectedAgent.name + '」的闲聊记录' : '暂无历史单聊会话',
                hint: '点上方“＋ 新建闲聊”即可开启一段独立对话，所有历史对话都会永久留在这里。',
                action: selectedAgent ? '＋ 新建闲聊' : '管理智能体',
                onAction: () => { if (selectedAgent) void startNewChat(selectedAgent); else onOpenAgents && onOpenAgents(); },
              })
              : filtered.map(item => h('div', {
                key: item.sessionId,
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, cursor: renamingId === item.sessionId ? 'default' : 'pointer' },
                onClick: () => { if (renamingId !== item.sessionId) openSession && openSession(item.sessionId); },
              },
                h(Avatar, { name: item.agentName || '?', size: 30 }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  renamingId === item.sessionId
                    ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, onClick: e => e.stopPropagation() },
                        h('input', {
                          value: renameDraft,
                          autoFocus: true,
                          placeholder: '输入新标题（留空恢复自动标题）',
                          style: { ...uiInput, flex: 1, padding: '4px 8px', fontSize: 12 },
                          onChange: e => setRenameDraft(e.target.value),
                          onKeyDown: e => { if (e.key === 'Enter') void saveRename(item.sessionId); if (e.key === 'Escape') setRenamingId(''); },
                        }),
                        h('button', { type: 'button', style: { ...uiButton(true), padding: '4px 9px', fontSize: 11 }, onClick: () => { void saveRename(item.sessionId); } }, '保存'),
                        h('button', { type: 'button', style: { ...uiButton(false), padding: '4px 8px', fontSize: 11 }, onClick: () => setRenamingId('') }, '取消'))
                    : h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                        h('span', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.title }, item.title || '历史会话'),
                        item.titleSource === 'custom' && h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border, borderRadius: 999, padding: '1px 6px', flexShrink: 0 } }, '已重命名'),
                        item.titleSource === 'auto' && h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border, borderRadius: 999, padding: '1px 6px', flexShrink: 0 } }, '自动总结'),
                        item.archived && h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border, borderRadius: 999, padding: '1px 6px', flexShrink: 0 } }, '已归档'),
                        item.legacyReadOnly && h('span', { title: '原独立工作区已迁出清壳，仅作历史查阅；继续对话请点「新建闲聊」', style: { fontSize: 10, color: '#f59e0b', border: '1px solid color-mix(in srgb, #f59e0b 45%, transparent)', background: 'color-mix(in srgb, #f59e0b 10%, transparent)', borderRadius: 999, padding: '1px 6px', flexShrink: 0 } }, '历史只读')),
                  h('div', { style: { fontSize: 11, color: dswTheme.faint, marginTop: 3 } },
                    [item.agentName || '智能体', formatSessionTime(item.updatedAt || item.createdAt), item.sessionId.slice(0, 8)].filter(Boolean).join(' · '))),
                renamingId !== item.sessionId && h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 }, onClick: e => e.stopPropagation() },
                  h('button', { type: 'button', title: '手动重命名', style: { ...uiButton(false), padding: '5px 8px', fontSize: 11 }, onClick: () => { setRenamingId(item.sessionId); setRenameDraft(item.title || ''); } }, '重命名'),
                  h('button', { type: 'button', title: '根据会话首句重新总结标题', disabled: summarizingId === item.sessionId, style: { ...uiButton(false), padding: '5px 8px', fontSize: 11 }, onClick: () => { void summarizeTitle(item.sessionId); } }, summarizingId === item.sessionId ? '总结中…' : '✨ 总结'),
                  h('button', { type: 'button', style: { ...uiButton(false), padding: '5px 10px', fontSize: 11 }, onClick: () => openSession && openSession(item.sessionId) }, '打开')))))));
    }

    function DeviceStatusDrawer({ open, onClose, status, onRefresh, onOpenRemote }) {
      const [copied, setCopied] = React.useState(false);
      if (!open) return null;
      const devices = Array.isArray(status?.devices) ? status.devices : [];
      const onlineCount = devices.filter(d => d && d.online !== false).length;
      const copyUrl = () => {
        if (!status?.dashboardUrl) return;
        try { navigator.clipboard?.writeText(status.dashboardUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
      };
      return h('div', {
        style: { position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.35)', display: 'flex', justifyContent: 'flex-end' },
        onClick: onClose,
      },
        h('aside', {
          'aria-label': '设备与手机状态',
          style: { width: 360, maxWidth: '92vw', height: '100%', background: 'var(--dsw-alias-bg-base, #14161a)', color: dswTheme.text, borderLeft: '1px solid ' + dswTheme.border2, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,.28)' },
          onClick: event => event.stopPropagation(),
        },
          h('div', { style: { padding: '14px 18px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, '设备与手机'),
            h('button', { type: 'button', style: uiButton(false), onClick: onClose }, '关闭')),
          h('div', { style: { flex: 1, overflow: 'auto', padding: 16, display: 'grid', gap: 14, alignContent: 'start' } },
            h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, display: 'grid', gap: 6 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: status?.hubOnline ? '#10b981' : status?.hubConfigured ? '#f59e0b' : '#9ca3af' } }),
                status?.hubOnline ? 'Hub 已在线连接' : status?.hubConfigured ? 'Hub 连接中断' : '本机独立模式（未配置 Hub）'),
              status?.deviceId && h('div', { style: { fontSize: 11, color: dswTheme.dim } }, '本机标识：' + status.deviceId),
              status?.error && h('div', { style: { fontSize: 11, color: dswTheme.danger } }, status.error)),
            h('div', { style: { display: 'grid', gap: 8 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: dswTheme.dim } }, '在线设备（' + onlineCount + ' / ' + devices.length + '）'),
              devices.length === 0
                ? h('div', { style: { fontSize: 12, color: dswTheme.faint } }, '当前仅本机可用，连接云端 Hub 后可管理多台电脑与手机。')
                : devices.map(dev => h('div', { key: dev.deviceId || dev.id || dev.name, style: { padding: '9px 12px', borderRadius: 8, border: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                  h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontSize: 13, fontWeight: 500 } }, dev.name || dev.deviceName || dev.deviceId || dev.id),
                    h('div', { style: { fontSize: 11, color: dswTheme.faint } }, [dev.deviceId || dev.id, dev.platform].filter(Boolean).join(' · '))),
                  h('span', { style: { fontSize: 11, color: dev.online === false ? dswTheme.faint : '#10b981' } }, dev.online === false ? '离线' : '● 在线')))),
            status?.dashboardUrl && h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, display: 'grid', gap: 8 } },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, '手机 / 浏览器控制入口'),
              h('div', { style: { fontSize: 11, color: dswTheme.dim, wordBreak: 'break-all' } }, status.dashboardUrl),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { type: 'button', style: uiButton(false), onClick: copyUrl }, copied ? '已复制链接' : '复制地址'),
                h('a', { href: status.dashboardUrl, target: '_blank', rel: 'noreferrer', style: { ...uiButton(false), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, '浏览器打开'))),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: uiButton(true), onClick: () => { onClose(); onOpenRemote(); } }, '打开远端设备会话 →'),
              h('button', { type: 'button', style: uiButton(false), onClick: onRefresh }, '重新连接')))));
    }

    class MarshalErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidUpdate(prevProps) { if (prevProps.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
      render() {
        if (this.state.error) {
          return h('div', { style: { flex: 1, padding: 28, display: 'grid', gap: 10, alignContent: 'center', justifyItems: 'center', textAlign: 'center' } },
            h('div', { style: { fontSize: 14, fontWeight: 600, color: dswTheme.danger } }, '页面渲染异常'),
            h('div', { style: { fontSize: 12, color: dswTheme.dim, maxWidth: 420, wordBreak: 'break-word' } }, String(this.state.error?.message || this.state.error)),
            h('button', { type: 'button', style: uiButton(false), onClick: () => this.setState({ error: null }) }, '重新加载页面'));
        }
        return this.props.children;
      }
    }

