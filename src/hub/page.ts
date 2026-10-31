/**
 * 页面是静态模板：所有来自设备/会话/事件的数据都经 textContent 写入，
 * 不拼 HTML 字符串，也不在模板里插入任何服务端值。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>marshal</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; height:100vh; }
  [hidden] { display:none !important; }
  #loginView { max-width:420px; margin:12vh auto; padding:24px; }
  #loginView form { display:flex; gap:8px; padding:0; border:0; }
  #loginView input { flex:1; padding:8px; }
  #appView { display:flex; height:100vh; }
  aside { width:320px; border-right:1px solid #8883; padding:12px; overflow:auto; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #log { flex:1; overflow:auto; padding:12px; }
  #cards { max-height:45vh; overflow:auto; padding:0 12px; }
  .row { padding:6px 8px; border-radius:6px; cursor:pointer; }
  .row:hover, .row.active { background:#8881; }
  .group { font-weight:600; margin-top:12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#999; margin-right:6px; }
  .dot.running { background:#2a2; }
  .tool { border:1px solid #8883; border-radius:6px; padding:6px 8px; margin:6px 0; font-family:ui-monospace,monospace; font-size:12px; white-space:pre-wrap; }
  .reason { color:#888; white-space:pre-wrap; }
  .ask { border:2px solid #d80; border-radius:8px; padding:10px; margin:10px 0; }
  .ask button { margin:4px 6px 0 0; padding:4px 10px; }
  .ask button.picked { outline:2px solid #d80; }
  .ask input[type=text] { width:100%; box-sizing:border-box; margin-top:4px; padding:6px; }
  #send { display:flex; gap:8px; padding:12px; border-top:1px solid #8883; }
  #send input { flex:1; padding:8px; }
  #status { padding:0 12px 8px; color:#c33; min-height:1.2em; white-space:pre-wrap; }
  #who { font-size:12px; color:#888; word-break:break-all; }
  #pending div { font-size:12px; color:#888; padding:2px 0; white-space:pre-wrap; }
</style></head>
<body>
<div id="loginView" hidden>
  <h1>marshal</h1>
  <form id="loginForm">
    <input id="loginToken" type="password" autocomplete="current-password" placeholder="dashboard token">
    <button>登录</button>
  </form>
  <p class="reason" id="loginStatus"></p>
</div>
<div id="appView" hidden>
  <aside>
    <div id="who"></div>
    <button id="logout" type="button">退出</button>
    <div class="group">设备</div>
    <div id="devices">loading…</div>
    <div class="group">未决写入</div>
    <div id="pending"></div>
  </aside>
  <main>
    <div id="status"></div>
    <div id="cards"></div>
    <div id="log"></div>
    <form id="send"><input id="text" placeholder="给选中会话发一条消息"><button>发送</button></form>
  </main>
</div>
<script>
'use strict';
var SESSION_PATH = '/marshal/api/session';
var EVENTS_KEY = 'marshal-events';
var CSRF_COOKIE = '__Host-marshal-csrf';
var origin = location.origin;
var session = null;
var current = null;
var currentRow = null;
var stream = null;
var lastAuthCheck = 0;
var writeState = 'unknown';
var writeReason = '未选择会话';
var unknownDevices = {};
var barrierBlocked = true;
var rebuilding = false;
var rebuildGeneration = 0;
var queuedEvents = [];
var MAX_QUEUED_EVENTS = 256;
var lastSeq = new Map();
var cardMap = new Map();
var db = null;
var dbUnavailable = false;
var loginStatus = document.getElementById('loginStatus');
var status = document.getElementById('status');
var log = document.getElementById('log');
var cardsRoot = document.getElementById('cards');
var devicesRoot = document.getElementById('devices');
var pendingRoot = document.getElementById('pending');
var sendForm = document.getElementById('send');
var textInput = document.getElementById('text');

function setStatus(text) { status.textContent = text || ''; }
function clearNode(node) { node.textContent = ''; }

function readCookie(name) {
  var parts = document.cookie ? document.cookie.split(';') : [];
  for (var index = 0; index < parts.length; index += 1) {
    var part = parts[index];
    var at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

// 非安全上下文没有 crypto.randomUUID，退化成时间戳+随机串。
function newKey() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function request(path, options) {
  var init = Object.assign({ credentials: 'same-origin' }, options || {});
  return fetch(path, init);
}

function writeHeaders() {
  var headers = { 'content-type': 'application/json' };
  var csrf = readCookie(CSRF_COOKIE);
  if (csrf) headers['x-marshal-csrf'] = csrf;
  return headers;
}

function sessionKey(target) {
  return JSON.stringify([target.deviceId, target.agent, target.sessionId]);
}

function cardKey(target, runtimeEpoch, requestId) {
  return [target.deviceId, target.agent, target.sessionId, runtimeEpoch || 'unknown', requestId].join('\\u0000');
}

function appendLog(node) {
  log.append(node);
  log.scrollTop = log.scrollHeight;
}

function textNode(tag, text, className) {
  var node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/* ---------------- IndexedDB：跨标签页/重启的无正文写入记录 ---------------- */

