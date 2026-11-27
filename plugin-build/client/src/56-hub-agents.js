    const MV_HUB_AGENT_TOPICS = [...MV_HUB_TASK_TOPICS, 'agents.changed', 'groups.changed'];
    async function mvHubAgentDirectory(signal) {
      const overview = await MV_HUB_OVERVIEW(signal);
      const rows = overview.agents?.items ?? [];
      const counts = {};
      // Bound concurrency: each directory member may have a separate task list.
      for (let index = 0; index < rows.length && !signal.aborted; index += 6) {
        await Promise.all(rows.slice(index, index + 6).map(async agent => {
          try {
            const result = await fetchJson('marshal/agent-tasks?' + new URLSearchParams({ agentKey: agent.agentKey }), undefined, true, signal);
            const tasks = result.tasks ?? [];
            counts[agent.agentKey] = { total: tasks.length, done: tasks.filter(task => task.status === 'done').length };
          } catch { /* Keep the directory usable if one member's task list is unavailable. */ }
        }));
      }
      return { overview, counts };
    }
    const MV_HUB_AGENT_READS = {
      directory: mvHubAgentDirectory, devices: MV_HUB_DEVICES,
      rosters: signal => fetchJson('marshal/rosters/state', undefined, true, signal),
      workspaces: MV_HUB_KANBAN_READS.workspaces,
      library: signal => loadAgentLibrary(signal, true),
    };

    function MarshalHubAgentsView({ onOpenChats, onOpenMemory, openSession, mvOpenDirect, onStartVoice, initialSubTab = 'pool' }) {
      const [data, refresh, patchSnapshot] = mvUseHubSnapshot(MV_HUB_AGENT_TOPICS, MV_HUB_AGENT_READS);
      const action = mvUseHubAction(refresh);
      const [sub, setSub] = React.useState(initialSubTab);
      const [drawer, setDrawer] = React.useState(false);
      const [workspaceId, setWorkspace] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const overview = data.directory?.overview;
      const workspaces = (data.workspaces?.workspaces ?? data.library?.workspaces ?? []).filter(row => !isPseudoAgentWorkspace(row));
      const workspace = workspaceId || (workspaces.length === 1 ? workspaces[0].id : '');
      const saved = data.rosters?.rosters?.[workspace];
      const roster = draft ?? saved ?? {};
      const library = new Map((data.library?.agents ?? []).map(member => [member.squadId + '/' + member.id, member]));
      const teams = new Map();
      const agents = (overview?.agents?.items ?? []).map(agent => {
        const id = agent.teamId + '/' + agent.agentId;
        const local = library.get(id);
        const teamName = local?.teamName || agent.teamName || agent.teamId;
        const member = { ...local, ...agent, global: agent.global || local?.global,
          teamGlobal: isAgentTeam({ name: teamName }), rosterId: id, teamName };
        if (!teams.has(agent.teamId)) teams.set(agent.teamId, { name: member.teamName, members: [] });
        teams.get(agent.teamId).members.push(member);
        return member;
      });
      const candidates = agents.filter(agent => agent.global || agent.teamGlobal || !agent.workspaceId || agent.workspaceId === workspace);
      const options = candidates.map(agent => [agent.rosterId, agent.name || agent.agentId]);
      const devices = new Map();
      const deviceStatus = data.devices;
      const host = overview?.host;
      for (const row of deviceStatus?.devices ?? []) {
        const id = row?.deviceId || row?.id;
        if (id) devices.set(id, { ...devices.get(id), ...row, deviceId: id });
      }
      const localId = host?.deviceId || deviceStatus?.deviceId;
      if (localId) devices.set(localId, { ...devices.get(localId), ...host, deviceId: localId, online: true });
      const save = () => action.run(async signal => {
        const result = await fetchJson('marshal/rosters/save', { workspaceId: workspace,
          leaderId: roster.leaderId || undefined, coderId: roster.coderId || undefined, reviewerId: roster.reviewerId || undefined,
          members: roster.members ?? [] }, true, signal);
        if (!signal.aborted) {
          if (result.rosters) patchSnapshot({ rosters: result });
          setDraft(null); action.setNotice('已保存工作区默认阵容');
        }
      });
      return h('section', { className: 'mv-scope mv-room', 'aria-label': '智能体与集群' },
        h('header', { className: 'mv-actions' }, h('h2', { className: 'mv-copy mv-voice-title' }, '智能体与集群'),
          onOpenChats && h(MvButton, { label: '历史单聊', onClick: onOpenChats }),
          h(MvButton, { label: '设备节点', 'aria-expanded': drawer, onClick: () => setDrawer(true) })),
        h('div', { className: 'mv-actions', role: 'group', 'aria-label': '智能体与集群分类' },
          h(MvButton, { label: '智能体团队', 'aria-pressed': sub !== 'rosters', onClick: () => setSub('pool') }),
          h(MvButton, { label: '工作区默认阵容', 'aria-pressed': sub === 'rosters', onClick: () => setSub('rosters') })),
        data.loading && h('p', { role: 'status' }, '正在读取智能体与集群…'),
        data.error && h('div', { role: 'alert' }, data.error, h(MvButton, { label: '刷新', onClick: refresh })),
        sub === 'rosters' ? h('section', { className: 'mv-stack', 'aria-label': '工作区默认阵容' },
          mvHubSelect('阵容工作区', workspace, workspaces.map(row => [row.id, row.name || row.title || row.id]), value => {
            setWorkspace(value); setDraft(null); action.setNotice('');
          }, action.busy, '选择工作区'),
          workspace && h('div', { className: 'mv-stack' },
            Object.entries(MV_HUB_ROLE_LABELS).map(([id, label]) => h('div', { key: id }, mvHubSelect('默认 ' + label, roster[id + 'Id'] || '', options,
              value => setDraft({ ...roster, [id + 'Id']: value }), action.busy, '不指定'))),
            h('fieldset', { className: 'mv-mini mv-actions' }, h('legend', null, '默认成员'),
              options.map(([id, name]) => h('label', { key: id, className: 'mv-line' }, h('input', { type: 'checkbox',
                checked: (roster.members ?? []).includes(id), disabled: action.busy,
                onChange: e => setDraft({ ...roster, members: e.target.checked ? [...(roster.members ?? []), id] : (roster.members ?? []).filter(value => value !== id) }) }), name))),
            h('div', null, h(MvButton, { label: '保存工作区默认阵容', disabled: action.busy || !data.rosters, onClick: save })),
            action.notice && h('p', { role: 'status' }, action.notice)))
          : h('div', { className: 'mv-stack' },
            !data.loading && teams.size === 0 && h('p', { className: 'mv-muted' }, '暂无可用智能体'),
            [...teams].map(([id, team]) => h('section', { key: id, 'aria-label': team.name },
              h('h3', { className: 'mv-voice-title' }, team.name), team.members.map(agent => {
                const counts = data.directory?.counts?.[agent.agentKey];
                return h('article', { className: 'mv-agent-card', key: agent.agentKey },
                  h('strong', null, agent.name || agent.agentId),
                  h('div', { className: 'mv-actions' }, h('span', { className: 'mv-model' }, agent.model || '默认模型'),
                    h('span', { className: 'mv-model' }, TASK_PERMISSION_LABELS[agent.permission] || agent.permission || '默认权限'),
                    h('span', { className: 'mv-muted' }, '1:1 任务：' + (counts ? counts.done + ' / ' + counts.total + ' 已完成' : '未获取'))),
                  h('div', { className: 'mv-actions' },
                    h(MvButton, { label: '1:1 原生对话', disabled: !mvOpenDirect, onClick: () => mvOpenDirect(agent) }),
                    h(MvButton, { icon: 'phone', label: '语音通话', iconOnly: true, disabled: !onStartVoice, onClick: () => onStartVoice(agent) }),
                    h(MvButton, { label: '私有记忆', onClick: () => onOpenMemory(agent.agentId) }),
                    agent.sessionId && openSession && h(MvButton, { label: '最近执行会话', onClick: () => openSession(agent.sessionId) })));
              })))),
        h(DeviceStatusDrawer, { open: drawer, onClose: () => setDrawer(false), status: { ...deviceStatus, deviceId: localId, devices: [...devices.values()] },
          onRefresh: refresh, onOpenRemote: () => { window.dispatchEvent(new CustomEvent('marshal:tab', { detail: 'remote' })); } }));
    }
