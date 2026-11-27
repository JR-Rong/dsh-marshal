    const MV_DAG_WIDTH_KEY = 'marshal.dag-sidebar.width.v1';
    const MV_DAG_MIN = 260;
    const MV_DAG_MAX = 520;
    const MV_DAG_STATUS = {
      done: '已完成', recorded: '已记录', running: '运行中', review: '待确认',
      'review-blocked': '审查待裁决', 'permission-blocked': '权限受阻',
      failed: '失败', cancelled: '已取消', interrupted: '已中断',
    };

    function mvDagWidth(value) {
      return Math.round(Math.min(MV_DAG_MAX, Math.max(MV_DAG_MIN, value)));
    }

    function mvDagInitialWidth() {
      try {
        const width = Number(localStorage.getItem(MV_DAG_WIDTH_KEY));
        if (width > 0 && Number.isFinite(width)) return mvDagWidth(width);
      } catch { /* Storage may be unavailable in the native host. */ }
      return 340;
    }

    function mvDagRows(layers) {
      return layers.flatMap(layer => {
        const nodes = layer.nodes ?? [];
        return layer.type === 'parallel' && nodes.length >= 2 ? [{ id: layer.id, nodes }]
          : nodes.map(node => ({ id: node.id, nodes: [node] }));
      });
    }

    // Nodes occupy equal-width grid tracks without column gaps. Each anchor
    // is the center of its track; SVG stretches with the same width as the grid.
    function mvDagPaths(from, to) {
      const x = (index, count) => 100 * (index + .5) / count;
      if (from.nodes.length > 1 && to.nodes.length > 1) {
        // Layers encode ordering, not pairwise dependencies between parallel
        // nodes. Use a shared junction instead of inventing N×M edges.
        const incoming = from.nodes.map((_, i) => {
          const a = x(i, from.nodes.length);
          return `M${a} 0 C${a} 6 50 6 50 12`;
        });
        const outgoing = to.nodes.map((_, i) => {
          const b = x(i, to.nodes.length);
          return `M50 12 C50 18 ${b} 18 ${b} 24`;
        });
        return [...incoming, ...outgoing];
      }
      return from.nodes.flatMap((_, i) => to.nodes.map((_, j) => {
        const a = x(i, from.nodes.length), b = x(j, to.nodes.length);
        return a === b ? `M${a} 0 V24` : `M${a} 0 C${a} 12 ${b} 12 ${b} 24`;
      }));
    }

    function mvDagCanvas({ layers, onInspect }) {
      const rows = mvDagRows(layers);
      if (!rows.length) return h('p', null, '暂无编排节点');
      return h('div', { className: 'mv-dag-canvas' }, rows.map((row, i) =>
        h(React.Fragment, { key: row.id },
          i > 0 && h('svg', { className: 'mv-dag-edges', viewBox: '0 0 100 24', preserveAspectRatio: 'none', 'aria-hidden': true },
            mvDagPaths(rows[i - 1], row).map((d, index) => h('path', {
              key: index, d, fill: 'none', stroke: 'currentColor', vectorEffect: 'non-scaling-stroke',
            }))),
          h('div', { className: 'mv-dag-layer', 'data-parallel': row.nodes.length > 1,
            style: { gridTemplateColumns: `repeat(${row.nodes.length}, minmax(0, 1fr))` } },
            row.nodes.map(node => {
              const tokens = node.tokens?.totalTokens;
              const metrics = [Number.isFinite(node.durationMs) && node.durationMs + ' ms',
                Number.isFinite(tokens) && tokens.toLocaleString() + ' tokens'].filter(Boolean).join(' · ');
              return h('button', { key: node.id, type: 'button', className: 'mv-dag-node', onClick: () => onInspect(node.id) },
                h('strong', null, node.label ?? node.phase),
                h('span', { className: 'mv-dag-state', 'data-state': node.status },
                  h('svg', { width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': true },
                    h('circle', { cx: 4, cy: 4, r: 3, fill: 'currentColor' })), (MV_DAG_STATUS[node.status] ?? node.status)),
                (node.role || node.agentName) && h('span', null, [node.role, node.agentName].filter(Boolean).join(' · ')),
                node.model && h('span', { className: 'mv-model' }, node.model),
                metrics && h('span', null, metrics));
            })))));
    }

    function mvUseDagReview(taskId, task, onReview) {
      const [busy, setBusy] = React.useState(false);
      const [doneRound, setDoneRound] = React.useState(null);
      const [error, setError] = React.useState('');
      const pending = React.useRef(false);
      const available = taskId && task && !task.taskRoom?.closed && task.status !== 'done' &&
        (task.status === 'review' || task.workflow?.state === 'review-blocked');
      const roundKey = String(task?.workflow?.runId || task?.updatedAt || taskId || '');
      const done = available && doneRound === roundKey;
      const run = async action => {
        if (!available || done || pending.current) return;
        pending.current = true;
        setBusy(true);
        setError('');
        try {
          if (onReview) {
            if (await onReview(action, taskId) === false) throw new Error('工单操作未完成。');
          } else {
            await fetchJson(action === 'confirm' ? 'marshal/tasks/confirm-review' : 'marshal/tasks/revise',
              action === 'confirm' ? { taskId, applyPatch: false } : { taskId }, true);
          }
          setDoneRound(roundKey);
        } catch (failure) { setError(failure.message || String(failure)); }
        finally { pending.current = false; setBusy(false); }
      };
      return { available: available && !done, busy, error, run };
    }

    function mvDagReviewActions({ review }) {
      return h(React.Fragment, null, review.available && h('div', { className: 'mv-dag-actions' },
        h(MvButton, { label: '确认验收', title: '确认通过并归档，不应用补丁', disabled: review.busy, onClick: () => void review.run('confirm') }),
        h(MvButton, { label: '打回返工', disabled: review.busy, onClick: () => void review.run('revise') })),
      review.error && h('p', { role: 'alert' }, review.error));
    }

    function mvDagDetailSection(title, children) {
      return h('section', { className: 'mv-dag-detail' }, h('h3', null, title), children);
    }

    function mvDagDiff({ diff }) {
      let inHunk = false;
      return h('pre', { className: 'mv-dag-diff', tabIndex: 0 }, diff.split('\n').map((line, index) => {
        if (line.startsWith('diff --git ')) inHunk = false;
        if (line.startsWith('@@')) inHunk = true;
        const header = !inHunk && /^(?:\+\+\+|---) /.test(line);
        return h('span', { key: index, 'data-change': header ? undefined
          : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined }, line, '\n');
      }));
    }

    function mvDagDetail({ node }) {
      const paths = node.artifactPaths ?? [];
      return h(React.Fragment, null,
        mvDagDetailSection('执行摘要', h('p', null, node.summary || '暂无执行摘要')),
        mvDagDetailSection('变更文件', node.diffFiles?.length ? h('ul', null, node.diffFiles.map(path =>
          h('li', { key: path }, h('code', null, path)))) : '暂无变更文件'),
        node.diff && mvDagDetailSection('Diff', h(mvDagDiff, { diff: node.diff })),
        mvDagDetailSection('执行日志', node.logs?.length ? h('ol', null, node.logs.map((log, i) =>
          h('li', { key: log.id ?? log.seq ?? i },
            h('strong', null, [log.actor, log.kind, Number.isFinite(log.at) ? new Date(log.at).toLocaleString() : null].filter(Boolean).join(' · ')),
            h('pre', { className: 'mv-dag-log' }, log.text),
            log.trace && h('details', null, h('summary', null, '执行轨迹'), h('pre', { className: 'mv-dag-log' }, JSON.stringify(log.trace, null, 2))))
        )) : '暂无执行日志'),
        mvDagDetailSection('产物路径', paths.length ? h('ul', null, paths.map(path =>
          h('li', { key: path }, h('code', null, path)))) : '未返回产物路径'),
        node.patchDigest && mvDagDetailSection('补丁摘要值', h('code', null, node.patchDigest)),
        node.reportId && mvDagDetailSection('报告标识', h('code', null, node.reportId)));
    }

    function mvDagNodeDialog({ taskId, nodeId, onClose, review, refresh }) {
      const dialog = React.useRef(null);
      const heading = React.useId();
      const [node, setNode] = React.useState(null);
      const [error, setError] = React.useState('');
      const [retry, setRetry] = React.useState(0);
      React.useEffect(ensureMarshalVnextStyles, []);
      React.useEffect(() => {
        const element = dialog.current;
        const previous = document.activeElement;
        element?.showModal();
        return () => { if (element?.open) element.close(); previous?.focus(); };
      }, []);
      React.useEffect(() => {
        const controller = new AbortController();
        setError('');
        void fetchJson('marshal/tasks/dag/node?' + new URLSearchParams({ taskId, nodeId }), undefined, true, controller.signal)
          .then(data => { if (!controller.signal.aborted) setNode(data.node); })
          .catch(failure => {
            if (controller.signal.aborted) return;
            setNode(null);
            setError(failure.message || String(failure));
          });
        return () => controller.abort();
      }, [taskId, nodeId, refresh, retry]);
      return h('dialog', { ref: dialog, className: 'mv-scope mv-dag-dialog', 'aria-labelledby': heading,
        onCancel: e => { e.preventDefault(); onClose(); } },
        h('header', { className: 'mv-dag-header' }, h('strong', { id: heading }, node?.label || '节点详情'),
          h(MvButton, { label: '关闭节点详情', icon: 'close', iconOnly: true, autoFocus: true, onClick: onClose })),
        h('div', { className: 'mv-dag-dialog-body' },
          h(mvDagReviewActions, { review }),
          error && h('div', { role: 'alert' }, error, ' ', h(MvButton, { label: '重试', onClick: () => setRetry(n => n + 1) })),
          node ? h(mvDagDetail, { node }) : !error && h('p', { role: 'status' }, '正在读取节点详情…')));
    }

    function mvDagStandaloneNode({ task, onReview, ...props }) {
      const review = mvUseDagReview(props.taskId, task, onReview);
      return h(mvDagNodeDialog, { ...props, review });
    }

    // Standalone inspector: pass the current task projection for review controls.
    function mvDagNodeModal(props) {
      return props.taskId && props.nodeId ? h(mvDagStandaloneNode, {
        ...props, key: JSON.stringify([props.taskId, props.nodeId]),
      }) : null;
    }

    function mvDagTaskBody({ taskId, task, onReview, collapsed }) {
      const [layers, setLayers] = React.useState(null);
      const [taskState, setTaskState] = React.useState(undefined);
      const [error, setError] = React.useState('');
      const [stateError, setStateError] = React.useState('');
      const [nodeId, inspect] = React.useState(null);
      const [refresh, setRefresh] = React.useState(0);
      const [retry, setRetry] = React.useState(0);
      const review = mvUseDagReview(taskId, stateError ? null : taskState === undefined ? task : taskState, onReview);
      React.useEffect(() => {
        const controller = new AbortController();
        const refreshDag = async () => {
          const list = async () => {
            try {
              const data = await fetchJson('marshal/tasks/dag?' + new URLSearchParams({ taskId }), undefined, true, controller.signal);
              if (controller.signal.aborted) return;
              setLayers(data.layers);
              setError('');
              setRefresh(n => n + 1);
            } catch (failure) { if (!controller.signal.aborted) setError(failure.message || String(failure)); }
          };
          const status = async () => {
            try {
              const data = await fetchJson('marshal/tasks/state', undefined, true, controller.signal);
              if (controller.signal.aborted) return;
              setTaskState(data.tasks?.find(row => row.id === taskId) ?? null);
              setStateError('');
            } catch (failure) { if (!controller.signal.aborted) setStateError(failure.message || String(failure)); }
          };
          // SSE coalesces topics, so a room message can replace a pending
          // tasks.changed invalidation. Refresh both projections together.
          await Promise.all([list(), status()]);
        };
        const unsubscribe = subscribeMarshalEvents(['tasks.changed', 'room.message', 'ready'], refreshDag, { initial: true, debounceMs: 80 });
        return () => { controller.abort(); unsubscribe(); };
      }, [taskId, retry]);
      return h(React.Fragment, null,
        !collapsed && h('div', { className: 'mv-dag-body' },
          h(mvDagReviewActions, { review }),
          (error || stateError) && h('div', { role: 'alert' }, [error, stateError].filter(Boolean).join('；'), ' ',
            h(MvButton, { label: '重试', onClick: () => setRetry(n => n + 1) })),
          layers ? h(mvDagCanvas, { layers, onInspect: inspect }) : !error && h('p', { role: 'status' }, '正在读取 DAG…')),
        !collapsed && nodeId !== null && h(mvDagNodeDialog, {
          key: nodeId, taskId, nodeId, onClose: () => inspect(null), review, refresh,
        }));
    }

    // Provide taskId for the ticket projection, or pass members/taskDrawer
    // React nodes for the group chat panes. The host owns where this mounts.
    function mvVerticalDagSidebar({ taskId, task, onReview, members, taskDrawer, defaultCollapsed = false }) {
      const [width, setWidth] = React.useState(mvDagInitialWidth);
      const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
      const [pane, setPane] = React.useState('');
      const drag = React.useRef(null);
      const bodyId = React.useId();
      React.useEffect(ensureMarshalVnextStyles, []);
      const resize = value => {
        const next = mvDagWidth(value);
        setWidth(next);
        try { localStorage.setItem(MV_DAG_WIDTH_KEY, String(next)); } catch {}
      };
      const tabs = [taskId && ['dag', 'DAG 编排'], members != null && ['members', '群聊成员'],
        taskDrawer != null && ['tasks', '任务清单']].filter(Boolean);
      const active = tabs.some(([id]) => id === pane) ? pane : tabs[0]?.[0];
      return h('aside', { className: 'mv-scope mv-dag-sidebar', 'aria-label': '编排与群聊详情',
        'data-collapsed': collapsed, style: collapsed ? undefined : { width } },
        !collapsed && h('div', { className: 'mv-dag-resize', role: 'separator', tabIndex: 0, 'aria-label': '调整右栏宽度',
          'aria-orientation': 'vertical', 'aria-valuemin': MV_DAG_MIN, 'aria-valuemax': MV_DAG_MAX,
          'aria-valuenow': width, 'aria-controls': bodyId,
          onPointerDown: e => {
            if (e.button !== 0 || drag.current) return;
            drag.current = { id: e.pointerId, width, x: e.clientX };
            e.currentTarget.setPointerCapture(e.pointerId);
          },
          onPointerMove: e => {
            if (drag.current?.id === e.pointerId) resize(drag.current.width + drag.current.x - e.clientX);
          },
          onLostPointerCapture: e => { if (drag.current?.id === e.pointerId) drag.current = null; },
          onKeyDown: e => {
            const desired = { ArrowLeft: width + 16, ArrowRight: width - 16, Home: MV_DAG_MIN, End: MV_DAG_MAX }[e.key];
            if (Number.isFinite(desired)) { e.preventDefault(); resize(desired); }
          },
        }),
        h('header', { className: 'mv-dag-header' },
          !collapsed && h('strong', null, tabs.find(([id]) => id === active)?.[1] ?? '群聊详情'),
          h(MvButton, { icon: collapsed ? 'back' : 'chevron', label: collapsed ? '展开右栏' : '收起右栏',
            iconOnly: true, 'aria-expanded': !collapsed, 'aria-controls': bodyId,
            onClick: () => { drag.current = null; setCollapsed(value => !value); } })),
        h('div', { id: bodyId, className: 'mv-dag-content', hidden: collapsed },
          tabs.length > 1 && h('nav', { className: 'mv-dag-actions', 'aria-label': '右栏内容' }, tabs.map(([id, label]) =>
            h(MvButton, { key: id, label, 'aria-pressed': id === active, onClick: () => setPane(id) }))),
          taskId && h(mvDagTaskBody, { key: taskId, taskId,
            task, onReview, collapsed: collapsed || active !== 'dag' }),
          !collapsed && active === 'members' && h('div', { className: 'mv-dag-body' }, members),
          !collapsed && active === 'tasks' && h('div', { className: 'mv-dag-body' }, taskDrawer)));
    }

    // Public names for sibling shards sharing the client factory.
    const mvDagSidebar = { MarshalVerticalDagSidebar: mvVerticalDagSidebar, MarshalDagNodeModal: mvDagNodeModal };