function openDb() {
  return new Promise(function(resolve) {
    if (db !== null) { resolve(db); return; }
    if (!globalThis.indexedDB) { dbUnavailable = true; resolve(null); return; }
    var request;
    try { request = indexedDB.open('marshal', 1); } catch (error) { dbUnavailable = true; resolve(null); return; }
    request.onupgradeneeded = function() {
      var store = request.result.createObjectStore('intents', { keyPath: 'id' });
      store.createIndex('owner', 'owner', { unique: false });
    };
    request.onsuccess = function() { db = request.result; resolve(db); };
    request.onerror = function() { dbUnavailable = true; resolve(null); };
    request.onblocked = function() { resolve(null); };
  });
}

function intentId(key, target, op) {
  return [origin, session ? session.operatorId : 'anonymous', target.deviceId, target.agent,
    target.sessionId, op, key].join('|');
}

function withStore(mode, action) {
  return openDb().then(function(handle) {
    if (handle === null) return null;
    return new Promise(function(resolve) {
      var store = handle.transaction('intents', mode).objectStore('intents');
      var request;
      try { request = action(store); } catch (error) { resolve(null); return; }
      request.onsuccess = function() { resolve(request.result === undefined ? true : request.result); };
      request.onerror = function() { resolve(null); };
    });
  });
}

/** 写请求发送前先落盘；存储不可用或失败时拒绝新写（契约 §6）。 */
function persistIntent(record) {
  return withStore('readwrite', function(store) { return store.put(record); }).then(function(result) {
    if (result === null) return false;
    var channel;
    try { channel = new BroadcastChannel('marshal-intents'); channel.postMessage(record.id); channel.close(); } catch (error) {}
    return true;
  });
}

function updateIntent(id, changes) {
  return openDb().then(function(handle) {
    if (handle === null) return false;
    return new Promise(function(resolve) {
      var tx = handle.transaction('intents', 'readwrite');
      var store = tx.objectStore('intents');
      var get = store.get(id);
      get.onsuccess = function() {
        var record = get.result;
        if (!record) { resolve(false); return; }
        Object.assign(record, changes);
        var put = store.put(record);
        put.onsuccess = function() { resolve(true); };
        put.onerror = function() { resolve(false); };
      };
      get.onerror = function() { resolve(false); };
    });
  });
}

function listIntents() {
  return openDb().then(function(handle) {
    if (handle === null) return [];
    return new Promise(function(resolve) {
      var request = handle.transaction('intents', 'readonly').objectStore('intents').getAll();
      request.onsuccess = function() {
        var own = origin + '|' + (session ? session.operatorId : 'anonymous') + '|';
        resolve((request.result || []).filter(function(record) { return String(record.id).indexOf(own) === 0; }));
      };
      request.onerror = function() { resolve([]); };
    });
  });
}

var INTENT_LABELS = {
  pending: '未确认（发送中/结果未知，不自动重发）',
  accepted: '已受理',
  rejected: '拒绝',
  unknown: '状态未知，先人工核对',
};

function renderPending(records) {
  clearNode(pendingRoot);
  for (var index = 0; index < records.length; index += 1) {
    var record = records[index];
    if (record.status === 'accepted' || record.status === 'rejected') continue;
    var label = INTENT_LABELS[record.status] || INTENT_LABELS.unknown;
    pendingRoot.append(textNode('div', record.op + ' · ' + record.target.sessionId + ' · ' + label));
  }
}

