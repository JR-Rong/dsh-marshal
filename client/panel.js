/* React and native conversation slots are supplied by DSH. */
window.__ModuleLoader__.load({
  id: 'dsh-marshal',
  factory(require) {
    const React = require('react');
    const { createSessionBridge, targetKey } = marshalNative();
    const { Setup, readSetup } = marshalSetup(React);
    const h = React.createElement;
    const PANEL = 'dsh-marshal';
    const buttonStyle = { border: '1px solid #8885', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, padding: '6px 12px', cursor: 'pointer' };
    function Statistics({ value, agent }) {
      if (!value) return null;
      const number = key => Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : undefined;
      const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      const codex = agent === 'codex';
      const turns = number('turns'), steps = number('steps'), ms = number(codex ? 'turnMs' : 'decodeMs'), decoded = number(codex ? 'turnOutputTokens' : 'decodeTokens');
      const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(number);
      const all = buckets.every(n => n !== undefined), input = all ? buckets[0] + buckets[2] + buckets[3] : 0;
      const context = number('contextTokens'), limit = number('contextWindow');
      const parts = [
        [turns === undefined ? '' : turns + ' 轮', steps === undefined ? '' : steps + ' 步', ms > 0 && decoded !== undefined ? (codex ? '平均 ' : '') + Math.round(decoded * 1000 / ms) + ' tok/s' : ''].filter(Boolean).join(' · '),
        all ? compact(number('totalTokens') ?? buckets.reduce((sum, n) => sum + n, 0)) + ' tok' + (input > 0 ? ' · 缓存命中 ' + Math.round(buckets[2] * 100 / input) + '%' : '') : '',
        context !== undefined && limit > 0 ? '上下文 ' + Math.min(100, Math.round(context * 100 / limit)) + '%' : '',
      ].filter(Boolean);
      return parts.length ? h('div', { 'aria-label': codex ? 'Codex 会话统计' : 'DSH 会话统计', title: codex ? '来自 Codex 原生用量；累计 token 包含缓存和思考。平均速度为最近可统计完整回合的输出 token / 总耗时，包含思考、工具和网络等待；不是纯解码速度。' : '来自源端 DSH 的会话累计统计；速度为输出解码速度', style: { display: 'flex', flexWrap: 'wrap', gap: '6px 22px', padding: '8px 22px 14px', fontSize: 12, opacity: .65, fontVariantNumeric: 'tabular-nums' } }, ...parts.map((text, i) => h('span', { key: i }, text))) : null;
    }
    function MarshalIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('rect', { x: 7, y: 2, width: 10, height: 7, rx: 1.5 }), h('path', { d: 'M12 9v5M5 14h14M5 14v3M19 14v3' }),
        h('rect', { x: 2, y: 17, width: 6, height: 5, rx: 1 }), h('rect', { x: 16, y: 17, width: 6, height: 5, rx: 1 }));
    }
    async function readAddress(role, signal) {
      const response = await fetch(new URL(`marshal/entry/${role}`, document.baseURI), { signal });
      if (!response.ok) return null;
      const data = await response.json(); const url = new URL(data.dashboardUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
      url.pathname += '/desktop'; return { url: url.href, accountLogin: data.accountLogin === true };
    }
    function NativeBody({ renderFactorySlot }) {
      return h('div', { className: 'marshal-native-conversation', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' } },
        h('style', null, '.marshal-native-conversation button[aria-haspopup],.marshal-native-conversation button[aria-label^="访问模式"],.marshal-native-conversation button[aria-label^="计划模式"],.marshal-native-conversation button[aria-label*="分支"],.marshal-native-conversation button[aria-label="好的回答"],.marshal-native-conversation button[aria-label="有问题的回答"] { display:none }'),
        renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }));
    }
    function MarshalPanel({ marshalContext, SessionProvider, renderSlot }) {
      const [attempt, retry] = React.useState(0);
      const [address, setAddress] = React.useState(null);
      const [setup, setSetup] = React.useState(null);
      const [state, setState] = React.useState({ authenticated: false });
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
          if (acquire) { const acquired = await invoke('acquire', {}, bridge.target); if (!acquired?.ok) throw Error('暂时无法接管会话'); }
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
      if (setup) return h(Setup, { initial: setup, onReady: () => retry(value => value + 1) });
      return h('section', { 'aria-label': '调度官', style: { height: '100%', minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('header', { style: { padding: '12px 20px', minHeight: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #8883', flexShrink: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, h(MarshalIcon), h('h1', { style: { fontSize: 16, fontWeight: 600, margin: 0 } }, '调度官'), h('span', { style: { fontSize: 12, opacity: .55 } }, state.account ? state.account.name + ' · ' + state.workspaceName : '原生会话')),
          h('button', { type: 'button', style: buttonStyle, onClick: () => retry(value => value + 1) }, '重新连接')),
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
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
              : h('p', { style: { margin: 'auto', opacity: .55 } }, notice || '选择一个会话，继续工作'),
            h(Statistics, { value: state.statistics, agent: state.target?.agent })),
          !address && h('p', { role: 'status', style: { margin: 'auto', padding: 24 } }, notice)));
    }
    return {
      inject: ['slots', 'sessions', 'uiSession', 'uiConversation'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 25, label: () => '调度官' }, MarshalIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
          children: { 'marshal.native.body': { kind: 'single', scope: 'session' } }, inject: () => ({ marshalContext: ctx }),
        }, MarshalPanel));
        ctx.slots.inject('marshal.native.body', () => ctx.slots.register({ name: 'marshal.native.body' }, NativeBody));
      },
    };
  },
});
