    function AgentsPage({ onOpenChats, onOpenMemory, openSession, mvOpenDirect, workspaceService, initialSubTab = 'pool' }) {
      const [subTab, setSubTab] = React.useState(initialSubTab === 'rosters' ? 'rosters' : 'pool');
      const [library, setLibrary] = React.useState(null);
      const [extraWorkspaces, setExtraWorkspaces] = React.useState([]);
      const [sessions, setSessions] = React.useState([]);
      const [rosters, setRosters] = React.useState({});
      const [selectedAgentId, setSelectedAgentId] = React.useState('');
      const [selectedWsId, setSelectedWsId] = React.useState('');
      const [chatSearch, setChatSearch] = React.useState('');
      const [dispatchWsId, setDispatchWsId] = React.useState('');
      const [rosterDraft, setRosterDraft] = React.useState({ leaderId: '', coderId: '', reviewerId: '', members: [] });
      const [rosterNotice, setRosterNotice] = React.useState('');
      const [error, setError] = React.useState('');
      const [formOpen, setFormOpen] = React.useState(false);
      const [editingId, setEditingId] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [confirmId, setConfirmId] = React.useState('');
      const [name, setName] = React.useState('');
      const [preset, setPreset] = React.useState('');
      const [permission, setPermission] = React.useState('workspace-write');
      const [model, setModel] = React.useState('');
      const [brief, setBrief] = React.useState('');
      const [workspacePath, setWorkspacePath] = React.useState('');
      const [creatingWorkspace, setCreatingWorkspace] = React.useState(false);
      const [quick, setQuick] = React.useState('');
      const [quickBusy, setQuickBusy] = React.useState(false);
      const [chatBusy, setChatBusy] = React.useState(false);
      const [renamingSessionId, setRenamingSessionId] = React.useState('');
      const [renameSessionDraft, setRenameSessionDraft] = React.useState('');
      const [summarizingSessionId, setSummarizingSessionId] = React.useState('');

      React.useEffect(() => {
        if (initialSubTab === 'rosters' || initialSubTab === 'pool') setSubTab(initialSubTab);
      }, [initialSubTab]);

      const agents = library && Array.isArray(library.agents) ? library.agents : [];
      const presets = (library && library.presets) || [];
      const models = (library && library.models) || [];
      const realWorkspaces = React.useMemo(() => {
        const map = new Map();
        for (const ws of [...((library && library.workspaces) || []), ...extraWorkspaces]) {
          if (!ws || !ws.id || isPseudoAgentWorkspace(ws)) continue;
          if (!map.has(ws.id)) {
            map.set(ws.id, {
              id: ws.id,
              title: ws.title || ws.name || (ws.path ? String(ws.path).split('/').pop() : ws.id),
              path: ws.path || '',
            });
          }
        }
        return [...map.values()];
      }, [library, extraWorkspaces]);

      const load = async () => {
        try {
          const [lib, sessData, wsData, rosterData] = await Promise.all([
            loadAgentLibrary(),
            fetchJson('marshal/agents/sessions').catch(() => ({ sessions: [] })),
            fetchJson('marshal/task-rooms/workspaces', undefined, true).catch(() => ({ workspaces: [] })),
            fetchJson('marshal/rosters/state').catch(() => ({ rosters: {} })),
          ]);
          setLibrary(lib);
          setSessions(Array.isArray(sessData?.sessions) ? sessData.sessions : []);
          setExtraWorkspaces(Array.isArray(wsData?.workspaces) ? wsData.workspaces : []);
          setRosters(rosterData?.rosters || {});
          setSelectedAgentId(cur => (cur && (lib.agents || []).some(a => a.id === cur)) ? cur : (lib.agents?.[0]?.id || ''));
          const mergedReal = [...(lib.workspaces || []), ...(wsData?.workspaces || [])].filter(ws => ws && ws.id && !isPseudoAgentWorkspace(ws));
          if (mergedReal.length > 0) {
            setSelectedWsId(cur => (cur && mergedReal.some(w => w.id === cur)) ? cur : mergedReal[0].id);
            setDispatchWsId(cur => cur || mergedReal[0].id);
          }
          setError('');
        }
        catch (e) { setError(friendlyError(e, '智能体')); }
      };
      React.useEffect(() => { void load(); }, []);

      React.useEffect(() => {
        if (!selectedWsId) return;
        const r = rosters[selectedWsId] || {};
        setRosterDraft({
          leaderId: r.leaderId || '',
          coderId: r.coderId || '',
          reviewerId: r.reviewerId || '',
          members: Array.isArray(r.members) ? r.members : [],
        });
        setRosterNotice('');
      }, [selectedWsId, rosters]);

      const selectedAgent = agents.find(a => a.id === selectedAgentId) || agents[0] || null;
      const agentFullId = agent => agent.squadId + '/' + agent.id;

      const agentSessions = React.useMemo(() => {
        if (!selectedAgent) return [];
        const q = chatSearch.trim().toLowerCase();
        return sessions.filter(item => {
          const match = item.memberId === selectedAgent.id || (item.teamId === selectedAgent.squadId && item.agentName === selectedAgent.name);
          if (!match) return false;
          if (q && !String(item.title || '').toLowerCase().includes(q) && !String(item.sessionId || '').toLowerCase().includes(q)) return false;
          return true;
        });
      }, [sessions, selectedAgent, chatSearch]);

      const createWorkspace = async () => {
        const path = workspacePath.trim();
        if (!path.startsWith('/')) { setError('项目工作区路径必须是绝对路径'); return; }
        const service = typeof workspaceService === 'function' ? workspaceService() : workspaceService;
        if (!service || typeof service.create !== 'function') { setError('当前 DSH 版本不支持从插件新建工作区'); return; }
        setCreatingWorkspace(true);
        setError('');
        try {
          await fetchJson('marshal/workspaces/prepare', { path });
          const created = await service.create({ path });
          setWorkspacePath('');
          await load();
          if (created && created.workspaceId) setSelectedWsId(created.workspaceId);
        }
        catch (e) { setError('新建项目工作区失败：' + (e.message || e)); }
        finally { setCreatingWorkspace(false); }
      };

      const resetForm = () => {
        setEditingId('');
        setName('');
        setPreset('');
        setPermission('workspace-write');
        setModel('');
        setBrief('');
        setFormOpen(false);
      };

      const openEdit = agent => {
        setEditingId(agent.id);
        setName(agent.name || '');
        setPreset(agent.preset || '');
        setPermission(agent.permission || 'workspace-write');
        setModel(agent.model || '');
        setBrief(agent.brief || '');
        setFormOpen(true);
      };

      const saveAgent = async () => {
        if (!name.trim()) { setError('请填写名称'); return; }
        if (!library) return;
        setSaving(true);
        setError('');
        try {
          const current = editingId ? agents.find(agent => agent.id === editingId) : undefined;
          const member = { name: name.trim() };
          if (preset) member.preset = preset;
          if (permission) member.permission = permission;
          if (model) member.model = model;
          if (brief.trim()) member.brief = brief.trim();
          let teamId;
          if (current !== undefined) {
            teamId = current.squadId;
            member.id = current.id;
          }
          else {
            const team = await createAgentTeam(name.trim());
            teamId = team.id;
          }
          const saved = await fetchJson('dsh-agents/api/member', { teamId, member });
          const created = ((saved.team && saved.team.members) || []).find(item => item.name === name.trim());
          resetForm();
          await load();
          if (created) setSelectedAgentId(created.id);
        }
        catch (e) { setError((editingId ? '保存失败：' : '创建失败：') + (e.message || e)); }
        finally { setSaving(false); }
      };

      const quickCreate = async () => {
        if (!quick.trim()) { setError('先写一句话描述'); return; }
        if (!library) return;
        setQuickBusy(true);
        setError('');
        try {
          const defaultModel = (library.models || [])[0];
          const data = await fetchJson('marshal/agents/draft', {
            text: quick.trim(),
            ...(defaultModel && defaultModel.provider && defaultModel.model
              ? { provider: defaultModel.provider, model: defaultModel.model }
              : {}),
          });
          const draft = (data && data.draft) || {};
          const agentName = (draft.name || quick.trim().slice(0, 12)).slice(0, 40);
          const team = await createAgentTeam(agentName);
          const member = {
            name: agentName,
            permission: draft.permission || 'workspace-write',
          };
          if (draft.brief) member.brief = draft.brief;
          const saved = await fetchJson('dsh-agents/api/member', { teamId: team.id, member });
          const created = ((saved.team && saved.team.members) || []).find(item => item.name === agentName);
          setQuick('');
          await load();
          if (created) setSelectedAgentId(created.id);
        }
        catch (e) { setError('一句话创建失败：' + (e.message || e)); }
        finally { setQuickBusy(false); }
      };

      const saveSessionRename = async sessionId => {
        if (!sessionId) return;
        setError('');
        try {
          await fetchJson('marshal/agents/sessions/rename', { sessionId, title: renameSessionDraft.trim() });
          setRenamingSessionId('');
          setRenameSessionDraft('');
          await load();
        }
        catch (e) { setError('重命名失败：' + (e.message || e)); }
      };
      const summarizeSessionTitle = async sessionId => {
        if (!sessionId || summarizingSessionId) return;
        setSummarizingSessionId(sessionId);
        setError('');
        try {
          await fetchJson('marshal/agents/sessions/summarize', { sessionId, clearCustom: true });
          await load();
        }
        catch (e) { setError('总结标题失败：' + (e.message || e)); }
        finally { setSummarizingSessionId(''); }
      };
      const startCasualChat = async (agent) => {
        if (!agent || chatBusy) return;
        setChatBusy(true);
        setError('');
        try {
          const data = await fetchJson('dsh-agents/api/run', { teamId: agent.squadId, memberId: agent.id });
          const sessionId = data && data.run && data.run.sessionId;
          if (!sessionId) throw new Error('no-session');
          await load();
          openSession && openSession(sessionId);
        }
        catch (e) { setError('新建闲聊失败：' + (e.message || e)); }
        finally { setChatBusy(false); }
      };

      const workIn = async (agent, targetWsId) => {
        if (!agent || !targetWsId) return;
        setError('');
        try {
          const team = await createTaskTeam(agent.name, targetWsId);
          const cappedPerm = agent.permission === 'read-only' ? 'read-only' : 'workspace-write';
          const member = { name: agent.name, permission: cappedPerm };
          if (agent.preset) member.preset = agent.preset;
          if (agent.model) member.model = agent.model;
          if (agent.brief) member.brief = agent.brief;
          const saved = await fetchJson('dsh-agents/api/member', { teamId: team.id, member });
          const created = (saved.team && saved.team.members || []).find(item => item.name === agent.name) || (saved.team && saved.team.members || [])[0];
          if (!created) throw new Error('no-member');
          const data = await fetchJson('dsh-agents/api/run', { teamId: team.id, memberId: created.id });
          const sessionId = data && data.run && data.run.sessionId;
          if (!sessionId) throw new Error('no-session');
          await load();
          openSession && openSession(sessionId);
        }
        catch (e) { setError('派驻到工作区失败：' + (e.message || e)); }
      };

      const remove = async (agent) => {
        if (confirmId !== agent.id) { setConfirmId(agent.id); return; }
        if (!library) return;
        try {
          if (agent.legacy) await fetchJson('dsh-agents/api/member/delete', { teamId: agent.squadId, memberId: agent.id });
          else await fetchJson('dsh-agents/api/team/delete', { teamId: agent.squadId });
          setConfirmId('');
          await load();
        }
        catch (e) { setError('删除失败：' + (e.message || e)); }
      };

      const saveRoster = async () => {
        if (!selectedWsId) return;
        setSaving(true);
        setError('');
        setRosterNotice('');
        try {
          const res = await fetchJson('marshal/rosters/save', {
            workspaceId: selectedWsId,
            leaderId: rosterDraft.leaderId || undefined,
            coderId: rosterDraft.coderId || undefined,
            reviewerId: rosterDraft.reviewerId || undefined,
            members: rosterDraft.members,
          });
          setRosters(res?.rosters || {});
          setRosterNotice('已保存该工作区默认班底');
        }
        catch (e) { setError('保存班底失败：' + (e.message || e)); }
        finally { setSaving(false); }
      };

      const toggleRosterMember = fullId => {
        setRosterDraft(cur => {
          const exists = cur.members.includes(fullId);
          return { ...cur, members: exists ? cur.members.filter(x => x !== fullId) : [...cur.members, fullId] };
        });
      };

      const agentSessionCount = agent => sessions.filter(s => s.memberId === agent.id || (s.teamId === agent.squadId && s.agentName === agent.name)).length;
      const agentNameByFullId = fullId => {
        if (!fullId) return '';
        const found = agents.find(a => agentFullId(a) === fullId || a.id === fullId);
        return found ? found.name : fullId;
      };

      return h('section', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: dswTheme.bg, color: dswTheme.text } },
        h('header', { style: { padding: '12px 20px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0, flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('div', { role: 'tablist', 'aria-label': '智能体视图', style: { display: 'flex', gap: 4, padding: 3, borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer } },
              h('button', { type: 'button', role: 'tab', 'aria-selected': subTab === 'pool', style: tabStyle(subTab === 'pool'), onClick: () => setSubTab('pool') }, '全部智能体（人才库 · ' + agents.length + '）'),
              h('button', { type: 'button', role: 'tab', 'aria-selected': subTab === 'rosters', style: tabStyle(subTab === 'rosters'), onClick: () => setSubTab('rosters') }, '工作区班底（' + realWorkspaces.length + '）'))),
          h('div', { style: { display: 'flex', gap: 8 } },
            onOpenChats && h('button', { type: 'button', style: uiButton(false), onClick: onOpenChats }, '去会话'),
            subTab === 'pool' && h('button', { type: 'button', style: uiButton(true), onClick: () => { if (formOpen) resetForm(); else { setEditingId(''); setFormOpen(true); } } }, formOpen ? '收起' : '＋ 新建智能体'))),
        error && h('div', { style: { padding: '8px 20px', fontSize: 12, color: dswTheme.danger } }, error),

        subTab === 'pool' && h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          h('div', { style: { margin: '12px 20px 0', padding: '10px 14px', border: '1px solid ' + dswTheme.border, borderRadius: 12, background: dswTheme.layer, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
            h('input', { value: quick, onChange: event => setQuick(event.target.value), onKeyDown: event => { if (event.key === 'Enter') void quickCreate(); }, placeholder: '一句话新建全局智能体（不创建假工作区），如：严谨的代码审查员，先查边界条件', style: { ...uiInput, flex: 1 } }),
            h('button', { type: 'button', disabled: quickBusy, style: { ...uiButton(true), opacity: quickBusy ? .6 : 1, whiteSpace: 'nowrap' }, onClick: () => { void quickCreate(); } }, quickBusy ? '生成中…' : '一句话创建')),
          formOpen && h('div', { style: { margin: '12px 20px 0', padding: 16, border: '1px solid ' + dswTheme.border, borderRadius: 12, background: dswTheme.layer, display: 'grid', gap: 10, flexShrink: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, editingId ? '编辑智能体' : '新建全局智能体'),
              h('div', { style: uiMuted }, '全局独立实体 · 不创建假工作区，可自由派驻任意项目')),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 } },
              h(Field, { label: '名称' }, h('input', { value: name, onChange: event => setName(event.target.value), placeholder: '例如：工部尚书', style: uiInput })),
              h(Field, { label: '预设' }, h('select', { value: preset, onChange: event => setPreset(event.target.value), style: uiInput },
                h('option', { value: '' }, '默认预设'),
                presets.map(item => {
                  const id = typeof item === 'string' ? item : item.id;
                  const label = typeof item === 'string' ? item : (item.name || item.id);
                  return h('option', { key: id, value: id }, label);
                }))),
              h(Field, { label: '单聊默认权限' }, h('select', { value: permission, onChange: event => setPermission(event.target.value), style: uiInput },
                h('option', { value: 'read-only' }, '只读'),
                h('option', { value: 'workspace-write' }, '可写工作区（推荐）'),
                h('option', { value: 'danger-full-access' }, '完全访问（派驻工作区自动收紧为工作区可写）'))),
              h(Field, { label: '模型' }, h('select', { value: model, onChange: event => setModel(event.target.value), style: uiInput },
                h('option', { value: '' }, '默认模型'),
                models.map(item => {
                  const value = item.provider && item.model ? item.provider + '/' + item.model : (item.id || '');
                  return h('option', { key: value, value }, item.label || value);
                })))),
            h(Field, { label: '简报（人设与职责说明）' }, h('textarea', { value: brief, onChange: event => setBrief(event.target.value), rows: 3, placeholder: '它擅长什么、用什么语气、注意什么…', style: { ...uiInput, resize: 'vertical', lineHeight: 1.6 } })),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
              h('button', { type: 'button', style: uiButton(false), onClick: () => resetForm() }, '取消'),
              h('button', { type: 'button', disabled: saving, style: { ...uiButton(true), opacity: saving ? .6 : 1 }, onClick: () => { void saveAgent(); } }, saving ? '保存中…' : editingId ? '保存修改' : '创建智能体'))),
          agents.length === 0
            ? h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
                h(EmptyState, { title: '还没有智能体', hint: '智能体独立于项目工作区存在，可单聊、拉群，也可派驻到任意真实项目工作区。', action: '新建智能体', onAction: () => setFormOpen(true) }))
            : h('div', { style: { flex: 1, minHeight: 0, display: 'flex', marginTop: 12, borderTop: '1px solid ' + dswTheme.border, overflow: 'hidden' } },
                h('aside', { style: { width: 250, flexShrink: 0, borderRight: '1px solid ' + dswTheme.border, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
                  agents.map(agent => {
                    const active = selectedAgent && selectedAgent.id === agent.id;
                    const count = agentSessionCount(agent);
                    return h('button', {
                      key: agent.id, type: 'button',
                      style: { ...tabStyle(active), textAlign: 'left', padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 10 },
                      onClick: () => { setSelectedAgentId(agent.id); setConfirmId(''); },
                    },
                      h(Avatar, { name: agent.name, size: 28 }),
                      h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agent.name),
                        h('div', { style: { fontSize: 10, opacity: .65, marginTop: 2 } }, (agent.model || '默认模型') + ' · ' + count + ' 次闲聊')));
                  })),
                selectedAgent && h('div', { style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 20, display: 'grid', gap: 16, alignContent: 'start' } },
                  h('div', { style: { padding: 16, borderRadius: 12, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, display: 'grid', gap: 10 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
                      h(Avatar, { name: selectedAgent.name, size: 40 }),
                      h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: 16, fontWeight: 600 } }, selectedAgent.name),
                          h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border2, borderRadius: 999, padding: '2px 8px' } }, '全局智能体'),
                          h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border2, borderRadius: 999, padding: '2px 8px' } }, selectedAgent.permission || 'workspace-write')),
                        h('div', { style: { fontSize: 11, color: dswTheme.faint, marginTop: 4 } }, [selectedAgent.preset || '默认预设', selectedAgent.model || '默认模型'].join(' · '))),
                      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                        mvOpenDirect && h(mvDirectLink, { key: selectedAgent.id, agent: selectedAgent, open: mvOpenDirect }),
                        onOpenMemory && h('button', { type: 'button', style: uiButton(false), onClick: () => onOpenMemory(selectedAgent.id) }, '私有记忆'),
                        h('button', { type: 'button', style: uiButton(false), onClick: () => openEdit(selectedAgent) }, '编辑'),
                        h('button', { type: 'button', style: { ...uiButton(false), color: confirmId === selectedAgent.id ? dswTheme.danger : undefined }, onClick: () => { void remove(selectedAgent); } }, confirmId === selectedAgent.id ? '确认删除' : '删除'))),
                    selectedAgent.brief && h('div', { style: { fontSize: 12, color: dswTheme.dim, lineHeight: 1.65, whiteSpace: 'pre-wrap' } }, selectedAgent.brief)),

                  h('div', { style: { padding: 14, borderRadius: 12, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, display: 'grid', gap: 8 } },
                    h('div', { style: { fontSize: 13, fontWeight: 600 } }, '派驻到真实项目工作区'),
                    h('div', { style: { fontSize: 11, color: dswTheme.faint } }, '被派驻到工作区时自动限制为「工作区可写」权限；如需在看板按模板协同，可在「工作区班底」配置默认班底。'),
                    realWorkspaces.length === 0
                      ? h('div', { style: { fontSize: 12, color: dswTheme.dim } }, '还没有真实项目工作区，请切到上方「工作区班底」新建一个项目工作区。')
                      : h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                          h('select', { value: dispatchWsId, onChange: event => setDispatchWsId(event.target.value), style: { ...uiInput, flex: 1, minWidth: 200 } },
                            realWorkspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.title + (ws.path ? ' · ' + ws.path : '')))),
                          h('button', { type: 'button', style: uiButton(false), onClick: () => { void workIn(selectedAgent, dispatchWsId); } }, '派驻并开启会话'))),

                  h('div', { style: { padding: 14, borderRadius: 12, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, display: 'grid', gap: 10 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      h('div', { style: { fontSize: 13, fontWeight: 600 } }, '闲聊会话历史（' + agentSessions.length + '）'),
                      h('input', { value: chatSearch, onChange: event => setChatSearch(event.target.value), placeholder: '搜索历史闲聊…', style: { ...uiInput, width: 190, marginLeft: 'auto' } }),
                      h('button', { type: 'button', disabled: chatBusy, style: uiButton(true), onClick: () => { void startCasualChat(selectedAgent); } }, chatBusy ? '创建中…' : '＋ 新建闲聊')),
                    agentSessions.length === 0
                      ? h('div', { style: { fontSize: 12, color: dswTheme.faint, padding: '8px 0' } }, '还没有与「' + selectedAgent.name + '」的闲聊历史，点“＋ 新建闲聊”立即开始。')
                      : h('div', { style: { display: 'grid', gap: 6, maxHeight: 320, overflow: 'auto' } },
                          agentSessions.map(item => h('div', {
                            key: item.sessionId,
                            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid ' + dswTheme.border, cursor: renamingSessionId === item.sessionId ? 'default' : 'pointer' },
                            onClick: () => { if (renamingSessionId !== item.sessionId) openSession && openSession(item.sessionId); },
                          },
                            h('div', { style: { flex: 1, minWidth: 0 } },
                              renamingSessionId === item.sessionId
                                ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, onClick: e => e.stopPropagation() },
                                    h('input', {
                                      value: renameSessionDraft,
                                      autoFocus: true,
                                      placeholder: '输入新标题（留空恢复自动标题）',
                                      style: { ...uiInput, flex: 1, padding: '4px 8px', fontSize: 12 },
                                      onChange: e => setRenameSessionDraft(e.target.value),
                                      onKeyDown: e => { if (e.key === 'Enter') void saveSessionRename(item.sessionId); if (e.key === 'Escape') setRenamingSessionId(''); },
                                    }),
                                    h('button', { type: 'button', style: { ...uiButton(true), padding: '4px 8px', fontSize: 11 }, onClick: () => { void saveSessionRename(item.sessionId); } }, '保存'),
                                    h('button', { type: 'button', style: { ...uiButton(false), padding: '4px 7px', fontSize: 11 }, onClick: () => setRenamingSessionId('') }, '取消'))
                                : h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                                    h('span', { style: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.title }, item.title || '历史闲聊'),
                                    item.titleSource === 'custom' && h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border, borderRadius: 999, padding: '0 5px', flexShrink: 0 } }, '已重命名'),
                                    item.titleSource === 'auto' && h('span', { style: { fontSize: 10, color: dswTheme.faint, border: '1px solid ' + dswTheme.border, borderRadius: 999, padding: '0 5px', flexShrink: 0 } }, '自动总结'),
                                    item.legacyReadOnly && h('span', { title: '原独立工作区已迁出清壳，仅作历史查阅；继续对话请点「新建闲聊」', style: { fontSize: 10, color: '#f59e0b', border: '1px solid color-mix(in srgb, #f59e0b 45%, transparent)', background: 'color-mix(in srgb, #f59e0b 10%, transparent)', borderRadius: 999, padding: '0 5px', flexShrink: 0 } }, '历史只读')),
                              h('div', { style: { fontSize: 10, color: dswTheme.faint, marginTop: 2 } }, [formatSessionTime(item.updatedAt || item.createdAt), item.sessionId.slice(0, 8)].filter(Boolean).join(' · '))),
                            renamingSessionId !== item.sessionId && h('div', { style: { display: 'flex', gap: 5, flexShrink: 0 }, onClick: e => e.stopPropagation() },
                              h('button', { type: 'button', title: '重命名', style: { ...uiButton(false), padding: '4px 7px', fontSize: 11 }, onClick: () => { setRenamingSessionId(item.sessionId); setRenameSessionDraft(item.title || ''); } }, '重命名'),
                              h('button', { type: 'button', title: '总结标题', disabled: summarizingSessionId === item.sessionId, style: { ...uiButton(false), padding: '4px 7px', fontSize: 11 }, onClick: () => { void summarizeSessionTitle(item.sessionId); } }, summarizingSessionId === item.sessionId ? '…' : '✨'),
                              h('button', { type: 'button', style: { ...uiButton(false), padding: '4px 9px', fontSize: 11 }, onClick: () => openSession && openSession(item.sessionId) }, '打开'))))))))),

        subTab === 'rosters' && h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          h('div', { style: { margin: '12px 20px 0', padding: '10px 14px', border: '1px solid ' + dswTheme.border, borderRadius: 12, background: dswTheme.layer, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
            h('input', { value: workspacePath, onChange: event => setWorkspacePath(event.target.value), placeholder: '新建真实项目工作区（输入绝对路径，例如 /Users/you/projects/app）', style: { ...uiInput, flex: 1 } }),
            h('button', { type: 'button', disabled: creatingWorkspace, style: { ...uiButton(false), whiteSpace: 'nowrap' }, onClick: () => { void createWorkspace(); } }, creatingWorkspace ? '创建中…' : '＋ 新建项目工作区')),
          realWorkspaces.length === 0
            ? h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
                h(EmptyState, { title: '还没有项目工作区', hint: '在上方输入项目目录绝对路径，即可创建真实项目工作区并配置默认班底。' }))
            : h('div', { style: { flex: 1, minHeight: 0, display: 'flex', marginTop: 12, borderTop: '1px solid ' + dswTheme.border, overflow: 'hidden' } },
                h('aside', { style: { width: 250, flexShrink: 0, borderRight: '1px solid ' + dswTheme.border, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
                  realWorkspaces.map(ws => {
                    const active = selectedWsId === ws.id;
                    const r = rosters[ws.id];
                    return h('button', {
                      key: ws.id, type: 'button',
                      style: { ...tabStyle(active), textAlign: 'left', padding: '9px 10px', display: 'grid', gap: 3 },
                      onClick: () => setSelectedWsId(ws.id),
                    },
                      h('div', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ws.title),
                      h('div', { style: { fontSize: 10, opacity: .65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r?.leaderId ? 'Leader: ' + agentNameByFullId(r.leaderId) : (ws.path || '尚未配置默认班底')));
                  })),
                selectedWsId && h('div', { style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 20, display: 'grid', gap: 14, alignContent: 'start' } },
                  h('div', null,
                    h('div', { style: { fontSize: 15, fontWeight: 600 } }, (realWorkspaces.find(w => w.id === selectedWsId)?.title || selectedWsId) + ' · 工作区班底'),
                    h('div', { style: { fontSize: 11, color: dswTheme.faint, marginTop: 4 } }, realWorkspaces.find(w => w.id === selectedWsId)?.path || '')),
                  h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, fontSize: 12, color: dswTheme.dim, lineHeight: 1.6 } },
                    '在任务看板选择该工作区时，将自动套用这里的默认 Leader。派驻到工作区执行时默认授予「工作区可写」权限并开启 Leader 自动审核；如遇权限受阻，工单会自动转入「待确认」列等待确认。'),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } },
                    h(Field, { label: '默认 Leader（统筹与自动审核）' },
                      h('select', { value: rosterDraft.leaderId, style: uiInput, onChange: event => setRosterDraft(cur => ({ ...cur, leaderId: event.target.value })) },
                        h('option', { value: '' }, '不预设'),
                        agents.map(a => h('option', { key: a.id, value: agentFullId(a) }, a.name)))),
                    h(Field, { label: '默认 Coder（主力开发）' },
                      h('select', { value: rosterDraft.coderId, style: uiInput, onChange: event => setRosterDraft(cur => ({ ...cur, coderId: event.target.value })) },
                        h('option', { value: '' }, '不预设'),
                        agents.map(a => h('option', { key: a.id, value: agentFullId(a) }, a.name)))),
                    h(Field, { label: '默认 Reviewer（独立审查）' },
                      h('select', { value: rosterDraft.reviewerId, style: uiInput, onChange: event => setRosterDraft(cur => ({ ...cur, reviewerId: event.target.value })) },
                        h('option', { value: '' }, '不预设'),
                        agents.map(a => h('option', { key: a.id, value: agentFullId(a) }, a.name))))),
                  h(Field, { label: '常驻协作班底成员（点击切换）' },
                    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                      agents.map(a => {
                        const fid = agentFullId(a);
                        const on = rosterDraft.members.includes(fid);
                        return h('button', {
                          key: a.id, type: 'button',
                          style: { ...tabStyle(on), border: '1px solid ' + (on ? dswTheme.brand : dswTheme.border), padding: '6px 12px' },
                          onClick: () => toggleRosterMember(fid),
                        }, (on ? '✓ ' : '＋ ') + a.name);
                      }))),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
                    h('button', { type: 'button', disabled: saving, style: uiButton(true), onClick: () => { void saveRoster(); } }, saving ? '保存中…' : '保存工作区班底'),
                    rosterNotice && h('span', { style: { fontSize: 12, color: '#10b981' } }, rosterNotice))))));
    }
    function SafeMarshalPanel(props) {
      return h(MarshalErrorBoundary, { resetKey: 'marshal-panel-root' }, h(MarshalPanel, props));
    }