/** 恢复后只查状态，绝不自动重发；未知记录保持 pending 提示。 */
function reconcilePending() {
  return listIntents().then(function(records) {
    var tasks = records.map(function(record) {
      if (record.status !== 'pending' && record.status !== 'unknown') return Promise.resolve();
      var query = '/marshal/api/command-status?deviceId=' + encodeURIComponent(record.target.deviceId)
        + '&agent=' + encodeURIComponent(record.target.agent)
        + '&sessionId=' + encodeURIComponent(record.target.sessionId)
        + '&op=' + encodeURIComponent(record.op)
        + '&key=' + encodeURIComponent(record.key);
      return request(query, { method: 'GET' }).then(function(response) {
        if (!response.ok && response.status !== 202 && response.status !== 404) return null;
        return response.json().then(function(body) {
          if (!body || typeof body.status !== 'string') return null;
          return body.status === 'accepted' || body.status === 'confirmed'
            ? 'accepted'
            : body.status === 'rejected' ? 'rejected' : 'pending';
        }).catch(function() { return null; });
      }).catch(function() { return null; }).then(function(next) {
        if (next === null || next === record.status) return null;
        return updateIntent(record.id, { status: next, updatedAt: Date.now() }).then(function() {
          record.status = next;
        });
      });
    });
    return Promise.all(tasks).then(function() { renderPending(records); });
  });
}

/* ---------------- 登录与会话 ---------------- */

function showLogin(message) {
  closeStream();
  session = null;
  current = null;
  writeState = 'unknown';
  barrierBlocked = true;
  rebuilding = false;
  rebuildGeneration += 1;
  queuedEvents.length = 0;
  clearNode(cardsRoot);
  clearNode(log);
  cardMap.clear();
  lastSeq.clear();
  document.getElementById('appView').hidden = true;
  document.getElementById('loginView').hidden = false;
  loginStatus.textContent = message || '';
  var input = document.getElementById('loginToken');
  input.value = '';
  input.focus();
}

function enterApp(data) {
  session = data;
  document.getElementById('loginView').hidden = true;
  document.getElementById('appView').hidden = false;
  document.getElementById('who').textContent = 'operator ' + data.operatorId + ' · 到期 '
    + new Date(data.expiresAt).toLocaleString();
  loginStatus.textContent = '';
  connectStream();
  refreshDevices();
  reconcilePending();
}

async function restore() {
  var response;
  try { response = await request(SESSION_PATH, { method: 'GET' }); } catch (error) {
    showLogin('hub 不可达'); return;
  }
  if (!response.ok) { showLogin(''); return; }
  var data;
  try { data = await response.json(); } catch (error) { showLogin(''); return; }
  if (!data || typeof data.csrf !== 'string' || typeof data.operatorId !== 'string') { showLogin(''); return; }
  enterApp(data);
}

document.getElementById('loginForm').onsubmit = async function(event) {
  event.preventDefault();
  var token = document.getElementById('loginToken').value;
  loginStatus.textContent = '';
  if (!token) { loginStatus.textContent = '请输入 dashboard token'; return; }
  var response;
  try {
    response = await request('/marshal/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token }),
    });
  } catch (error) {
    loginStatus.textContent = '登录失败：网络错误'; return;
  }
  // token 只放在请求体，绝不进入 URL；输入框立即清空。
  document.getElementById('loginToken').value = '';
  if (!response.ok) {
    loginStatus.textContent = response.status === 429 ? '尝试过多，稍后再试' : '登录失败';
    return;
  }
  var data;
  try { data = await response.json(); } catch (error) { loginStatus.textContent = '登录失败'; return; }
  enterApp(data);
};

document.getElementById('logout').onclick = async function() {
  try {
    await request('/marshal/logout', { method: 'POST', headers: writeHeaders(), body: '{}' });
  } catch (error) {}
  showLogin('已退出');
};

/* ---------------- 索引与选择 ---------------- */

function dot(running) {
  return textNode('span', '', running ? 'dot running' : 'dot');
}

function capabilitiesOf(device, agent) {
  if (!device || !device.capabilities || typeof device.capabilities !== 'object') return null;
  var doc = device.capabilities[agent];
  return doc && typeof doc === 'object' ? doc : null;
}

