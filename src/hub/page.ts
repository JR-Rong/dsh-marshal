/**
 * 页面是静态模板：所有来自设备/会话/事件的数据都经 textContent 写入，
 * 不用 innerHTML 拼字符串，也不在模板里插入任何服务端值。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>marshal</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; display:flex; height:100vh; }
  aside { width:300px; border-right:1px solid #8883; padding:12px; overflow:auto; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #log { flex:1; overflow:auto; padding:12px; }
  .row { padding:6px 8px; border-radius:6px; cursor:pointer; }
  .row:hover, .row.active { background:#8881; }
  .group { font-weight:600; margin-top:12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#999; margin-right:6px; }
  .dot.running { background:#2a2; }
  .tool { border:1px solid #8883; border-radius:6px; padding:6px 8px; margin:6px 0; font-family:ui-monospace,monospace; font-size:12px; }
  .reason { color:#888; white-space:pre-wrap; }
  .ask { border:2px solid #d80; border-radius:8px; padding:10px; margin:10px 0; }
  .ask button { margin:4px 6px 0 0; padding:4px 10px; }
  .ask button.picked { outline:2px solid #d80; }
  form { display:flex; gap:8px; padding:12px; border-top:1px solid #8883; }
  input { flex:1; padding:8px; }
  #status { padding:0 12px 8px; color:#c33; min-height:1.2em; }
</style></head>
<body>
<aside><div id="devices">loading…</div></aside>
<main><div id="log"></div>
<form id="send"><input id="text" placeholder="给选中会话发一条消息"><button>发送</button></form>
<div id="status"></div></main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const api = (path) => path + (token ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
let current = null;
let selected = null;
const log = document.getElementById('log');
const devicesRoot = document.getElementById('devices');
const status = document.getElementById('status');

// 非安全上下文（局域网 http）没有 crypto.randomUUID，退化成时间戳+随机串。
const newKey = () => (globalThis.crypto && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2);

function append(node) { log.append(node); log.scrollTop = log.scrollHeight; }

function dot(running) {
  const span = document.createElement('span');
  span.className = running ? 'dot running' : 'dot';
  return span;
}

async function refresh() {
  let data = null;
  try {
    const response = await fetch(api('/marshal/api/devices'));
    if (response.ok) data = await response.json();
  } catch { /* 网络错误按断开处理 */ }
  if (data === null || !Array.isArray(data.devices)) { devicesRoot.textContent = 'hub 断开，重试中…'; return; }
  devicesRoot.textContent = '';
  for (const device of data.devices) {
    if (!device || typeof device.id !== 'string') continue;
    const group = document.createElement('div');
    group.className = 'group';
    group.textContent = device.name + ' (' + device.id + ')';
    devicesRoot.append(group);
    if (!Array.isArray(device.agents)) continue;
    for (const agent of device.agents) {
      const row = document.createElement('div');
      row.className = 'row';
      // 每次轮询重建列表，按记录下来的选择恢复高亮。
      if (selected !== null && selected.device === device.id && selected.agent === agent) row.classList.add('active');
      row.append(dot(false), document.createTextNode(agent));
      row.onclick = () => {
        selected = { device: device.id, agent };
        for (const other of devicesRoot.querySelectorAll('.row')) other.classList.remove('active');
        row.classList.add('active');
        loadSessions(device.id, agent);
      };
      devicesRoot.append(row);
    }
  }
}

async function loadSessions(device, agent) {
  // 换设备/agent 后旧选中不再属于当前列表，先作废，避免指令发到上一个会话。
  if (current !== null && (current.device !== device || current.agent !== agent)) {
    current = null;
    status.textContent = '';
  }
  let data = null;
  try {
    const response = await fetch(api('/marshal/api/sessions?device=' + encodeURIComponent(device)));
    if (response.ok) data = await response.json();
  } catch { /* 网络错误按加载失败处理 */ }
  if (data === null || !Array.isArray(data.sessions)) { log.textContent = '加载失败'; return; }
  log.textContent = '';
  for (const session of data.sessions) {
    // 没 sessionId 的行直接丢掉，否则后面的 slice 会抛错并毁掉整张列表。
    if (!session || typeof session.sessionId !== 'string') continue;
    if (session.agent !== agent) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.append(dot(session.running), document.createTextNode(session.sessionId.slice(0, 8)));
    row.onclick = async () => {
      // 已选中的会话再点一次不重发 resume。
      if (current !== null && current.device === device && current.agent === agent && current.sessionId === session.sessionId) return;
      const ok = await command('resume', {}, { device, agent, sessionId: session.sessionId });
      if (!ok) return;
      current = { device, agent, sessionId: session.sessionId };
      status.textContent = '';
      for (const other of log.querySelectorAll('.row')) other.classList.remove('active');
      row.classList.add('active');
    };
    log.append(row);
  }
}

