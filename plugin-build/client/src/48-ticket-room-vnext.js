    const MV_ROOM_API = 'marshal/task-rooms/';

    function mvRoomMerge(previous, data, older) {
      const records = new Map((previous?.records ?? []).map(row => [row.seq, row]));
      for (const row of data.records ?? []) if (!older || !records.has(row.seq)) records.set(row.seq, row);
      return { ...(older ? previous : data), hasOlder: older || !previous ? data.hasOlder : previous.hasOlder,
        records: [...records.values()].sort((a, b) => a.seq - b.seq) };
    }

    function mvRoomHandoffText(...values) {
      return values.find(value => typeof value === 'string' && value.trim())?.trim();
    }

    function mvRoomPatchSummary(artifact) {
      if (!artifact) return;
      const digest = mvRoomHandoffText(artifact.digest);
      const files = artifact.fileCount ?? (Array.isArray(artifact.files) ? artifact.files.length : artifact.files);
      const parts = [];
      if (digest) parts.push(digest.slice(0, 12));
      if (Number.isInteger(files)) parts.push(`${files} 个文件`);
      if (Number.isInteger(artifact.additions)) parts.push(`+${artifact.additions}`);
      if (Number.isInteger(artifact.deletions)) parts.push(`-${artifact.deletions}`);
      if (parts.length) return '补丁 ' + parts.join(' · ');
    }

    function mvRoomIsPatch(record) {
      return record.phase === 'development-patch' || record.kind === 'development-patch';
    }

    function mvRoomParsePatchArtifact(record) {
      const text = record.body ?? record.text ?? '';
      const marker = /^<!--marshal-patch-artifact:([\s\S]*?)-->/.exec(text);
      if (marker) {
        try { return { meta: JSON.parse(marker[1]), body: text.slice(marker[0].length).replace(/^\r?\n/, '') }; }
        catch {}
      }
      return { meta: null, body: text };
    }

    async function mvRoomFetchFullPatch({ roomId, taskId, nodeId, digest, seq, preview, stored, bytes, signal }) {
      const qs = new URLSearchParams({ roomId });
      if (digest) qs.set('digest', digest);
      if (seq != null) qs.set('seq', seq);
      const complete = text => {
        if (typeof text !== 'string' || !text) return false;
        if (text.startsWith('<!--marshal-patch-artifact:') || text.includes('点击「下载 .patch」或「应用补丁」可获取完整补丁')) return false;
        if (Number.isSafeInteger(bytes) && bytes > 0 && new TextEncoder().encode(text).length < bytes) return false;
        if (stored && preview && !(Number.isSafeInteger(bytes) && bytes > 0) && text === preview) return false;
        return true;
      };
      try {
        const result = await fetchJson(MV_ROOM_API + 'patch?' + qs, undefined, true, signal);
        if ((seq != null && result?.seq != null && result.seq !== seq) ||
            (digest && result?.digest && result.digest !== digest)) {
          throw new Error('服务端返回的补丁与请求记录不一致');
        }
        const text = typeof result === 'string' ? result : result?.patch;
        if (!complete(text)) throw new Error('服务端未返回完整补丁内容');
        return text;
      } catch (e) {
        if (signal.aborted || !taskId) throw e;
        // The room patch endpoint only searches its latest page. DAG detail resolves the exact record.
        let targetNodeId = nodeId;
        if (!targetNodeId) {
          const dag = await fetchJson('marshal/tasks/dag?' + new URLSearchParams({ taskId }), undefined, true, signal);
          const nodes = (dag?.layers ?? []).flatMap(layer => layer.nodes ?? []);
          const matched = (digest && nodes.find(item => item.patchDigest === digest))
            || nodes.findLast(item => item.phase === 'development-patch' || item.id?.startsWith('development-patch:') || item.id?.startsWith('patch:'));
          targetNodeId = matched?.id;
          if (!targetNodeId) throw e;
        }
        const { node } = await fetchJson('marshal/tasks/dag/node?' + new URLSearchParams({ taskId, nodeId: targetNodeId }),
          undefined, true, signal);
        if (node?.id !== targetNodeId || (digest && node.patchDigest && node.patchDigest !== digest) || !complete(node.diff)) throw e;
        return node.diff;
      }
    }

    function mvRoomDownloadPatch(text, { digest, seq }) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      try {
        const link = document.createElement('a');
        link.hidden = true;
        link.href = url;
        link.download = `development-${digest?.slice(0, 12) || (seq ?? 'latest')}.patch`;
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }

    function mvRoomReadPatch(record, artifact, digest) {
      const summary = mvRoomPatchSummary(artifact.meta);
      if (summary) return summary;
      const files = new Set();
      let additions = 0, deletions = 0, inHunk = false;
      for (const line of artifact.body.split('\n')) {
        if (line.startsWith('diff --git ')) {
          files.add(line.slice('diff --git '.length));
          inHunk = false;
        } else if (line.startsWith('@@ ')) inHunk = true;
        else if (inHunk && line.startsWith('+')) additions++;
        else if (inHunk && line.startsWith('-')) deletions++;
      }
      if (files.size) return mvRoomPatchSummary({ fileCount: files.size, additions, deletions, digest: record.patchDigest || digest });
    }

    function mvRoomHandoffMeta(record, text) {
      const parse = value => {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return null; }
      };
      let data = parse(record.meta) ?? parse(record.body ?? text);
      for (let depth = 0; data && depth < 2; depth++) {
        const wrapped = parse(data.meta ?? data.body);
        if (!wrapped || typeof wrapped !== 'object') break;
        data = wrapped;
      }
      return data;
    }

    function mvRoomHandoff(record, participants, text, workflow, patchSummary, { runAssignment, isCurrentRun }) {
      const phase = record.phase || record.kind;
      const meta = mvRoomHandoffMeta(record, text);
      const direction = /→|->|(?:移交|转交|交接|分配)\s*(?:给|至)|退回(?:给|至)?|交给|hand(?:ed)?\s*off\s+to\b/i.exec(text);
      const structuredTarget = mvRoomHandoffText(record.targetName, record.target, record.assignee, record.to,
        meta?.targetName, meta?.target, meta?.assignee, meta?.to)?.replace(/^@\s*/, '');
      const assignment = record.kind === 'assignment' || phase === 'assignment';
      const transfer = direction && !['→', '->'].includes(direction[0]);
      const explicit = record.kind === 'handoff' || phase === 'handoff' || assignment;
      const designHandoff = phase === 'designing' && /^开发设计交接已写入工作区公共记忆[。.]?$/.test(text.trim());
      const reviewHandoff = phase === 'dev-reviewing' && /^编码交付与审查交接已写入工作区公共记忆[。.]?$/.test(text.trim());
      if (!explicit && !['agent', 'status'].includes(record.kind)) return null;

      const labels = new Map(isCurrentRun ? [
        ['leader', workflow?.leaderName || 'Leader'], ['coder', 'Coder'], ['reviewer', 'Reviewer'],
      ] : []);
      for (const member of isCurrentRun ? participants : []) {
        if (!member.name) continue;
        labels.set(member.name.toLowerCase(), member.name);
        for (const role of member.roles ?? member.role?.split('/') ?? []) labels.set(role.toLowerCase(), member.name);
      }
      for (const [role, name] of Object.entries({ ...runAssignment?.roles,
        ...(runAssignment?.leaderName ? { Leader: runAssignment.leaderName } : {}) })) {
        if (!mvRoomHandoffText(name)) continue;
        labels.set(role.toLowerCase(), name);
        labels.set(name.toLowerCase(), name);
      }
      const matchMember = (segment, end) => {
        const name = segment.trimStart().replace(/^@\s*/, '').toLowerCase();
        const label = [...labels.keys()].sort((a, b) => b.length - a.length)
          .find(key => name.startsWith(key) && end.test(name.slice(key.length)));
        return labels.get(label);
      };
      const destination = direction && text.slice(direction.index + direction[0].length).replace(/^[\s:：]+/, '');
      const mentioned = /^@\s*([^\s，。；、,.!?！？;:：/]+)/.exec((destination || (explicit && !direction ? text.trimStart() : '')))?.[1];
      const codingRecipient = /^编码交给[ \t]+([^@\r\n，。；、,.!?！？;:：/]+?)[ \t]+的常驻会话[。.]?$/.exec(text.trim())?.[1]?.trim();
      const target = structuredTarget
        ? labels.get(structuredTarget.toLowerCase()) || structuredTarget
        : (destination && matchMember(destination, /^(?:$|[，。；、,.!?！？;:：/]|[ \t]+(?:的|常驻|[·（(]|$))/))
          || (codingRecipient && (labels.get(codingRecipient.toLowerCase()) || codingRecipient))
          || (mentioned && (labels.get(mentioned.toLowerCase()) || mentioned));
      const source = direction && matchMember(text.slice(0, direction.index).trim().replace(/^由\s*/, ''), /^(?:$|\s|[，,：:]|要求|决定)/);
      // An arrow alone can be part of an ordinary agent reply (e.g. a code snippet).
      if (!explicit && !structuredTarget && !designHandoff && !reviewHandoff &&
          !(transfer ? target || source : source && target)) return null;
      const roles = assignment ? Object.values(meta?.roles ?? {}).filter(name => typeof name === 'string' && name.trim()) : [];
      let sourceRole, targetRole;
      if ((runAssignment || (isCurrentRun && (workflow || participants.length))) && !direction && !structuredTarget) {
        if (designHandoff || (explicit && phase === 'designing')) {
          sourceRole = 'leader'; targetRole = 'coder';
        } else if (reviewHandoff || (explicit && phase === 'dev-reviewing')) {
          sourceRole = 'coder'; targetRole = 'reviewer';
        }
      }
      const recipient = target || labels.get(targetRole);
      const projectedPhase = phase === 'coding' && /返工|退回 Coder/.test(text) ? 'revise' : phase;
      return { targets: [...new Set(recipient ? [recipient] : roles)], phase,
        source: mvRoomHandoffText(record.sourceName, record.from, meta?.sourceName, meta?.from, source, labels.get(sourceRole), record.actor) || 'Marshal',
        // A room ref can point to shared memory rather than a patch or artifact.
        summary: mvRoomHandoffText(record.artifactSummary, meta?.artifactSummary, record.patchDigest, meta?.patchDigest,
          phase === 'dev-reviewing' && patchSummary, record.patchSummary, meta?.patchSummary, meta?.template, meta?.group),
        nodeId: record.nodeId || meta?.nodeId || `${projectedPhase}:${record.id ?? record.seq}` };
    }

    function MarshalTicketRoomView({ task, openBoard, onOpenAgents }) {
      const bound = task?.taskRoom;
      const [workspace, setWorkspace] = React.useState(bound?.workspaceId || task?.workflow?.workspaceId || task?.workspaceId || '');
      const [workspaces, setWorkspaces] = React.useState([]);
      const [rooms, setRooms] = React.useState([]);
      const [roomId, setRoomId] = React.useState(bound?.id || '');
      const [error, setError] = React.useState('');
      const [opening, setOpening] = React.useState(false);
      const listRefresh = React.useRef(null);
      const life = React.useRef(null);
      React.useEffect(() => {
        ensureTaskRoomStyles();
        return ensureMarshalVnextStyles();
      }, []);
      React.useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        const { signal } = controller;
        void fetchJson(MV_ROOM_API + 'workspaces', undefined, true, signal).then(data => {
          if (signal.aborted) return;
          const available = (data.workspaces ?? []).filter(ws => !isPseudoAgentWorkspace(ws) || ws.id === bound?.workspaceId);
          setWorkspaces(available);
          setWorkspace(current => current || (available.length === 1 ? available[0].id : ''));
        }).catch(e => { if (!signal.aborted) setError(e.message); });
        return () => controller.abort();
      }, []);
      React.useEffect(() => {
        if (!workspace) return;
        const refresh = createVisibleMarshalRefresh(async signal => {
          try {
            const data = await fetchJson(MV_ROOM_API + 'list?' + new URLSearchParams({ workspaceId: workspace }), undefined, true, signal);
            if (signal.aborted) return;
            setRooms(data.rooms ?? []);
            if (!task) setRoomId(current => current || data.rooms?.[0]?.id || '');
          } catch (e) { if (!signal.aborted) setError(e.message); }
        });
        listRefresh.current = refresh;
        const unsubscribe = subscribeMarshalEvents(['ready', 'tasks.changed', 'room.message'], refresh.request, { initial: true, debounceMs: 80 });
        return () => { listRefresh.current = null; unsubscribe(); refresh.dispose(); };
      }, [workspace]);
      const open = async () => {
        const signal = life.current.signal;
        setOpening(true);
        setError('');
        try {
          const data = await fetchJson(MV_ROOM_API + 'open', { taskId: task.id, workspaceId: workspace }, true, signal);
          if (!signal.aborted) { setRoomId(data.room.id); void listRefresh.current?.request(); }
        } catch (e) { if (!signal.aborted) setError(e.message); }
        finally { if (!signal.aborted) setOpening(false); }
      };
      return h('section', { className: 'mv-scope mv-room-fill', 'aria-label': '工单群', style: { flexDirection: 'column' } },
        (!task || !roomId || error) && h('div', { className: 'mv-dag-header mv-actions' },
          !roomId && h(MvButton, { label: '返回工作台', icon: 'back', onClick: () => openBoard?.(task?.id) }),
          (!task || !workspace) && h('select', { className: 'mv-field mv-compact-field', 'aria-label': '工作区', value: workspace, disabled: opening,
            onChange: e => { setWorkspace(e.target.value); setRoomId(''); setRooms([]); setError(''); } },
            h('option', { value: '' }, '选择工作区'), workspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.name || ws.title || ws.id))),
          !task && workspace && h('select', { className: 'mv-field mv-compact-field', 'aria-label': '工单群记录', value: roomId,
            onChange: e => setRoomId(e.target.value) }, h('option', { value: '' }, '选择工单群'),
            rooms.map(room => h('option', { key: room.id, value: room.id }, room.title))),
          error && h('span', { role: 'alert', className: 'mv-danger' }, error)),
        roomId && workspace ? h(mvTicketConversation, { key: 'taskRooms-' + workspace + '/' + roomId, workspace, roomId, task, openBoard, onOpenAgents })
          : h(EmptyState, { title: task?.title || '选择一个工单群', hint: task ? '开启工单群后即可参与协作。' : '从工作区查看工单群记录。',
            action: task && workspace && !opening ? '开启此工单群聊' : undefined, onAction: open }));
    }

    function mvTicketConversation({ workspace, roomId, task, openBoard, onOpenAgents }) {
      const [visible, setVisible] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [context, setContext] = React.useState({});
      const [library, setLibrary] = React.useState(null);
      const [leaders, setLeaders] = React.useState([]);
      const [assignee, setAssignee] = React.useState('');
      const [peers, setPeers] = React.useState([]);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [pending, setPending] = React.useState('');
      const [paging, setPaging] = React.useState(false);
      const [dagOpen, setDagOpen] = React.useState(false);
      const [nodeId, setNodeId] = React.useState('');
      const [locating, setLocating] = React.useState(false);
      const [catalogModels, setCatalogModels] = React.useState([]);
      const [fullPatch, setFullPatch] = React.useState(null);
      const patchRequest = React.useRef(null);
      const patchResult = React.useRef(null);
      const cursor = React.useRef(null);
      const refreshRef = React.useRef(null);
      const lifetime = React.useRef(null);
      const flight = React.useRef('');
      const stream = React.useRef(null);
      const stick = React.useRef(true);
      const prepend = React.useRef(null);
      const input = React.useRef(null);
      const url = MV_ROOM_API + 'page?' + new URLSearchParams({ roomId, workspaceId: workspace });
      const room = visible?.room;
      const taskId = visible?.taskId || room?.taskId || task?.id;
      const workflow = visible?.workflow ?? task?.workflow;
      const projectedTask = { ...task, id: taskId, title: room?.title || task?.title,
        workflow, status: visible?.cardStatus ?? task?.status, taskRoom: room };
      const participants = visible?.participants ?? [];
      const reviewing = visible?.origin && !room?.closed && (visible.cardStatus === 'review' || visible.runState === 'review-blocked');
      const runningRevision = visible?.origin && !room?.closed && (visible.busy || visible.cardStatus === 'running');
      const actionPending = Boolean(pending || visible?.chatBusy);
      const locked = actionPending || Boolean(visible?.busy);
      React.useEffect(() => () => patchRequest.current?.abort(), [url, room?.id]);
      React.useEffect(() => {
        if (fullPatch?.focusResult && !fullPatch.loading) patchResult.current?.focus();
      }, [fullPatch]);
      React.useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        const refresh = createVisibleMarshalRefresh(async signal => {
          try {
            while (!signal.aborted) {
              const after = cursor.current;
              const page = await fetchJson(url + (after === null ? '' : '&after=' + after), undefined, true, signal);
              if (signal.aborted) return;
              const next = page.records?.at(-1)?.seq ?? after ?? 0;
              setVisible(previous => mvRoomMerge(previous, page, false));
              cursor.current = Math.max(after ?? 0, next);
              if (!page.hasNewer || next <= (after ?? 0)) break;
            }
          } catch (e) {
            if (signal.aborted) return;
            if (['forbidden', 'workspace-forbidden', 'unauthorized', 'task-room-not-found'].includes(e.code)) {
              cursor.current = null; setVisible(null);
            }
            setError(e.message);
          }
        }, 12_000);
        refreshRef.current = refresh;
        const unsubscribe = subscribeMarshalEvents(['ready', 'tasks.changed', 'room.message'], refresh.request, { initial: true, debounceMs: 80 });
        void fetchJson('api/task-board/model-catalog', undefined, false, controller.signal)
          .then(data => { if (!controller.signal.aborted) setCatalogModels(flattenModelCatalog(data).options); }).catch(() => {});
        void loadAgentLibrary().then(data => { if (!controller.signal.aborted) setLibrary(data); }).catch(() => {});
        void fetchJson('marshal/tasks/orchestration', undefined, true, controller.signal)
          .then(data => { if (!controller.signal.aborted) setLeaders(data.leaders ?? []); }).catch(() => {});
        return () => { controller.abort(); refreshRef.current = null; unsubscribe(); refresh.dispose(); };
      }, [url]);
      React.useEffect(() => {
        if (!visible?.origin) return;
        const controller = new AbortController();
        void fetchJson(MV_ROOM_API + 'peers?' + new URLSearchParams({ roomId }), undefined, true, controller.signal)
          .then(data => { if (!controller.signal.aborted) setPeers(data.peers ?? []); }).catch(() => {});
        return () => controller.abort();
      }, [roomId, visible?.origin]);
      React.useEffect(() => {
        refreshRef.current?.setPolling(Boolean(room && !room.closed), visible?.busy || visible?.chatBusy ? 5_000 : 12_000);
      }, [room?.id, room?.closed, visible?.busy, visible?.chatBusy]);
      React.useEffect(() => {
        const el = stream.current;
        if (!el) return;
        if (prepend.current) {
          const anchor = prepend.current;
          prepend.current = null;
          el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
        } else if (stick.current) el.scrollTop = el.scrollHeight;
      }, [visible]);
      const older = async () => {
        if (!visible?.records[0] || paging) return;
        const signal = lifetime.current.signal;
        setPaging(true);
        try {
          const page = await fetchJson(url + '&before=' + visible.records[0].seq, undefined, true, signal);
          if (signal.aborted) return;
          if (stream.current) prepend.current = { top: stream.current.scrollTop, height: stream.current.scrollHeight };
          stick.current = false;
          setVisible(previous => previous && mvRoomMerge(previous, page, true));
        } catch (e) { if (!signal.aborted) setError(e.message); }
        finally { if (!signal.aborted) setPaging(false); }
      };
      const act = async (action, fields = {}) => {
        if (!room || !visible.origin || flight.current || actionPending ||
            (action !== 'send' && action !== 'revise' && locked)) return false;
        const signal = lifetime.current.signal;
        flight.current = action;
        setPending(action);
        setError('');
        setNotice('');
        try {
          if (action === 'send' && context.attachments?.length) {
            const attachments = new Map([...(visible.attachments ?? []), ...context.attachments].map(item => [item.attachmentId, item]));
            mvValidatePickerAttachmentBudget([...attachments.values()]);
            await fetchJson('marshal/tasks/update', { taskId, attachments: [...attachments.values()].map(serializeAttachmentForWire) }, true, signal);
          }
          await fetchJson(MV_ROOM_API + 'action', { roomId: room.id, action, ...fields }, true, signal);
          if (signal.aborted) return false;
          if (['send', 'confirm', 'revise'].includes(action)) setDraft(current => current === draft ? '' : current);
          if (action === 'send') { setContext(current => current === context ? {} : current); stick.current = true; }
          if (action === 'confirm' || action === 'revise') setNotice(action === 'confirm' ? '已确认验收。' : '已提交返工。');
          await refreshRef.current?.request();
          return true;
        } catch (e) { if (!signal.aborted) setError(e.message); return false; }
        finally { flight.current = ''; if (!signal.aborted) setPending(''); }
      };
      const review = (action, applyPatch = false) => action === 'confirm'
        ? act('confirm', { applyPatch, ...(draft.trim() ? { note: draft.trim() } : {}) })
        : act('revise', draft.trim() ? { text: draft.trim() } : {});
      const onReview = action => review(action);
      const send = () => {
        const links = mvChatLinks(context);
        const text = draft.trim();
        if (text && !visible?.chatBusy) return act('send', { text, ...(room?.closed ? { autoReopen: true } : {}), ...(links ? { links } : {}) });
      };
      const locate = async (record, fallback) => {
        const signal = lifetime.current.signal;
        setLocating(true);
        setError('');
        try {
          const dag = await fetchJson('marshal/tasks/dag?' + new URLSearchParams({ taskId }), undefined, true, signal);
          if (signal.aborted) return;
          // Projection may coalesce several room records into the same node.
          const nodes = (dag.layers ?? []).flatMap(layer => layer.nodes ?? []);
          const node = nodes.find(node => node.logs?.some(log => log.seq === record.seq || (record.id && log.id === record.id)));
          setNodeId(node?.id || fallback);
        } catch (e) {
          if (!signal.aborted) setError('无法定位 DAG 节点：' + e.message);
        } finally { if (!signal.aborted) setLocating(false); }
      };
      const assignees = [
        ...leaders.filter(p => p.global || p.workspaceId === workspace).map(p => ({ id: 'local/' + p.id, name: p.name, fields: { leaderId: p.id } })),
        ...peers.flatMap(peer => (peer.models ?? []).map(model => ({ id: 'remote/' + peer.id + '/' + model.id,
          name: peer.name + ' · ' + (model.model || model.id), fields: { remote: { deviceId: peer.id, modelId: model.id } } }))),
      ];
      const assigneeFields = assignees.find(row => row.id === assignee)?.fields;
      const models = mvChatModels([...(library?.models ?? []), ...catalogModels]);
      const agents = participants.filter(p => mvAgentConfigSlot(p, workflow)).map(p => {
        const slot = mvAgentConfigSlot(p, workflow);
        const member = library?.agents.find(a => a.id === p.agentId);
        const config = workflow?.plan?.agentConfigs?.[slot] || workflow?.agentConfigs?.[slot] || member || p;
        return { ...p, model: config.model, reasoningEffort: config.reasoningEffort, configKey: slot,
          models: p.models ?? mvChatModelsWithCurrent(models, config.model) };
      });
      const records = visible?.records;
      const [inlineDigests, setInlineDigests] = React.useState(() => new Map());
      React.useEffect(() => {
        if (!globalThis.crypto?.subtle || !records) return;
        const inline = records.filter(record => mvRoomIsPatch(record) && !record.patchDigest &&
          record.text?.startsWith('diff --git ') && !inlineDigests.has(record.text));
        if (!inline.length) return;
        let active = true;
        void Promise.all(inline.map(async record => {
          const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.text));
          return [record.text, Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')];
        })).then(entries => {
          if (active) setInlineDigests(current => new Map([...current, ...entries]));
        }).catch(() => {}); // The file and line counts remain available without SHA-256.
        return () => { active = false; };
      }, [records]);
      let runId, runAssignment = null, priorPatchSummary, sawPatch = false;
      const lastPatch = records?.findLast(mvRoomIsPatch);
      const rows = (records ?? []).map(record => {
        if (record.kind === 'batch' || (record.runId && record.runId !== runId)) {
          runId = record.runId;
          runAssignment = null;
          priorPatchSummary = undefined;
          sawPatch = false;
        }
        const decoded = decodeAgentTraceClient(record.text ?? record.body ?? '');
        if (record.kind === 'assignment' || record.phase === 'assignment') {
          const meta = mvRoomHandoffMeta(record, decoded.text);
          runAssignment = meta ? { leaderName: meta.leader || meta.leaderName, roles: meta.roles } : null;
        }
        const isCurrentRun = !record.runId || !workflow?.runId || record.runId === workflow.runId;
        const artifact = mvRoomIsPatch(record) ? mvRoomParsePatchArtifact(record) : null;
        if (artifact) {
          sawPatch = true;
          priorPatchSummary = mvRoomReadPatch(record, artifact, inlineDigests.get(record.text));
        }
        // The workflow describes the latest deliverable, not a past batch or iteration.
        const patchSummary = sawPatch ? priorPatchSummary :
          runId && runId === workflow?.runId && (!lastPatch || lastPatch.seq < record.seq) ? mvRoomPatchSummary(workflow.development) : undefined;
        return { record, ...decoded, patchSummary, runAssignment, isCurrentRun, artifact };
      });
      const patchTarget = ({ record, artifact }) => ({
        digest: artifact?.meta?.digest || record.patchDigest, seq: record.seq, preview: artifact?.body,
        nodeId: `development-patch:${record.id ?? record.seq}`,
        stored: Boolean(artifact?.meta?.stored), bytes: artifact?.meta?.bytes,
      });
      const headerPatchRow = visible?.patchAvailable
        ? rows.findLast(row => row.artifact && row.isCurrentRun)
        : rows.findLast(row => row.artifact?.meta?.stored);
      const headerPatch = room?.id && (headerPatchRow || visible?.patchAvailable) &&
        (headerPatchRow ? patchTarget(headerPatchRow) : {
          digest: workflow?.development?.digest,
          bytes: workflow?.development?.bytes,
          stored: true,
        });
      const patchKey = ({ digest, seq }) => JSON.stringify([room.id, digest, seq]);
      const loadPatch = async (target, download, focusResult) => {
        const key = patchKey(target);
        const previous = fullPatch?.key === key ? fullPatch : null;
        if (!download && previous?.text) {
          setFullPatch({ ...previous, open: !previous.open, error: '', focusResult: focusResult && !previous.open });
          return;
        }
        patchRequest.current?.abort();
        const controller = new AbortController();
        patchRequest.current = controller;
        const { signal } = controller;
        setFullPatch({ ...previous, key, loading: true, error: '' });
        let text, patchError = '';
        try {
          text = await mvRoomFetchFullPatch({ roomId: room.id, taskId, ...target, signal });
        } catch (e) {
          if (signal.aborted) return;
          patchError = `完整补丁读取失败：${e.message}${download && target.preview ? '（将下载预览）' : ''}`;
        }
        if (signal.aborted) return;
        if (download && (text || target.preview)) {
          try { mvRoomDownloadPatch(text || target.preview, target); }
          catch (e) { patchError = [patchError, `补丁下载失败：${e.message}`].filter(Boolean).join('；'); }
        }
        setFullPatch({ key, loading: false, error: patchError, text: text ?? previous?.text,
          open: download ? previous?.open : Boolean(text), focusResult: focusResult && (!download || Boolean(patchError)) });
      };
      const patchControls = (target, focusResult = false) => {
        const state = fullPatch?.key === patchKey(target) ? fullPatch : null;
        return h('div', { className: 'mv-actions' },
          h(MvButton, { label: state?.open ? '收起完整补丁' : '查看完整补丁',
            'aria-expanded': Boolean(state?.open), disabled: Boolean(state?.loading), onClick: () => loadPatch(target, false, focusResult) }),
          h(MvButton, { label: '下载完整 .patch', disabled: Boolean(state?.loading), onClick: () => loadPatch(target, true, focusResult) }));
      };
      const patchContents = target => fullPatch?.key === patchKey(target) && [
        fullPatch.error && h('div', { key: 'error', ref: patchResult, tabIndex: -1, role: 'alert', className: 'mv-danger' }, fullPatch.error),
        fullPatch.open && h('pre', { key: 'diff', ref: fullPatch.error ? undefined : patchResult, className: 'mv-dag-diff', tabIndex: 0 }, fullPatch.text),
      ];
      const usage = new Map();
      const add = (actor, u) => usage.set(actor, (usage.get(actor) || 0) + (Number(u?.totalTokens) || (Number(u?.inputTokens || 0) + Number(u?.outputTokens || 0))));
      rows.forEach(({ record, trace }) => { if (trace?.usage) add(record.actor, trace.usage); });
      (visible?.liveBubbles ?? []).forEach(live => { if (live.usage) add(live.actor, live.usage); });
      const ticketNo = room?.ticketNo || task?.ticketNo;
      const heading = projectedTask.title || '工单群';
      const total = [...usage.values()].reduce((a, b) => a + b, 0);
      const renderRow = ({ record, text, trace, patchSummary, runAssignment, isCurrentRun, artifact }) => {
        const handoff = mvRoomHandoff(record, participants, text, workflow, patchSummary, { runAssignment, isCurrentRun });
        const banner = handoff && h('div', { 'data-record-seq': record.seq, className: 'mv-task-item mv-guidance-action', 'aria-label': '阶段交接' },
          h('div', { className: 'mv-actions' }, h('strong', null, handoff.source), ' → ',
            handoff.targets.length ? handoff.targets.map(target => h('span', { key: target, className: 'mv-capsule' }, '@' + target)) : '待分配',
            ' · ' + (taskPhases[handoff.phase] || (handoff.phase === 'assignment' ? '编排分工' : '阶段交接')),
            taskId && h(MvButton, { label: '定位 DAG 节点', disabled: locating, onClick: () => locate(record, handoff.nodeId) })),
          handoff.summary && h(RichMarkdown, { text: handoff.summary }));
        const target = artifact && room?.id && patchTarget({ record, artifact });
        return h(mvChatMessage, { key: record.seq, mine: record.kind === 'user', name: record.actor, text: artifact?.body ?? text,
          at: record.at, phase: record.phase, trace }, banner, target && patchControls(target), target && patchContents(target));
      };
      return h('div', { className: 'mv-room-fill' },
        h('main', { className: 'mv-room', style: { overflow: 'visible' } },
          h('header', { className: 'mv-dag-header mv-actions' },
            h(MvButton, { label: '返回工作台', icon: 'back', onClick: () => openBoard?.(taskId) }),
            h('strong', { className: 'mv-copy mv-truncate', title: projectedTask.title }, ticketNo && !heading.startsWith('[' + ticketNo + ']') && !heading.startsWith(ticketNo) ? ticketNo + ' · ' + heading : heading),
            h('span', { className: 'mv-capsule' }, room?.closed ? '已归档' : taskPhases[workflow?.phase] || (reviewing ? '待验收' : visible?.busy ? '执行中' : room ? '讨论中' : '读取中')),
            h('span', { className: 'mv-actions', 'aria-label': '智能体头像' }, participants.slice(0, 5).map(p => h('span', { key: p.id, title: p.name }, h(MvAvatar, { agent: p })))),
            total > 0 && h('span', { className: 'mv-capsule mv-time' }, h(MvIcon, { name: 'dot' }), '累计 ' + formatTokenCount(total) + ' tok'),
            headerPatch && patchControls(headerPatch, true),
            h(MvButton, { label: '刷新', icon: 'refresh', iconOnly: true, onClick: () => refreshRef.current?.request() }),
            taskId && h(MvButton, { label: 'DAG 编排', 'aria-pressed': dagOpen, onClick: () => setDagOpen(v => !v) })),
          error && h('div', { role: 'alert', className: 'mv-danger' }, error),
          notice && h('div', { role: 'status' }, notice),
          headerPatch && !headerPatchRow && patchContents(headerPatch),
          h('section', { ref: stream, className: 'mv-room-log', 'aria-label': '群聊记录', onScroll: e => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          } }, visible?.hasOlder && h(MvButton, { label: '加载更早消息', disabled: paging, onClick: older }),
          !rows.length && !(visible?.liveBubbles?.length) && h('p', { className: 'mv-muted' }, room ? '还没有消息。' : '正在读取工单群…'),
          rows.map(renderRow), visible && (visible.liveBubbles ?? []).map(live => h(mvChatMessage, { key: 'live-' + live.id,
            name: live.actor, phase: live.phase, text: live.text, trace: live, live: true })),
          workflow?.reportId && taskId && h(TaskReviewReport, { key: workflow.reportId, taskId, development: Boolean(workflow.development) })),
          visible?.origin && room && h('footer', { className: 'mv-composer-dock' },
            h(mvChatMentions, { members: participants, usage, all: true, input, setText: setDraft }),
            visible.attachments?.length > 0 && h('div', { className: 'mv-muted', 'aria-label': '工单附件' },
              '工单附件：' + visible.attachments.map(item => item.name).join('、')),
            h('textarea', { ref: input, rows: 2, className: 'mv-field', value: draft, 'aria-label': '工单群消息', placeholder: '输入消息或 @成员', onChange: e => setDraft(e.target.value) }),
            h('div', { className: 'mv-actions' },
              h(mvCascadePicker.MarshalAgentModelCascade, { agents, task: projectedTask, onSaved: () => { setNotice('模型与思考配置已更新。'); return refreshRef.current?.request(); } }),
              h(mvCascadePicker.MarshalCascadeContextPicker, { value: context, onChange: setContext }),
              !participants.length && onOpenAgents && h(MvButton, { label: '打开智能体', onClick: onOpenAgents }),
              h(MvButton, { icon: 'send', label: pending === 'send' ? '发送中…' : '发送', disabled: !draft.trim() || Boolean(pending) || visible.chatBusy, onClick: send })),
            h('div', { className: 'mv-actions' },
              reviewing && h(MvButton, { label: '确认验收', disabled: locked, onClick: () => review('confirm') }),
              reviewing && visible.patchAvailable && h(MvButton, { label: '应用补丁并验收', disabled: locked, onClick: () => review('confirm', true) }),
              (reviewing || runningRevision) && h(MvButton, { label: reviewing ? '返工' : '按意见返工',
                disabled: actionPending || (!reviewing && !draft.trim()), onClick: () => {
                  if (reviewing || draft.trim()) return review('revise');
                } }),
              h(MvButton, { label: room.closed ? '重开工单' : '关闭工单', disabled: locked, onClick: () => act(room.closed ? 'reopen' : 'close') }),
              !room.closed && h(MvButton, { label: '重试', disabled: locked, onClick: () => act('retry') }),
              !room.closed && h('select', { className: 'mv-field mv-compact-field', 'aria-label': '改派负责人', value: assignee, disabled: locked, onChange: e => setAssignee(e.target.value) },
                h('option', { value: '' }, '选择负责人'), assignees.map(p => h('option', { key: p.id, value: p.id }, p.name))),
              !room.closed && h(MvButton, { label: '改派并运行', disabled: locked || !assigneeFields, onClick: () => act('reassign', assigneeFields) })))),
        dagOpen && taskId && h(mvDagSidebar.MarshalVerticalDagSidebar, { taskId, task: projectedTask, onReview }),
        nodeId && taskId && h(mvDagSidebar.MarshalDagNodeModal, { taskId, task: projectedTask, nodeId, onReview, onClose: () => setNodeId('') }));
    }