function evaluateWriteState(device, row) {
  if (barrierBlocked) { writeReason = '状态未知、暂不可答'; return 'unknown'; }
  if (unknownDevices[device.id]) { writeReason = '状态未知、暂不可答'; return 'unknown'; }
  if (device.syncing === true) { writeReason = '正在同步'; return 'stale'; }
  if (device.stale === true) { writeReason = '会话索引已过期'; return 'stale'; }
  var caps = capabilitiesOf(device, row.agent);
  if (caps === null) { writeReason = '能力未知'; return 'unknown'; }
  if (caps.stale === true) { writeReason = '能力已过期'; return 'stale'; }
  if (row.running === true) { writeReason = '会话忙碌'; return 'busy'; }
  // 契约 §7 的已验证写权是 ours；适配器未验证写权时保持只读。
  if (caps.ownership !== 'ours' && caps.ownership !== 'ours-idle') {
    writeReason = caps.ownership === 'foreign-running' ? '外部写者运行中' : '所有权未确认';
    return caps.ownership === 'foreign-running' ? 'busy' : 'unknown';
  }
  var operations = Array.isArray(caps.operations) ? caps.operations : [];
  if (operations.indexOf('prompt') < 0) { writeReason = '不支持写入'; return 'unknown'; }
  writeReason = '';
  return 'ready';
}

function applyWriteState() {
  var disabled = writeState !== 'ready';
  sendForm.querySelector('button').disabled = disabled;
  textInput.disabled = disabled;
  if (disabled && writeReason) setStatus('写入已禁用：' + writeReason);
}

async function refreshDevices() {
  var response;
  try { response = await request('/marshal/api/devices', { method: 'GET' }); } catch (error) { return null; }
  if (!response.ok) {
    if (response.status === 401) showLogin('会话已失效');
    return null;
  }
  var data;
  try { data = await response.json(); } catch (error) { return null; }
  if (!data || !Array.isArray(data.devices)) return null;
  clearNode(devicesRoot);
  for (var index = 0; index < data.devices.length; index += 1) {
    var device = data.devices[index];
    if (!device || typeof device.id !== 'string') continue;
    if (unknownDevices[device.id]) device.stale = true;
    devicesRoot.append(textNode('div', device.name + ' (' + device.id + ')', 'group'));
    if (!Array.isArray(device.agents)) continue;
    for (var a = 0; a < device.agents.length; a += 1) {
      var agent = device.agents[a];
      var row = textNode('div', '', 'row');
      if (current !== null && current.deviceId === device.id && current.agent === agent) row.classList.add('active');
      row.append(dot(false), document.createTextNode(agent));
      row.onclick = selectAgent(device, agent, row);
      devicesRoot.append(row);
    }
  }
  if (current !== null) {
    var found = findDevice(data, current.deviceId);
    if (found !== null) {
      writeState = evaluateWriteState(found, currentRow || { agent: current.agent, running: false });
      applyWriteState();
    }
  }
  return data;
}

function findDevice(data, deviceId) {
  if (!data || !Array.isArray(data.devices)) return null;
  for (var index = 0; index < data.devices.length; index += 1) {
    if (data.devices[index] && data.devices[index].id === deviceId) return data.devices[index];
  }
  return null;
}

function selectAgent(device, agent, row) {
  return function() {
    for (var other of devicesRoot.querySelectorAll('.row')) other.classList.remove('active');
    row.classList.add('active');
    loadSessions(device.id, agent, device);
  };
}

async function loadSessions(deviceId, agent, device) {
  // 换设备/agent 后旧选中不再属于当前列表，先作废并释放旧订阅。
  if (current !== null && (current.deviceId !== deviceId || current.agent !== agent)) {
    var previous = current;
    current = null;
    clearNode(cardsRoot);
    cardMap.clear();
    await releaseSubscription(previous);
  }
  var response;
  try {
    response = await request('/marshal/api/sessions?device=' + encodeURIComponent(deviceId), { method: 'GET' });
  } catch (error) { setStatus('加载会话失败'); return; }
  if (!response.ok) { setStatus('加载会话失败'); return; }
  var data;
  try { data = await response.json(); } catch (error) { return; }
  if (!data || !Array.isArray(data.sessions)) { setStatus('加载会话失败'); return; }
  clearNode(log);
  for (var index = 0; index < data.sessions.length; index += 1) {
    var rowData = data.sessions[index];
    if (!rowData || typeof rowData.sessionId !== 'string' || rowData.agent !== agent) continue;
    var row = textNode('div', '', 'row');
    row.append(dot(rowData.running), document.createTextNode(rowData.sessionId.slice(0, 8)));
    row.onclick = selectSession(device, rowData, row);
    log.append(row);
  }
}

