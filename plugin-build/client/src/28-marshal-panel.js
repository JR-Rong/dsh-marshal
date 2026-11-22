    function MarshalPanel({ marshalContext, openSession, openPanel, mvOpenDirect, workspaceService, SessionProvider, renderSlot }) {
      const [attempt, retry] = React.useState(0);
      const initialNav = React.useMemo(() => {
        if (pendingTab) {
          const resolved = resolveNavTarget(pendingTab);
          pendingTab = null;
          return resolved;
        }
        try {
          const saved = globalThis.localStorage?.getItem(ACTIVE_TAB_STORAGE_KEY);
          if (saved && ['tasks', 'chats', 'agents', 'memory'].includes(saved)) return { tab: saved };
        } catch {}
        return { tab: 'tasks' };
      }, []);
      const [tab, setTab] = React.useState(initialNav.tab);
      const [chatSection, setChatSection] = React.useState(initialNav.chatSection || 'groups');
      const [groupSub, setGroupSub] = React.useState(initialNav.groupSub || 'local');
      const [agentSub, setAgentSub] = React.useState(initialNav.agentSub || 'pool');
      const [memoryTarget, setMemoryTarget] = React.useState({ agentId: '', layer: '' });
      const [roomTask, setRoomTask] = React.useState(null);
      const [focusedTask, focusTask] = React.useState('');
      const [deviceStatus, setDeviceStatus] = React.useState(null);
      const [deviceDrawerOpen, setDeviceDrawerOpen] = React.useState(false);

      const chooseTab = value => {
        pendingTab = null;
        const resolved = resolveNavTarget(value);
        if (resolved.chatSection) setChatSection(resolved.chatSection);
        if (resolved.groupSub) setGroupSub(resolved.groupSub);
        if (resolved.agentSub) setAgentSub(resolved.agentSub);
        if (value === 'taskRooms') setRoomTask(null);
        setTab(resolved.tab);
        try { globalThis.localStorage?.setItem(ACTIVE_TAB_STORAGE_KEY, resolved.tab); } catch {}
      };
      const openTaskRoom = task => { setRoomTask(task); setChatSection('taskRooms'); setTab('chats'); };
      const openBoard = taskId => { focusTask(taskId ?? ''); setTab('tasks'); };
      const openAgentMemory = agentId => { setMemoryTarget({ agentId, layer: 'agent' }); setTab('memory'); };

      React.useEffect(() => {
        const onTab = event => { if (event && typeof event.detail === 'string') chooseTab(event.detail); };
        window.addEventListener('marshal:tab', onTab);
        return () => { window.removeEventListener('marshal:tab', onTab); };
      }, []);

      const refreshDeviceStatus = React.useCallback(() => {
        fetchJson('marshal/devices/status')
          .then(next => setDeviceStatus(next))
          .catch(() => setDeviceStatus(null));
      }, []);

      React.useEffect(() => {
        let alive = true;
        fetchJson('marshal/health')
          .then(next => { if (alive) setHealth(next); })
          .catch(() => { if (alive) setHealth(null); });
        refreshDeviceStatus();
        const timer = setInterval(refreshDeviceStatus, 15000);
        return () => { alive = false; clearInterval(timer); };
      }, [attempt, refreshDeviceStatus]);

      const [address, setAddress] = React.useState(null);
      const [setup, setSetup] = React.useState(null);
      const [state, setState] = React.useState({ authenticated: false });
      const [health, setHealth] = React.useState(null);
      const [binding, setBinding] = React.useState(null);
      const [notice, setNotice] = React.useState('正在连接调度官…');
      const [older, setOlder] = React.useState(null);
      const [historyBusy, setHistoryBusy] = React.useState(false);
      const [catalog, setCatalog] = React.useState(null);
      const [selection, setSelection] = React.useState({});
      const [files, setFiles] = React.useState([]);
      const [controlsNotice, setControlsNotice] = React.useState('');
      const [controlsBusy, setControlsBusy] = React.useState(false);
      const fileInput = React.useRef(null), choices = React.useRef(new Map()), uploads = React.useRef([]);
      const iframe = React.useRef(null), active = React.useRef(null), connection = React.useRef(null);
      const history = React.useRef([]), live = React.useRef([]), pending = React.useRef(new Map());
      const accountMode = React.useRef(false), accountHash = React.useRef(undefined), accountBusy = React.useRef(null);
      const disposeSession = () => {
        active.current?.dispose(); active.current = null; history.current = []; live.current = [];
        setBinding(null); setOlder(null); setCatalog(null); setFiles([]); uploads.current = []; setControlsNotice(''); setControlsBusy(false);
      };
      const invoke = (op, args, target = active.current?.target) => new Promise((resolve, reject) => {
        if (!connection.current || (!target && !op.startsWith('account.'))) { reject(Error('连接已断开')); return; }
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.current.delete(id); reject(Error('等待超时；请核对状态，不会自动重发')); }, 40000);
        pending.current.set(id, { resolve, reject, timer });
        connection.current.postMessage({ id, op, args, target });
      });
      const accountRequest = async action => {
        const response = await fetch(new URL(`marshal/account/${action}`, document.baseURI), { method: 'POST', headers: { 'x-marshal-account': '1' } });
        return response.json();
      };
      const loginAccount = async () => {
        const port = connection.current;
        if (!accountMode.current || !port || accountBusy.current === port) return;
        accountBusy.current = port;
        try {
          const data = await accountRequest('login');
          if (connection.current !== port) return;
          accountHash.current = data.accountHash || null;
          await invoke('account.login', data.ok ? { ticket: data.ticket } : { code: data.code });
        } catch (error) {
          if (connection.current === port) await invoke('account.login', { code: 'account-unavailable' }).catch(() => {});
        } finally { if (accountBusy.current === port) accountBusy.current = null; }
      };
      const loadControls = async (bridge, acquire = false) => {
        if (!bridge) return;
        setControlsBusy(true); setControlsNotice('正在读取目标智能体的模型…');
        try {
          if (acquire) {
            const acquired = await invoke('acquire', {}, bridge.target);
            if (active.current !== bridge) return;
            if (!acquired?.ok) throw Error('未能接管会话：' + (acquired?.code || 'unknown'));
          }
          const result = await invoke('controls', {}, bridge.target);
          if (active.current !== bridge) return;
          if (!result?.ok || !Array.isArray(result.result?.controls?.models)) throw Error('模型列表暂不可用：' + (result?.code === 'agent-crashed' ? '智能体通道暂时中断，请稍后刷新模型' : result?.code || 'unknown'));
          setCatalog(result.result.controls); setControlsNotice('选择会在下次发送时应用');
        } catch (error) { if (active.current === bridge) setControlsNotice(error.message); }
        finally { if (active.current === bridge) setControlsBusy(false); }
      };
      const changeSelection = value => {
        if (!active.current) return;
        choices.current.set(targetKey(active.current.target), value); setSelection(value);
        setControlsNotice('已选择，下次发送时应用');
      };
      const uploadFiles = async event => {
        const chosen = Array.from(event.target.files || []); event.target.value = '';
        const bridge = active.current; if (!bridge || !chosen.length) return;
        if (uploads.current.length + chosen.length > 8 || chosen.some(file => file.size > 10 * 1024 * 1024)) {
          setControlsNotice('每次最多 8 个附件，每个不超过 10 MB'); return;
        }
        const batch = chosen.map(file => ({ id: crypto.randomUUID(), name: file.name, status: '等待上传', file }));
        uploads.current = [...uploads.current, ...batch]; setFiles([...uploads.current]);
        for (const item of batch) {
          if (active.current !== bridge) break;
          try {
            const bytes = new Uint8Array(await item.file.arrayBuffer());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
            for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += 192 * 1024) {
              if (active.current !== bridge) return;
              const chunk = bytes.subarray(offset, offset + 192 * 1024);
              let binary = ''; for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
              const reply = await invoke('upload', { id: item.id, name: item.name, mime: item.file.type, size: bytes.length, offset, data: btoa(binary), sha256: hash }, bridge.target);
              if (active.current !== bridge) return;
              if (!reply?.ok) throw Error(reply?.code || '连接失败');
              item.status = reply.result?.complete ? '已上传' : Math.round((offset + chunk.length) * 100 / bytes.length) + '%';
              if (reply.result?.complete) item.receipt = reply.result.attachmentId;
              setFiles([...uploads.current]);
              if (!bytes.length) break;
            }
          } catch (error) { if (active.current === bridge) { item.status = '失败：' + error.message; setFiles([...uploads.current]); } }
        }
      };
      const promptFromComposer = async (op, args, target) => {
        if (op !== 'prompt') return invoke(op, args, target);
        const batch = uploads.current;
        if (batch.some(item => !item.receipt)) throw Error('请等待附件上传完成，或移除失败的附件');
        const options = choices.current.get(targetKey(target));
        const result = await invoke(op, { ...args, ...(options && Object.keys(options).length ? { options } : {}), attachments: batch.map(item => item.receipt) }, target);
        if (result?.ok && active.current && targetKey(active.current.target) === targetKey(target)) {
          uploads.current = uploads.current.filter(item => !batch.includes(item)); setFiles([...uploads.current]);
        }
        return result;
      };
      const loadHistory = async (bridge, cursor) => {
        setHistoryBusy(true);
        try {
          const reply = await invoke('history', cursor ? { cursor } : {}, bridge.target);
          if (active.current !== bridge) return;
          if (!reply?.ok || !Array.isArray(reply.result?.items)) throw Error('暂时无法读取历史：' + (reply?.code || 'unknown'));
          const page = reply.result;
          history.current = cursor ? (bridge.target.agent === 'dsh' ? [...page.items, ...history.current] : [...history.current, ...page.items]) : page.items;
          bridge.replace([...history.current, ...live.current]);
          setOlder(page.nextCursor || null);
          setNotice(page.nextCursor ? '当前显示部分历史，可继续加载' : page.completeness === 'complete' ? (bridge.target.agent === 'claude' ? 'Claude 历史接口未提供时间，历史消息显示读取时刻' : '') : '历史读取尚未完整，可重试读取');
        } catch (error) { if (active.current === bridge) setNotice(error.message); }
        finally { if (active.current === bridge) setHistoryBusy(false); }
      };
      React.useEffect(() => {
        const abort = new AbortController(); setAddress(null); setState({ authenticated: false }); disposeSession();
        readSetup().catch(() => null).then(info => {
          if (abort.signal.aborted) return null;
          if (info && !info.ready) { setSetup(info); setNotice(''); return null; }
          setSetup(null);
          return Promise.allSettled(['node', 'hub'].map(role => readAddress(role, abort.signal)));
        }).then(results => {
          if (!results) return;
          if (abort.signal.aborted) return;
          const found = results.find(result => result.status === 'fulfilled' && result.value);
          if (found) { accountMode.current = found.value.accountLogin; setAddress(found.value.url); setNotice(''); }
          else setNotice('暂时无法连接，请检查插件配置后重试。');
        });
        let checking = false;
        const checkAccount = async () => {
          if (!accountMode.current || !connection.current || accountBusy.current || checking) return;
          checking = true;
          try {
            const data = await accountRequest('status');
            if (abort.signal.aborted) return;
            const next = data.ok ? data.accountHash : null;
            if (next !== accountHash.current) {
              accountHash.current = next; disposeSession();
              await invoke('account.logout', { code: data.code || 'account-required' });
              if (next && !abort.signal.aborted) await loginAccount();
            }
          } catch (error) {
            if (!abort.signal.aborted && accountHash.current !== null) {
              accountHash.current = null; disposeSession();
              await invoke('account.logout', { code: 'account-unavailable' }).catch(() => {});
            }
          } finally { checking = false; }
        };
        const timer = setInterval(checkAccount, 20000); window.addEventListener('focus', checkAccount);
        return () => {
          clearInterval(timer); window.removeEventListener('focus', checkAccount);
          abort.abort(); active.current?.dispose(); active.current = null;
          connection.current?.close(); connection.current = null;
          for (const task of pending.current.values()) { clearTimeout(task.timer); task.reject(Error('连接已关闭')); }
          pending.current.clear();
        };
      }, [attempt]);
      const connect = () => {
        connection.current?.close();
        const channel = new MessageChannel(); connection.current = channel.port1;
        channel.port1.onmessage = event => {
          const data = event.data;
          if (data?.type === 'account-needed') { void loginAccount(); return; }
          if (data?.type === 'reply') {
            const task = pending.current.get(data.id); if (!task) return;
            pending.current.delete(data.id); clearTimeout(task.timer); task.resolve(data.result); return;
          }
          if (data?.type === 'clear') { disposeSession(); setState({ authenticated: false }); return; }
          if (data?.type === 'state') {
            setState(data);
            if (!data.authenticated || !data.target) { disposeSession(); return; }
            if (!active.current || targetKey(active.current.target) !== targetKey(data.target)) {
              disposeSession();
              try {
                const bridge = createSessionBridge(marshalContext, data.target, (op, args) => promptFromComposer(op, args, data.target), frame => live.current.push(frame));
                active.current = bridge; setBinding(bridge.reference); setNotice('正在读取原始会话…');
                setSelection(choices.current.get(targetKey(data.target)) || {});
                void loadHistory(bridge);
                if (data.target.agent !== 'claude') void loadControls(bridge);
              } catch (error) { setNotice(error.message); }
            }
            active.current?.running(data.running);
            active.current?.availability(data.canSend, data.reason);
          } else if (data?.type === 'event' && active.current && targetKey(active.current.target) === targetKey(data.event)) {
            live.current.push(data.event); active.current.append(data.event);
            if (data.event.kind === 'turn.started') active.current.running(true);
            if (data.event.kind === 'turn.completed') active.current.running(false);
          }
        };
        channel.port1.start();
        iframe.current?.contentWindow.postMessage({ type: 'marshal.native.connect' }, new URL(address).origin, [channel.port2]);
      };
      const compact = state.authenticated && !state.group;
      const selectedModel = catalog?.models.find(model => model.id === (selection.model || catalog?.current?.model));
      const onlineDevices = Array.isArray(deviceStatus?.devices) ? deviceStatus.devices.filter(d => d && d.online !== false).length : 0;
      const deviceDotColor = deviceStatus?.hubOnline ? '#10b981' : deviceStatus?.hubConfigured ? '#f59e0b' : '#10b981';
      const deviceLabel = deviceStatus?.hubOnline
        ? (onlineDevices > 0 ? onlineDevices + ' 台在线 · 设备' : 'Hub 在线 · 设备')
        : deviceStatus?.hubConfigured ? 'Hub 离线 · 设备' : '本机 · 设备';

      const chatSections = [
        ['groups', '常驻群聊', '本机与跨设备群'],
        ['taskRooms', '工单群', '任务协作会话'],
        ['direct', '智能体单聊', '历史闲聊与新建'],
        ['remote', '远端设备会话', '云端与多设备'],
      ];

      if (setup) return h(Setup, { initial: setup, onReady: () => retry(value => value + 1) });
      return h('section', { 'aria-label': '调度官', style: { flex: 1, height: '100%', minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' } },
        h('header', { style: { padding: '10px 18px', minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid #8883', flexShrink: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
            h(MarshalIcon),
            h('h1', { style: { fontSize: 15, fontWeight: 600, margin: 0, whiteSpace: 'nowrap' } }, '调度官'),
            state.account && h('span', { style: { fontSize: 11, opacity: .55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, state.account.name + (state.workspaceName ? ' · ' + state.workspaceName : ''))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            h(MarshalNav, { active: tab, onTab: chooseTab, compact: true }),
            health && (!health.capabilities?.agents || !health.capabilities?.taskBoard) && h('span', { style: { fontSize: 11, color: dswTheme.danger } },
              '缺少：' + [!health.capabilities?.agents ? '智能体后端' : '', !health.capabilities?.taskBoard ? '任务看板后端' : ''].filter(Boolean).join('、')),
            h('button', {
              type: 'button',
              'aria-label': '设备与手机',
              style: { ...buttonStyle, borderRadius: 999, padding: '5px 11px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 },
              onClick: () => { refreshDeviceStatus(); setDeviceDrawerOpen(true); },
            },
              h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: deviceDotColor, flexShrink: 0 } }),
              h('span', null, deviceLabel)))),
        tab === 'tasks' && h('div', { style: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', overflow: 'hidden', display: 'flex' } },
          h(MarshalErrorBoundary, { resetKey: 'tasks' },
            h(TaskBoardPage, { openSession, openTaskRoom, focusedTask, openNativeBoard: openPanel ? () => openPanel('task-board') : undefined, onOpenRosters: () => chooseTab('rosters') }))),
        tab === 'chats' && h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' } },
          h('nav', { 'aria-label': '会话分类', style: { width: 168, flexShrink: 0, borderRight: '1px solid ' + dswTheme.border, padding: 10, display: 'flex', flexDirection: 'column', gap: 4, background: 'color-mix(in srgb, currentColor 2%, transparent)' } },
            chatSections.map(([key, label, hint]) => h('button', {
              key, type: 'button', 'aria-pressed': chatSection === key,
              style: { ...tabStyle(chatSection === key), textAlign: 'left', padding: '9px 10px', display: 'grid', gap: 2 },
              onClick: () => { if (key === 'taskRooms') setRoomTask(null); setChatSection(key); },
            },
              h('span', { style: { fontSize: 13, fontWeight: chatSection === key ? 600 : 500 } }, label),
              h('span', { style: { fontSize: 10, opacity: .6 } }, hint)))),
          h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
            chatSection === 'groups' && h(MarshalErrorBoundary, { resetKey: 'groups-' + groupSub },
              h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
                h('div', { style: { padding: '8px 16px', borderBottom: '1px solid ' + dswTheme.border, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
                  h('button', { type: 'button', style: tabStyle(groupSub === 'local'), onClick: () => setGroupSub('local') }, '本机常驻群'),
                  h('button', { type: 'button', style: tabStyle(groupSub === 'cross'), onClick: () => setGroupSub('cross') }, '跨设备群聊')),
                groupSub === 'local'
                  ? h(GroupsPage, { openSession, onOpenAgents: () => chooseTab('agents') })
                  : h(CrossGroupsPage))),
            chatSection === 'taskRooms' && h(MarshalErrorBoundary, { resetKey: 'taskRooms-' + (roomTask?.id ?? 'archive') },
              h(TaskRoomsPage, { key: roomTask?.id ?? 'archive', task: roomTask, openBoard })),
            chatSection === 'direct' && h(MarshalErrorBoundary, { resetKey: 'direct' },
              h(AgentDirectChatsView, { openSession, mvOpenDirect, onOpenAgents: () => chooseTab('agents') })),
            chatSection === 'remote' && h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
              address && h('iframe', { ref: iframe, onLoad: connect, title: '调度官设备与群聊', src: address,
                sandbox: 'allow-scripts allow-same-origin allow-forms', allow: 'clipboard-write', referrerPolicy: 'no-referrer',
                style: { width: compact ? 310 : '100%', flexShrink: 0, minHeight: 0, border: 0, borderRight: compact ? '1px solid #8883' : 0 } }),
              compact && h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
                state.target && h('header', { style: { padding: '16px 22px 10px', flexShrink: 0 } },
                  h('div', { style: { fontSize: 15, fontWeight: 600 } }, state.title || '未命名会话'),
                  h('div', { style: { opacity: .5, fontSize: 11, marginTop: 4 } }, state.target.agent.toUpperCase() + ' · ' + (state.deviceName || state.target.deviceId)),
                  h('p', { role: 'status', style: { opacity: .65, fontSize: 12, margin: '8px 0 0' } }, notice || state.reason),
                  h('button', { type: 'button', disabled: historyBusy, style: { ...buttonStyle, marginTop: 8, marginRight: 8 }, onClick: () => { live.current = []; void loadHistory(active.current); } }, historyBusy ? '读取中…' : '刷新历史'),
                  older && h('button', { type: 'button', disabled: historyBusy, style: { ...buttonStyle, marginTop: 8 }, onClick: () => loadHistory(active.current, older) }, historyBusy ? '读取中…' : '加载更多历史')),
                binding && h('div', { style: { padding: '8px 22px', borderBottom: '1px solid #8882', flexShrink: 0 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
                    h('label', { style: { fontSize: 12 } }, '模型 ', h('select', { 'aria-label': '本次发送模型', value: selection.model || '', disabled: controlsBusy || state.running,
                      style: { ...buttonStyle, maxWidth: 250 }, onChange: event => changeSelection(event.target.value ? { model: event.target.value } : {}) },
                      h('option', { value: '' }, '沿用会话模型'), ...(catalog?.models || []).map(model => h('option', { key: model.id, value: model.id }, model.label)))),
                    h('label', { style: { fontSize: 12 } }, '思考 ', h('select', { 'aria-label': '本次发送思考强度', value: selection.reasoning || '', disabled: !selectedModel?.efforts.length || state.running,
                      style: buttonStyle, onChange: event => changeSelection({ model: selection.model, ...(event.target.value ? { reasoning: event.target.value } : {}) }) },
                      h('option', { value: '' }, '默认'), ...(selectedModel?.efforts || []).map(effort => h('option', { key: effort, value: effort }, ({ off: '关闭', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' })[effort] || effort)))),
                    h('button', { type: 'button', style: buttonStyle, disabled: controlsBusy || state.running, onClick: () => loadControls(active.current, state.target.agent === 'claude' && !catalog) }, controlsBusy ? '读取中…' : catalog ? '刷新模型' : state.target.agent === 'claude' ? '接管并加载模型' : '加载模型'),
                    h('button', { type: 'button', style: buttonStyle, disabled: state.running, onClick: () => fileInput.current?.click() }, '＋ 添加附件'),
                    h('input', { ref: fileInput, type: 'file', multiple: true, 'aria-label': '上传会话附件', style: { display: 'none' }, onChange: uploadFiles })),
                  h('div', { role: 'status', style: { opacity: .55, fontSize: 11, marginTop: 6 } }, controlsNotice, ' · 每个附件 ≤10 MB'),
                  files.length > 0 && h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } }, files.map(item => h('span', { key: item.id, style: { border: '1px solid #8884', borderRadius: 8, padding: '3px 8px', fontSize: 12 } },
                    item.name + ' · ' + item.status, h('button', { type: 'button', 'aria-label': '移除附件 ' + item.name, style: { ...buttonStyle, border: 0, padding: '0 5px' }, onClick: () => { uploads.current = uploads.current.filter(file => file.id !== item.id); setFiles([...uploads.current]); } }, '×'))))),
                binding ? h(SessionProvider, { session: binding, key: binding.sessionId }, renderSlot('marshal.native.body', { canSend: state.canSend, reason: state.reason }))
                  : h('p', { style: { margin: 'auto', opacity: .55 } }, notice || '选择一个远端会话，继续工作'),
                h(Statistics, { value: state.statistics, agent: state.target?.agent })),
              !address && h('p', { role: 'status', style: { margin: 'auto', padding: 24 } }, notice)))),
        tab === 'agents' && h('div', { style: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', overflow: 'hidden', display: 'flex' } },
          h(MarshalErrorBoundary, { resetKey: 'agents' },
            h(AgentsPage, { onOpenChats: () => chooseTab('chats'), onOpenMemory: openAgentMemory, openSession, mvOpenDirect, workspaceService, initialSubTab: agentSub }))),
        tab === 'memory' && h('div', { style: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', overflow: 'hidden', display: 'flex' } },
          h(MarshalErrorBoundary, { resetKey: 'memory' },
            h(MemoryPage, { initialAgentId: memoryTarget.agentId, initialLayer: memoryTarget.layer, mvOpenDirect }))),
        h(DeviceStatusDrawer, {
          open: deviceDrawerOpen,
          onClose: () => setDeviceDrawerOpen(false),
          status: deviceStatus,
          onRefresh: () => { retry(v => v + 1); refreshDeviceStatus(); },
          onOpenRemote: () => { setChatSection('remote'); setTab('chats'); },
        }));
    }
