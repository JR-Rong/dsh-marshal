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
  form { display:flex; gap:8px; padding:12px; border-top:1px solid #8883; }
  input { flex:1; padding:8px; }
</style></head>
<body>
<aside><div id="devices">loading…</div></aside>
<main><div id="log"></div>
<form id="send"><input id="text" placeholder="给选中会话发一条消息"><button>发送</button></form></main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const api = (path) => path + (token ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
let current = null;
const log = document.getElementById('log');

function append(node) { log.append(node); log.scrollTop = log.scrollHeight; }

function dot(running) {
  const span = document.createElement('span');
  span.className = running ? 'dot running' : 'dot';
  return span;
}

async function refresh() {
  const data = await (await fetch(api('/marshal/api/devices'))).json();
  const root = document.getElementById('devices');
  root.textContent = '';
  for (const device of data.devices) {
    const group = document.createElement('div');
    group.className = 'group';
    group.textContent = device.name + ' (' + device.id + ')';
    root.append(group);
    for (const agent of device.agents) {
      const row = document.createElement('div');
      row.className = 'row';
      row.append(dot(false), document.createTextNode(agent));
      row.onclick = () => { row.classList.add('active'); loadSessions(device.id, agent); };
      root.append(row);
    }
  }
}

async function loadSessions(device, agent) {
  const data = await (await fetch(api('/marshal/api/sessions?device=' + encodeURIComponent(device)))).json();
  log.textContent = '';
  for (const session of data.sessions.filter(s => s.agent === agent)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(dot(session.running), document.createTextNode(session.sessionId.slice(0, 8)));
    row.onclick = () => { current = { device, agent, sessionId: session.sessionId }; command('resume', {}); };
    log.append(row);
  }
}

async function command(op, args, idempotencyKey) {
  if (current === null) return;
  return fetch(api('/marshal/api/command'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, target: current, args, idempotencyKey: idempotencyKey || crypto.randomUUID() }),
  });
}

const stream = new EventSource(api('/marshal/api/stream'));
stream.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (current === null || event.device !== current.device || event.sessionId !== current.sessionId) return;
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
    const title = document.createElement('div');
    title.textContent = payload.questions.map(q => q.question).join(' / ');
    node.append(title);
    for (const question of payload.questions) {
      for (const option of question.options || []) {
        const button = document.createElement('button');
        button.textContent = option.label;
        button.onclick = async () => {
          await command('answer', {
            requestId: payload.requestId,
            answers: [{ id: question.id, selected: [option.label] }],
          });
          node.textContent = '已由本机回答：' + option.label;
        };
        node.append(button);
      }
    }
  } else if (event.kind === 'input.resolved') {
    const card = [...log.children].find(el => el.dataset.requestId === payload.requestId);
    if (card) card.textContent = payload.outcome === 'timeout' ? '已交回源机器' : '已由另一处回答';
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
  await command('prompt', { text, requestId: crypto.randomUUID() });
};

refresh();
setInterval(refresh, 5000);
</script></body></html>`