function selectSession(device, rowData, row) {
  return async function() {
    if (current !== null && current.deviceId === device.id && current.agent === rowData.agent
      && current.sessionId === rowData.sessionId) return;
    var target = { deviceId: device.id, agent: rowData.agent, sessionId: rowData.sessionId };
    var previous = current;
    if (previous !== null) await releaseSubscription(previous);
    // 先切目标再发 subscribe：跟随事件可能先于 HTTP 响应到达 SSE。
    current = target;
    currentRow = rowData;
    clearNode(cardsRoot);
    cardMap.clear();
    lastSeq.delete(sessionKey(target));
    writeState = evaluateWriteState(device, rowData);
    applyWriteState();
    for (var other of log.querySelectorAll('.row')) other.classList.remove('active');
    row.classList.add('active');
    var body = await command('observe', { kind: 'follow', action: 'subscribe' }, target, true);
    if (body === null) { if (current === target) { current = previous; } return; }
    var result = body.result;
    if (result && typeof result.subscriptionId === 'string') {
      try { sessionStorage.setItem('marshal-sub:' + sessionKey(target), result.subscriptionId); } catch (error) {}
    }
    // 选择会话只 observe；待答卡来自只读快照，不触发任何原生动作。
    await loadInputs(target, device);
  };
}

async function releaseSubscription(target) {
  var key = 'marshal-sub:' + sessionKey(target);
  var subscriptionId = '';
  try { subscriptionId = sessionStorage.getItem(key) || ''; sessionStorage.removeItem(key); } catch (error) {}
  if (!subscriptionId) return;
  await command('observe', { kind: 'follow', action: 'unsubscribe', subscriptionId: subscriptionId }, target, true);
}

function releaseAll() {
  var keys = [];
  try {
    for (var index = 0; index < sessionStorage.length; index += 1) {
      var key = sessionStorage.key(index);
      if (key && key.indexOf('marshal-sub:') === 0) keys.push(key);
    }
  } catch (error) { return; }
  for (var i = 0; i < keys.length; i += 1) {
    var parts;
    try { parts = JSON.parse(keys[i].slice('marshal-sub:'.length)); } catch (error) { continue; }
    if (!Array.isArray(parts) || parts.length !== 3) continue;
    var subscriptionId = sessionStorage.getItem(keys[i]);
    sessionStorage.removeItem(keys[i]);
    if (!subscriptionId) continue;
    try {
      fetch('/marshal/api/command', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: writeHeaders(),
        body: JSON.stringify({
          op: 'observe',
          target: { deviceId: parts[0], agent: parts[1], sessionId: parts[2] },
          args: { kind: 'follow', action: 'unsubscribe', subscriptionId: subscriptionId },
          idempotencyKey: newKey(),
        }),
      });
    } catch (error) {}
  }
}
window.addEventListener('pagehide', releaseAll);

/* ---------------- 只读快照与卡片 ---------------- */

async function loadInputs(target, device) {
  var response;
  try {
    response = await request('/marshal/api/inputs', {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ target: target }),
    });
  } catch (error) { setStatus('待答状态未知、暂不可答'); return; }
  if (!response.ok) {
    setStatus(response.status === 202 || response.status === 503 ? '待答状态未知、暂不可答' : '加载待答失败');
    return;
  }
  var data;
  try { data = await response.json(); } catch (error) { return; }
  if (!data || !Array.isArray(data.cards)) return;
  var key = sessionKey(target);
  var high = typeof data.highWatermark === 'number' ? data.highWatermark : 0;
  lastSeq.set(key, Math.max(lastSeq.get(key) || 0, high));
  if (device) {
    writeState = evaluateWriteState(device, currentRow || { agent: target.agent, running: false });
    applyWriteState();
  }
  for (var index = 0; index < data.cards.length; index += 1) renderCard(data.cards[index], target);
}