// 失败统一写进 #status 并返回 false，调用方据此决定是否更新本地状态。
async function command(op, args, target, idempotencyKey) {
  const to = target || current;
  if (to === null) { status.textContent = '失败：请先选择会话'; return false; }
  let response;
  try {
    response = await fetch(api('/marshal/api/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, target: to, args, idempotencyKey: idempotencyKey || newKey() }),
    });
  } catch {
    status.textContent = '失败：网络错误';
    return false;
  }
  if (!response.ok) {
    let message = 'HTTP ' + response.status;
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch { /* 非 JSON 错误体就用状态码 */ }
    status.textContent = '失败：' + message;
    return false;
  }
  return true;
}

const stream = new EventSource(api('/marshal/api/stream'));
stream.onmessage = (message) => {
  let event;
  try { event = JSON.parse(message.data) } catch { return; }
  // 同一 sessionId 在不同 agent 下不是同一条会话，必须连 agent 一起比对。
  if (current === null || event.device !== current.device || event.agent !== current.agent || event.sessionId !== current.sessionId) return;
  const node = document.createElement('div');
  const payload = event.payload || {};
  if (event.kind === 'reasoning.delta') {
    node.className = 'reason';
    node.textContent = payload.redacted ? '（思考 ' + payload.chars + ' 字，metadata 档）' : payload.text;
  } else if (event.kind === 'message.delta') {
    node.textContent = payload.redacted ? '（回复 ' + payload.chars + ' 字，metadata 档）' : payload.text;
  } else if (event.kind === 'tool.started') {
    node.className = 'tool';
    node.textContent = '▶ ' + payload.name + ' ' + (payload.argumentKeys ? '[' + payload.argumentKeys.join(',') + ']' : JSON.stringify(payload.arguments));
  } else if (event.kind === 'tool.completed') {
    node.className = 'tool';
    node.textContent = (payload.isError ? '✗ ' : '✓ ') + (payload.redacted ? payload.chars + ' 字' : String(payload.content).slice(0, 400));
  } else if (event.kind === 'input.requested') {
    node.className = 'ask';
    node.dataset.requestId = payload.requestId;
    const questions = Array.isArray(payload.questions) ? payload.questions.filter(q => q !== null && typeof q === 'object') : [];
    const title = document.createElement('div');
    title.textContent = questions.map(q => q.question).join(' / ');
    node.append(title);
    // parseAnswers 要求每个问题 id 恰好一次：只认字符串 id，重复 id 合成一题。
    const ids = [...new Set(questions.map(q => q.id).filter(id => typeof id === 'string'))];
    const total = ids.length;
    // 只能自由输入、没有选项的问题在页面上答不了：整张卡片只读，等请求超时交回本地 UI。
    const customOnly = questions.some(q => !Array.isArray(q.options) || q.options.length === 0);
    // 一张卡片先收集所有问题的选择，全部选好才发一次 answer（每个 id 恰好一条）。
    const selections = new Map();
    const allButtons = [];
    if (total > 0) {
      for (const question of questions) {
        const heading = document.createElement('div');
        heading.textContent = question.question;
        node.append(heading);
        if (!Array.isArray(question.options) || question.options.length === 0) {
          const note = document.createElement('div');
          note.className = 'reason';
          note.textContent = '需要本机作答';
          node.append(note);
          continue;
        }
        // 同一问题下的选项互斥，只保留最后一次点击。
        const group = [];
        for (const option of question.options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = option.label;
          button.setAttribute('aria-pressed', 'false');
          if (customOnly) button.disabled = true;
          group.push(button);
          allButtons.push(button);
          button.onclick = async () => {
            if (typeof question.id !== 'string') return;
            selections.set(question.id, option.label);
            for (const other of group) {
              const picked = other === button;
              other.classList.toggle('picked', picked);
              other.setAttribute('aria-pressed', picked ? 'true' : 'false');
            }
            if (selections.size !== total) return;
            const ok = await command('answer', {
              requestId: payload.requestId,
              answers: ids.map(id => ({ id, selected: [selections.get(id)] })),
            });
            // 失败时清空选择、取消标记，卡片留着让用户重试；错误已由 command 写进 #status。
            if (!ok) {
              selections.clear();
              for (const item of allButtons) {
                item.classList.remove('picked');
                item.setAttribute('aria-pressed', 'false');
              }
              return;
            }
            for (const item of allButtons) item.disabled = true;
            node.textContent = '已由本机回答：' + ids.map(id => selections.get(id)).join(' / ');
            node.dataset.resolved = 'local';
          };
          node.append(button);
        }
      }
    }
  } else if (event.kind === 'input.resolved') {
    const card = [...log.children].find(el => el.dataset.requestId === payload.requestId);
    // 本机已经答过就以本机回执为准，不被从 hub 绕回来的 "另一处" 覆盖。
    if (card && card.dataset.resolved !== 'local') {
      card.textContent = payload.outcome === 'remote' ? '已由另一处回答' : '已交回源机器';
    }
    return;
  } else {
    return;
  }
  append(node);
};

document.getElementById('send').onsubmit = async (submit) => {
  submit.preventDefault();
  const text = document.getElementById('text').value.trim();
  if (!text) return;
  document.getElementById('text').value = '';
  await command('prompt', { text, requestId: newKey() });
};

refresh();
setInterval(refresh, 5000);
</script></body></html>`
