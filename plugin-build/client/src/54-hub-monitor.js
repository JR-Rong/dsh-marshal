    const MV_HUB_MONITOR_TOPICS = [...MV_HUB_TASK_TOPICS, 'memory.changed'];
    const MV_HUB_OVERVIEW = signal => fetchJson('marshal/desktop/overview', undefined, true, signal);
    const MV_HUB_DEVICES = signal => fetchJson('marshal/devices/status', undefined, true, signal);
    const MV_HUB_CHROME_READS = { incidents: MV_HUB_INCIDENTS, devices: MV_HUB_DEVICES,
      health: signal => fetchJson('marshal/health', undefined, true, signal) };
    const MV_HUB_MONITOR_READS = { overview: MV_HUB_OVERVIEW, incidents: MV_HUB_INCIDENTS, board: MV_HUB_KANBAN_READS.board };
    const MV_HUB_INCIDENT_KINDS = [['review-blocked', '待人工裁决'], ['failed', '执行失败或受阻'], ['tool-anomaly', '工具异常'], ['memory-proposal', '待审记忆提案']];
    const MV_HUB_INCIDENT_TONES = { 'review-blocked': 'review', failed: 'critical', 'tool-anomaly': 'warning', 'memory-proposal': 'memory' };
    const MV_HUB_METRIC_TONES = [['工单总数', 'info'], ['智能体总数', 'running'], ['严重告警数', 'critical'],
      ['待审记忆提案数', 'memory'], ['主机', 'neutral']];

    function MarshalHubMonitorView({ openTaskRoom, onOpenMemory, onOpenDirect }) {
      const [data, refresh] = mvUseHubSnapshot(MV_HUB_MONITOR_TOPICS, MV_HUB_MONITOR_READS);
      const action = mvUseHubAction(refresh);
      const overview = data.overview;
      const summary = data.incidents ?? overview?.incidents;
      const metrics = [['工单总数', overview?.tasks?.totalCount], ['智能体总数', overview?.agents?.totalCount],
        ['严重告警数', summary?.criticalCount], ['待审记忆提案数', overview?.memory?.pendingProposalCount ?? summary?.countsByKind?.['memory-proposal']], ['主机', overview?.host?.deviceId]];
      const tasks = new Map((data.board?.tasks ?? []).map(task => [task.id, task]));
      const agents = new Map((overview?.agents?.items ?? []).map(agent => [agent.agentKey, agent]));
      const resolveTask = (path, taskId, notice) => action.run(async signal => {
        const result = await fetchJson(path, { taskId }, true, signal);
        if (!signal.aborted) action.setNotice(mvHubRunIssue(result) || result.notice || result.message || notice);
      });
      const handle = row => {
        if (row.kind === 'memory-proposal') return onOpenMemory('', 'global');
        if (row.targetType === 'agent') return agents.has(row.targetId) && onOpenDirect?.(agents.get(row.targetId));
        return openTaskRoom(tasks.get(row.targetId) ?? { id: row.targetId, title: row.title });
      };
      return h('section', { className: 'mv-scope mv-room', 'aria-label': '问题监控' },
        h('header', { className: 'mv-actions' }, h('h2', { className: 'mv-copy mv-voice-title' }, '问题监控'), h(MvButton, { label: '刷新', onClick: refresh })),
        h('dl', { className: 'mv-actions', 'aria-label': '系统总览' }, metrics.map(([label, value], index) =>
          h('div', { className: 'mv-mini mv-metric', key: label, 'data-tone': MV_HUB_METRIC_TONES[index]?.[1] },
            h('dt', { className: 'mv-muted' }, label), h('dd', null, value ?? '—')))),
        data.loading && h('p', { role: 'status' }, '正在读取告警…'),
        data.error && h('p', { role: 'alert' }, data.error),
        action.notice && h('p', { role: 'status' }, action.notice),
        MV_HUB_INCIDENT_KINDS.map(([kind, label]) => {
          const rows = (summary?.items ?? []).filter(row => row.kind === kind);
          const tone = MV_HUB_INCIDENT_TONES[kind];
          return h('section', { key: kind, 'aria-label': label },
            h('h3', { className: 'mv-lane-head' }, h('span', { className: 'mv-tone-dot', 'data-tone': tone }),
              label, h('span', { className: 'mv-tone-count' }, summary?.countsByKind?.[kind] ?? rows.length)),
            rows.map(row => {
              const task = tasks.get(row.targetId);
              const actionable = mvHubIsTaskIncident(row);
              const plain = task && !task.workflow;
              const blocked = mvHubHasPermissionBlock(task, row, data.board?.sessionDefaultPermission);
              return h('article', { key: row.id, className: 'mv-agent-card',
                'data-tone': row.severity === 'critical' ? 'critical' : tone },
                h('div', { className: 'mv-actions' }, h('strong', { className: 'mv-copy' }, row.title),
                  h('span', { className: 'mv-tone-chip', 'data-solid': 'true',
                    style: { '--mv-tone': row.severity === 'critical' ? '#cf5f7a' : '#d08a2a' } },
                    row.severity === 'critical' ? '严重' : '待处理')),
                h('div', { className: 'mv-muted', style: { overflowWrap: 'anywhere' } }, row.subtitle),
                h('div', { className: 'mv-actions' }, h(MvButton, { label: kind === 'memory-proposal' ? '查看记忆提案' : row.targetType === 'agent' ? '打开智能体' : '进入工单群处理',
                  disabled: row.targetType === 'agent' && (!onOpenDirect || !agents.has(row.targetId)), onClick: () => handle(row) }),
                  actionable && plain && !mvHubIsLive(task) && mvHubLane(task) !== 'done' && h(MvButton, { label: '重试运行', disabled: action.busy,
                    onClick: () => resolveTask('marshal/tasks/run', row.targetId, '已提交运行请求') }),
                  actionable && blocked && (!task || mvHubLane(task) !== 'done') && h(MvButton, { label: '单次放行', disabled: action.busy,
                    onClick: () => resolveTask('marshal/tasks/confirm-permission', row.targetId, '已提交放行请求') })));
            }));
        }));
    }