function renderCard(card, target) {
  if (!card || typeof card.requestId !== 'string') return;
  var runtimeEpoch = typeof card.runtimeEpoch === 'string' ? card.runtimeEpoch : 'unknown';
  var key = cardKey(target, runtimeEpoch, card.requestId);
  var existing = cardMap.get(key);
  if (existing) return;
  var element = document.createElement('div');
  element.className = 'ask';
  element.dataset.requestId = card.requestId;
  var interactive = !barrierBlocked && card.kind === 'question' && card.acceptOnceEligible === true
    && card.ambiguous !== true && card.truncated !== true;
  // acceptOnceEligible 是 node 侧 relay=remote 与 hub allowInteractions 双授权后的结果；
  // 页面只按它渲染可答控件，最终仍由后端校验。
  var questions = Array.isArray(card.questions) ? card.questions : [];
  if (card.kind === 'approval' || card.approval) {
    element.append(textNode('div', '审批请求：仅本机可处理', 'reason'));
    interactive = false;
  }
  if (!interactive) {
    var why = barrierBlocked ? '状态未知、暂不可答' : (card.reason || '需在本机处理');
    element.append(textNode('div', '此卡不能远端作答（' + why + '）', 'reason'));
  }
  var seen = {};
  var controls = [];
  var selections = new Map();
  var submit = null;
  var busy = false;
  var questionNodes = [];

  for (var index = 0; index < questions.length; index += 1) {
    var question = questions[index];
    if (!question || typeof question.id !== 'string') continue;
    // 题目 ID 去重：重复 id 只渲染第一份，最终以后端 invalid 为准。
    if (seen[question.id]) continue;
    seen[question.id] = true;
    element.append(textNode('div', question.prompt || '[unavailable]'));
    var options = Array.isArray(question.options) ? question.options.filter(function(option) {
      return option && typeof option.id === 'string' && typeof option.label === 'string';
    }) : [];
    var buttons = [];
    var multi = question.multi === true;
    for (var o = 0; o < options.length; o += 1) {
      var option = options[o];
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.dataset.optionId = option.id;
      button.setAttribute('aria-pressed', 'false');
      if (!interactive) button.disabled = true;
      button.onclick = (function(questionId, optionId, group, multiSelect, optionButton) {
        return function() {
          if (busy || !interactive) return;
          var picked = new Set(multiSelect ? (selections.get(questionId) || []) : []);
          if (multiSelect && picked.has(optionId)) picked.delete(optionId);
          else picked.add(optionId);
          if (picked.size > 0) selections.set(questionId, picked); else selections.delete(questionId);
          var groupButtons = group;
          for (var g = 0; g < groupButtons.length; g += 1) {
            var active = picked.has(groupButtons[g].dataset.optionId);
            groupButtons[g].classList.toggle('picked', active);
            groupButtons[g].setAttribute('aria-pressed', active ? 'true' : 'false');
          }
          // 单选/必答只做提示；是否合法最终由后端 invalid 决定。
          setStatus('');
        };
      })(question.id, option.id, buttons, multi, button);
      buttons.push(button);
      element.append(button);
    }
    var customInput = null;
    if (question.custom === true && interactive) {
      customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.placeholder = '可补充文本';
      element.append(customInput);
    }
    if (question.required === true && options.length === 0 && question.custom !== true) {
      element.append(textNode('div', '必答但无可选项，需本机处理', 'reason'));
    }
    questionNodes.push({ id: question.id, multi: multi, custom: customInput, options: options });
    controls.push(question.id);
  }

  if (interactive && controls.length > 0) {
    submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '提交';
    submit.onclick = async function() {
      if (busy) return;
      busy = true;
      submit.disabled = true;
      var answers = [];
      for (var q = 0; q < questionNodes.length; q += 1) {
        var item = questionNodes[q];
        var answer = { id: item.id, selectedOptionIds: Array.from(selections.get(item.id) || []) };
        var text = item.custom ? item.custom.value.trim() : '';
        if (text !== '') answer.text = text;
        answers.push(answer);
      }
      var payload = { requestId: card.requestId, answers: answers };
      var key = newKey();
      var intent = {
        id: intentId(key, target, 'answer'), owner: origin + '|' + (session ? session.operatorId : ''),
        key: key, op: 'answer', target: target, status: 'pending', at: Date.now(),
      };
      var stored = await persistIntent(intent);
      if (!stored) {
        setStatus('持久存储不可用，拒绝发送');
        busy = false;
        submit.disabled = false;
        return;
      }
      var body = await command('answer', payload, target, false, key);
      if (body === null) {
        busy = false;
        submit.disabled = false;
        await updateIntent(intent.id, { status: 'unknown' });
        return;
      }
      await updateIntent(intent.id, { status: intentStatus(body) });
      if (body.status === 'rejected') {
        element.append(textNode('div', '拒绝：' + (body.code || 'invalid'), 'reason'));
      } else if (body.ok) {
        element.append(textNode('div', '已受理，等待源端确认', 'reason'));
      } else {
        element.append(textNode('div', '未确认（结果未知，先查状态，不自动重发）', 'reason'));
      }
    };
    element.append(submit);
  }
  cardsRoot.append(element);
  cardMap.set(key, { element: element, card: card, target: target });
}

function resolveCard(event, state) {
  var runtimeEpoch = typeof event.payload?.runtimeEpoch === 'string' ? event.payload.runtimeEpoch : 'unknown';
  var key = cardKey({ deviceId: event.deviceId, agent: event.agent, sessionId: event.sessionId },
    runtimeEpoch, String(event.payload?.requestId || ''));
  var entry = cardMap.get(key);
  if (!entry) {
    // runtimeEpoch 缺失时按 requestId 在同类卡片里兜底匹配。
    cardMap.forEach(function(value) {
      if (!entry && value.card.requestId === event.payload?.requestId) entry = value;
    });
  }
  if (!entry) return;
  var labels = {
    answered: '已由另一处回答',
    declined: '已拒绝',
    cancelled: 'DSH 已交回本地',
    expired: '已过期，交回本地',
    invalidated: '已失效（授权或代次变化）',
    failed: '未确认',
  };
  entry.element.textContent = labels[state] || '已结束（' + state + '）';
  cardMap.delete(key);
}

/* ---------------- 写入命令 ---------------- */

function intentStatus(body) {
  if (body && (body.ok || body.status === 'accepted' || body.status === 'confirmed')) return 'accepted';
  if (body && body.status === 'rejected') return 'rejected';
  return 'unknown';
}

function outcomeLabel(httpStatus, body) {
  if (body && body.status === 'rejected') return '拒绝：' + (body.code || 'invalid');
  if (httpStatus === 202) return '未确认（结果未知，先查状态，不自动重发）';
  if (body && (body.status === 'accepted' || body.status === 'confirmed')) return '已受理';
  return '已受理';
}

async function command(op, args, target, readonly, idempotencyKey) {
  var to = target || current;
  if (to === null) { setStatus('失败：请先选择会话'); return null; }
  var key = idempotencyKey || newKey();
  var response;
  try {
    response = await request('/marshal/api/command', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ op: op, target: to, args: args, idempotencyKey: key }),
    });
  } catch (error) {
    setStatus('失败：网络错误');
    return null;
  }
  if (!response.ok) {
    if (response.status === 401) { showLogin('会话已失效'); return null; }
    var message = 'HTTP ' + response.status;
    var body = null;
    try { body = await response.json(); } catch (error) {}
    if (body && typeof body.code === 'string') message += ' · ' + body.code;
    if (!readonly) setStatus('失败：' + message);
    return body;
  }
  try { return await response.json(); } catch (error) { return { ok: true }; }
}

/* ---------------- SSE ---------------- */

function closeStream() {
  if (stream !== null) { stream.close(); stream = null; }
}

function connectStream() {
  closeStream();
  stream = new EventSource('/marshal/api/stream');
  stream.addEventListener('reset', function(message) {
    var payload = {};
    try { payload = JSON.parse(message.data); } catch (error) {}
    onReset(payload);
  });
  stream.onmessage = function(message) {
    var event;
    try { event = JSON.parse(message.data); } catch (error) { return; }
    onEvent(event);
  };
  stream.onerror = function() {
    // 断线即禁止远端作答/正文发送；重连后的 reset 会按新屏障决定是否恢复。
    barrierBlocked = true;
    setStatus('SSE 断开，重连中…');
    // EventSource 看不到状态码；定期查一次会话，过期/登出后停止静默重连。
    if (Date.now() - lastAuthCheck < 5000) return;
    lastAuthCheck = Date.now();
    request(SESSION_PATH, { method: 'GET' }).then(function(response) {
      if (response.status === 401) showLogin('会话已失效');
    }).catch(function() {});
  };
}

async function onReset(payload) {
  var generation = ++rebuildGeneration;
  rebuilding = true;
  queuedEvents.length = 0;
  barrierBlocked = payload.complete === false;
  // reset-required：先丢弃本地时间线和卡片，再按索引/能力/待答快照重建。
  clearNode(cardsRoot);
  clearNode(log);
  cardMap.clear();
  lastSeq.clear();
  unknownDevices = {};
  if (Array.isArray(payload.degradedDevices)) {
    for (var index = 0; index < payload.degradedDevices.length; index += 1) {
      unknownDevices[payload.degradedDevices[index]] = true;
    }
  }
  if (barrierBlocked) setStatus('状态未知、暂不可答（SSE 屏障未完成）');
  else setStatus('');
  var data = null;
  if (session !== null) {
    data = await refreshDevices();
    if (session === null) { rebuilding = false; queuedEvents.length = 0; return; }
    if (current !== null) {
      var device = findDevice(data, current.deviceId);
      await loadSessions(current.deviceId, current.agent, device);
      await loadInputs(current, device);
    }
  }
  // 更新的 reset 已接管：由它清空并重建，本轮暂存作废。
  if (generation !== rebuildGeneration) return;
  rebuilding = false;
  var queued = queuedEvents.splice(0);
  for (var q = 0; q < queued.length; q += 1) onEvent(queued[q]);
  if (current !== null && data !== null) {
    var found = findDevice(data, current.deviceId);
    if (found !== null) {
      writeState = evaluateWriteState(found, currentRow || { agent: current.agent, running: false });
      applyWriteState();
    }
  }
}

function onEvent(event) {
  if (!event) return;
  // 重建期间先有界暂存，避免被 loadSessions/loadInputs 的清空覆盖。
  if (rebuilding) {
    if (queuedEvents.length >= MAX_QUEUED_EVENTS) {
      barrierBlocked = true;
      queuedEvents.length = 0;
    } else {
      queuedEvents.push(event);
    }
    return;
  }
  if (current === null) return;
  // 同一 sessionId 在不同 agent 下不是同一条会话，必须连 agent 一起比对。
  if (event.deviceId !== current.deviceId || event.agent !== current.agent
    || event.sessionId !== current.sessionId) return;
  var key = sessionKey(current);
  if (typeof event.seq === 'number') {
    var previous = lastSeq.get(key) || 0;
    if (event.seq <= previous) return;
    lastSeq.set(key, event.seq);
  }
  var payload = event.payload || {};
  if (event.kind === 'input.requested') {
    if (unknownDevices[event.deviceId]) { setStatus('状态未知、暂不可答'); return; }
    renderCard(payload, current);
    return;
  }
  if (event.kind === 'input.resolved') {
    resolveCard(event, typeof payload.state === 'string' ? payload.state : 'failed');
    return;
  }
  var node;
  if (event.kind === 'reasoning.delta') {
    node = textNode('div', payload.redacted ? '（思考 ' + payload.chars + ' 字，metadata 档）' : payload.text, 'reason');
  } else if (event.kind === 'message.delta') {
    node = textNode('div', payload.redacted ? '（回复 ' + payload.chars + ' 字，metadata 档）' : payload.text);
  } else if (event.kind === 'message.completed') {
    node = textNode('div', '消息完成', 'reason');
  } else if (event.kind === 'tool.started') {
    node = textNode('div', '▶ ' + (payload.name || payload.tool || 'tool'), 'tool');
  } else if (event.kind === 'tool.completed') {
    node = textNode('div', (payload.isError ? '✗ ' : '✓ ') + (payload.redacted ? payload.chars + ' 字' : String(payload.content || '').slice(0, 400)), 'tool');
  } else if (event.kind === 'turn.started') {
    node = textNode('div', '回合开始', 'reason');
  } else if (event.kind === 'turn.completed') {
    node = textNode('div', '回合完成（' + (payload.state || 'completed') + '）', 'reason');
  } else {
    return;
  }
  appendLog(node);
}

/* ---------------- 发送 ---------------- */

sendForm.onsubmit = async function(event) {
  event.preventDefault();
  if (current === null) { setStatus('失败：请先选择会话'); return; }
  if (writeState !== 'ready') { setStatus('写入已禁用：' + (writeReason || '状态未知')); return; }
  var text = textInput.value.trim();
  if (!text) return;
  var target = current;
  var key = newKey();
  var intent = {
    id: intentId(key, target, 'prompt'), owner: origin + '|' + (session ? session.operatorId : ''),
    key: key, op: 'prompt', target: target, status: 'pending', at: Date.now(),
  };
  // 先持久化再发送；存储不可用时拒绝新写。
  var stored = await persistIntent(intent);
  if (!stored) { setStatus('持久存储不可用，拒绝发送'); return; }
  textInput.value = '';
  var body = await command('prompt', { text: text }, target, false, key);
  if (body === null) {
    await updateIntent(intent.id, { status: 'unknown' });
    return;
  }
  var label = outcomeLabel(body.status === 'rejected' ? 200 : (body.ok ? 200 : 202), body);
  setStatus(label);
  await updateIntent(intent.id, { status: intentStatus(body) });
  reconcilePending();
};

applyWriteState();
restore();
setInterval(function() { if (session !== null) refreshDevices(); }, 5000);
try {
  var channel = new BroadcastChannel('marshal-intents');
  channel.onmessage = function() { if (session !== null) reconcilePending(); };
} catch (error) {}
</script></body></html>`
