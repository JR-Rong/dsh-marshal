import { NATIVE_BRIDGE_CSS, NATIVE_BRIDGE_SCRIPT } from "./native-bridge.js";
import { DISCUSSION_CSS, DISCUSSION_HTML, DISCUSSION_SCRIPT } from "./discussions/page.js";
/**
 * 页面是静态模板：所有来自设备/会话/事件的数据都经 textContent 写入，
 * 不拼 HTML 字符串，也不在模板里插入任何服务端值。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>调度官 · 跨设备会话管理</title>
<style>
  :root { color-scheme:dark; --bg:#151517; --rail:#1b1a1f; --surface:#232228; --hover:#2b2a30; --line:#302f36; --text:#e9e7e4; --muted:#9b97a0; --accent:#8ab4f8; --accent-ink:#0f172a; --selected:#252a36; --warning:#e1ae68; --danger:#ee9693; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; height:100vh; }
  [hidden] { display:none !important; }
  h1,h2,h3,p { margin:0; }
  button,input,select { font:inherit; }
  button { border:1px solid var(--line); border-radius:8px; padding:8px 14px; background:var(--surface); color:var(--text); cursor:pointer; transition:background .15s,border-color .15s; }
  button:hover:not(:disabled) { background:var(--hover); border-color:var(--muted); }
  button:disabled { cursor:not-allowed; opacity:.45; }
  button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  input,select { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:var(--bg); color:var(--text); min-width:0; }
  input::placeholder { color:var(--muted); }
  .primary { background:#e9e7e4; border-color:#e9e7e4; color:#151517; font-weight:600; }
  .primary:hover:not(:disabled) { background:#f5f3f0; border-color:#f5f3f0; }
  .muted,.reason { color:var(--muted); }
  .reason { white-space:pre-wrap; overflow-wrap:anywhere; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand svg { color:var(--accent); flex-shrink:0; }
  .brand h1 { font-size:20px; letter-spacing:-.03em; font-weight:650; }
  .brand p { color:var(--muted); font-size:12px; }
  #loginView { max-width:432px; margin:clamp(48px,12vh,140px) auto; padding:24px; }
  #loginView .brand { margin-bottom:30px; }
  #loginView .brand h1 { font-size:26px; }
  .login-box { padding:26px; border:1px solid var(--line); border-radius:14px; background:var(--rail); }
  .login-box h2 { font-size:18px; font-weight:600; margin-bottom:22px; }
  #loginForm { display:flex; flex-direction:column; gap:10px; }
  #loginForm label { color:var(--muted); font-size:13px; }
  #loginForm input,#loginForm button { width:100%; min-height:44px; }
  #loginForm button { margin-top:8px; }
  .login-help { margin-top:16px; color:var(--muted); font-size:12px; }
  #loginStatus { margin-top:12px; color:var(--danger); }
  #appView { display:flex; flex-direction:column; height:100vh; height:100dvh; }
  .app-header { min-height:64px; padding:12px 24px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); background:var(--rail); gap:20px; }
  .account { display:flex; align-items:center; gap:16px; }
  #who { color:var(--muted); font-size:12px; }
  .workspace { display:grid; grid-template-columns:208px 232px minmax(0,1fr); flex:1; min-height:0; }
  .device-rail,.session-rail { min-width:0; border-right:1px solid var(--line); overflow:auto; }
  .device-rail { background:var(--rail); padding:20px 12px; }
  .rail-label { font-size:12px; color:var(--muted); font-weight:500; padding:0 10px 12px; }
  .device-group + .device-group { border-top:1px solid var(--line); margin-top:18px; padding-top:18px; }
  .device-inventory { color:var(--muted); font-size:11px; line-height:1.55; padding:2px 6px 6px; }
  .device-heading { padding:0 10px 10px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .device-heading strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .device-state { font-size:11px; color:var(--muted); flex-shrink:0; }
  .device-state.online { color:var(--accent); }
  .row { display:flex; align-items:center; width:100%; text-align:left; border:1px solid transparent; background:transparent; padding:10px 12px; border-radius:8px; gap:10px; }
  .row:hover:not(:disabled) { background:var(--hover); border-color:transparent; }
  .row.active { background:var(--selected); color:var(--accent); border-color:transparent; }
  .row.active:hover:not(:disabled) { background:var(--selected); }
  .agent-symbol { width:20px; font:600 12px/20px ui-monospace,monospace; color:var(--muted); text-align:center; }
  .row.active .agent-symbol { color:var(--accent); }
  .session-rail { padding:22px 12px; }
  .session-heading { padding:0 10px 18px; }
  .session-heading h2 { font-size:16px; font-weight:600; margin-bottom:5px; }
  #sessionCount { margin-left:8px; padding:2px 7px; border-radius:5px; background:var(--surface); color:var(--muted); font-size:11px; vertical-align:middle; }
  .session-heading p { font-size:12px; color:var(--muted); }
  .session-row { align-items:flex-start; margin-bottom:3px; padding:12px 10px; }
  .session-copy { min-width:0; flex:1; }
  .session-name { display:block; font:500 13px/1.5 ui-monospace,monospace; color:var(--text); overflow:hidden; text-overflow:ellipsis; }
  .session-time { display:block; color:var(--muted); font-size:11px; margin-top:4px; }
  .session-state { color:var(--muted); font-size:11px; margin-left:auto; white-space:nowrap; }
  .session-row .dot { margin-top:6px; }
  .session-row.active .session-state { color:var(--accent); }
  .empty-list { padding:10px; color:var(--muted); font-size:12px; line-height:1.8; }
  #sessions:empty::before { content:'选择设备下的智能体，查看会话。'; display:block; padding:10px; color:var(--muted); font-size:12px; }
  main { display:flex; flex-direction:column; min-width:0; min-height:0; padding:26px 28px 18px; }
  .session-header { padding-bottom:22px; }
  #sessionTitle { font-size:23px; font-weight:600; letter-spacing:-.035em; }
  #sessionSubtitle { color:var(--muted); font-size:13px; margin-top:4px; }
  #status { padding:10px 14px; margin-bottom:14px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--muted); font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
  #status:empty { display:none; }
  #status.warning { color:var(--warning); }
  #status.success { color:var(--accent); }
  #capability { max-height:42vh; overflow:auto; flex-shrink:0; }
  #capability:empty { display:none; }
  details { border:1px solid var(--line); border-radius:9px; background:var(--surface); margin-bottom:10px; }
  summary { padding:11px 14px; cursor:pointer; color:var(--text); font-size:13px; }
  .detail-body { padding:0 14px 12px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
  #capability .tunable { display:grid; gap:6px; border-top:1px solid var(--line); padding:12px 0; }
  #capability .tunable label { display:block; font-size:12px; color:var(--text); }
  #capability select,#capability input[type=text] { display:block; width:100%; font-size:13px; }
  #capability button { justify-self:start; font-size:12px; }
  .ownership { color:var(--muted); font-size:12px; margin-bottom:12px; }
  .ownership button { margin-left:12px; }
  .timeline-label { font-size:12px; color:var(--muted); margin:16px 0 12px; }
  #log { flex:1; min-height:96px; overflow:auto; padding:0 6px 20px 0; }
  #log:empty::before { content:'选择一个会话，查看最新动态'; display:block; padding:48px 0; color:var(--muted); text-align:center; font-size:13px; }
  #log.selected:empty::before { content:'正在等待新的会话动态'; }
  .event { border-left:1px solid var(--line); margin-left:5px; padding:0 0 18px 20px; position:relative; font-size:13px; overflow-wrap:anywhere; }
  .event::before { content:''; position:absolute; width:7px; height:7px; border-radius:50%; background:var(--accent); left:-4px; top:6px; }
  .event time { display:block; font-size:11px; color:var(--muted); margin-bottom:3px; }
  .event .reason { color:var(--text); }
  .tool { padding:8px 10px; border:1px solid var(--line); border-radius:7px; font-family:ui-monospace,monospace; font-size:12px; white-space:pre-wrap; }
  #cards { max-height:40vh; overflow:auto; flex-shrink:0; }
  .ask { border:1px solid var(--warning); border-radius:10px; padding:14px; margin:8px 0; background:var(--surface); }
  .ask button { margin:8px 6px 0 0; font-size:13px; }
  .ask button.picked { border-color:var(--accent); background:var(--selected); }
  .ask input[type=text] { width:100%; margin-top:10px; }
  #send { display:flex; gap:10px; padding:10px; border:1px solid var(--line); border-radius:11px; background:var(--surface); flex-shrink:0; }
  #send input { flex:1; border:0; background:transparent; padding:8px; }
  #send button { min-width:72px; }
  .privacy-note { margin:9px 0 0; font-size:11px; color:var(--muted); }
  #pendingPanel { margin-top:24px; background:transparent; }
  #pendingPanel summary { color:var(--warning); font-size:12px; }
  #pending div { font-size:11px; color:var(--muted); padding:0 12px 12px; overflow-wrap:anywhere; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--muted); flex-shrink:0; }
  .dot.running { background:var(--accent); }
  .desktop-embed .app-header { min-height:48px; padding:10px 22px; }
  .desktop-embed .app-header .brand h1,.desktop-embed .app-header .brand svg { display:none; }
  .desktop-embed .app-header .brand p { font-size:12px; }
  @media (prefers-color-scheme:light) {
    :root { color-scheme:light; --bg:#fff; --rail:#f7f8f9; --surface:#f1f3f4; --hover:#e8ecef; --line:#dde2e6; --text:#20262c; --muted:#67727d; --accent:#238361; --accent-ink:#fff; --selected:#e2f1eb; --warning:#936018; --danger:#b6413e; }
    .primary:hover:not(:disabled) { background:#196b4d; border-color:#196b4d; }
  }
  @media (max-width:1040px) { .workspace { grid-template-columns:180px 200px minmax(0,1fr); } main { padding:22px 20px 16px; } .account #who { display:none; } }
  @media (max-width:720px) {
    body,#appView { height:auto; min-height:100vh; }
    .app-header { padding:14px 16px; }.app-header .brand p { display:none; }
    .workspace { display:flex; flex-direction:column; min-height:0; }
    .device-rail { padding:14px 12px; border-right:0; border-bottom:1px solid var(--line); }
    #devices { display:flex; gap:16px; overflow:auto; }
    .device-group { min-width:150px; flex:1; }
    .device-group + .device-group { border:0; margin:0; padding:0; }
    .row { padding:8px 10px; }
    .session-rail { border-right:0; border-bottom:1px solid var(--line); padding:16px 12px; max-height:240px; }
    .session-heading { padding-bottom:10px; }
    main { min-height:60vh; padding:22px 18px 18px; }
    #sessionTitle { font-size:21px; }
    #log { min-height:140px; max-height:50vh; }
    #capability { max-height:none; }
    .ask button,#send button,#capability button { min-height:40px; }
    #send input { width:0; }
    #pendingPanel { margin-top:12px; }
  }
  @media (prefers-reduced-motion:reduce) { button { transition:none; } }
${DISCUSSION_CSS}
${NATIVE_BRIDGE_CSS}
</style></head>
<body>
<div id="loginView" hidden>
  <div class="brand"><div><h1>调度官</h1><p>跨设备会话管理</p></div></div>
  <section class="login-box" aria-labelledby="loginHeading">
    <h2 id="loginHeading">连接调度中心</h2>
    <form id="loginForm">
      <label for="loginToken">管理令牌</label>
      <input id="loginToken" type="password" autocomplete="current-password" placeholder="输入管理令牌" required>
      <button class="primary">登录</button>
    </form>
    <p class="login-help" id="tokenHelp">令牌由管理服务生成，用于验证此设备的管理权限。</p>
    <div id="accountLogin" hidden><p class="login-help">使用当前 DeepSeek Harness 账号，进入你的设备与工作群。</p><button id="accountEnter" type="button" class="primary">使用 DSH 账号进入</button></div>
    <p class="reason" id="loginStatus" role="status" aria-live="polite"></p>
  </section>
</div>
<div id="appView" hidden>
  <header class="app-header">
    <div class="brand"><h1>调度官</h1><p>跨设备会话管理</p></div>
    <div class="mode-switch" aria-label="工作模式"><button id="singleMode" type="button" aria-pressed="true">单会话</button><button id="groupMode" type="button" aria-pressed="false">Agent 群聊</button></div>
    <div class="account"><div id="who"></div><button id="logout" type="button">退出登录</button></div>
  </header>
  <div class="workspace" id="singleWorkspace">
    <nav class="device-rail" aria-label="设备与智能体">
      <h2 class="rail-label">设备</h2><div id="devices">正在连接设备…</div>
      <h2 class="rail-label">手机</h2><div id="phones"></div>
      <details id="pendingPanel" hidden><summary>未决写入</summary><div id="pending"></div></details>
    </nav>
    <section class="session-rail" aria-label="会话列表">
      <div class="session-heading"><h2><span id="sessionListTitle">会话</span><span id="sessionCount" hidden></span></h2><p>最近更新的会话，按更新时间排序</p></div>
      <div id="sessions"><p class="empty-list">选择设备下的智能体，查看会话。</p></div>
    </section>
    <main>
      <header class="session-header"><h2 id="sessionTitle">尚未选择会话</h2><p id="sessionSubtitle">从左侧选择设备与会话，开始协作。</p></header>
      <div id="status" role="status" aria-live="polite"></div><div id="capability"></div><div id="cards"></div>
      <h3 class="timeline-label">会话消息</h3><div id="log" role="log" aria-label="会话事件" aria-live="polite"></div>
      <form id="send"><input id="text" aria-label="给选中会话发一条消息" placeholder="给选中会话发一条消息"><button class="primary">发送</button></form>
      <p class="privacy-note">状态与消息按设备授权同步。</p>
    </main>
  </div>
  ${DISCUSSION_HTML}
</div>
<script>
'use strict';
var SESSION_PATH = '/marshal/api/session';
var EVENTS_KEY = 'marshal-events';
var CSRF_COOKIE = '__Host-marshal-csrf';
var origin = location.origin;
var session = null;
var accountMode = false;
var accountGeneration = 0;
var current = null;
var currentRow = null;
var selectedAgent = null;
var stream = null;
var lastAuthCheck = 0;
var writeState = 'unknown';
var writeReason = '未选择会话';
var unknownDevices = {};
var barrierBlocked = true;
var rebuilding = false;
var rebuildGeneration = 0;
var queuedEvents = [];
var streamContinuity = null;
var MAX_QUEUED_EVENTS = 256;
var lastSeq = new Map();
var cardMap = new Map();
var devicesData = null;
var devicesRenderSignature = '';
var currentCapability = null;
var capabilityNotice = '';
var acquirePending = false;
var configuringField = null;
var loadToken = 0;
var selectionToken = 0;
var db = null;
var dbUnavailable = false;
var loginStatus = document.getElementById('loginStatus');
var statusRoot = document.getElementById('status');
var log = document.getElementById('log');
var cardsRoot = document.getElementById('cards');
var capabilityRoot = document.getElementById('capability');
var devicesRoot = document.getElementById('devices');
var sessionsRoot = document.getElementById('sessions');
var pendingRoot = document.getElementById('pending');
var sendForm = document.getElementById('send');
var textInput = document.getElementById('text');

${NATIVE_BRIDGE_SCRIPT}

function setStatus(text) {
  statusRoot.textContent = text || '';
  statusRoot.className = /失败|拒绝|未知|禁用|过期|断开/.test(text || '') ? 'warning' : 'success';
  nativeState();
}
function clearNode(node) { node.textContent = ''; if (node === log && messageNodes) messageNodes.clear(); }

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

function appendLog(node, timestamp) {
  var entry = textNode('div', '', 'event');
  var date = typeof timestamp === 'number' ? new Date(timestamp) : null;
  if (date !== null && Number.isFinite(date.getTime())) {
    var time = textNode('time', date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    time.dateTime = date.toISOString();
    entry.append(time);
  }
  entry.append(node);
  log.append(entry);
  log.scrollTop = log.scrollHeight;
}

// One bubble per streamed item; no body is written to browser storage.
var messageNodes = new Map();
var sendingPrompt = false;
function appendMessage(text, role, itemId, timestamp) {
  var key = sessionKey(current) + ':' + role + ':' + itemId;
  var body = messageNodes.get(key);
  if (!body) {
    var card = textNode('article', '', 'group-message ' + role);
    card.append(textNode('strong', role === 'user' ? '你' : role === 'reason' ? '思考' : current.agent));
    body = textNode('p', ''); card.append(body); appendLog(card, timestamp);
    messageNodes.set(key, body);
  }
  body.textContent += text;
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
  var count = 0;
  for (var index = 0; index < records.length; index += 1) {
    var record = records[index];
    if (record.status === 'accepted' || record.status === 'rejected') continue;
    count += 1;
    var label = INTENT_LABELS[record.status] || INTENT_LABELS.unknown;
    pendingRoot.append(textNode('div', record.op + ' · ' + record.target.sessionId + ' · ' + label));
  }
  document.getElementById('pendingPanel').hidden = count === 0;
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
  nativePost({ type: 'clear' });
  streamContinuity = null;
  resetGroups();
  closeStream();
  session = null;
  current = null;
  currentRow = null;
  selectedAgent = null;
  devicesData = null;
  devicesRenderSignature = '';
  selectionToken += 1;
  loadToken += 1;
  writeState = 'unknown';
  barrierBlocked = true;
  rebuilding = false;
  rebuildGeneration += 1;
  queuedEvents.length = 0;
  clearNode(cardsRoot);
  clearNode(log);
  clearNode(sessionsRoot);
  document.getElementById('sessionListTitle').textContent = '会话';
  document.getElementById('sessionCount').hidden = true;
  updateSessionHeading(null, null);
  clearCapability();
  cardMap.clear();
  lastSeq.clear();
  document.getElementById('appView').hidden = true;
  document.getElementById('loginView').hidden = false;
  loginStatus.textContent = message || '';
  var input = document.getElementById('loginToken');
  input.value = '';
  document.getElementById('loginForm').hidden = accountMode;
  document.getElementById('tokenHelp').hidden = accountMode;
  document.getElementById('accountLogin').hidden = !accountMode;
  if (!accountMode) input.focus();
}

function accountError(code) {
  return ({ 'account-required': '请先在 DeepSeek Harness 中登录账号', 'account-mismatch': '当前 DSH 账号不属于这个调度空间', 'rate-limited': '尝试过多，请稍后重试' })[code] || '账号连接暂不可用，请重试';
}
async function loginWithAccount(args) {
  if (!accountMode) return { ok: false };
  var generation = ++accountGeneration;
  if (typeof args?.ticket !== 'string') { showLogin(accountError(args?.code)); return { ok: false }; }
  loginStatus.textContent = '正在进入我的调度空间…';
  try {
    var response = await request('/marshal/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: args.ticket }) });
    if (!response.ok) throw Error('login');
    var data = await response.json();
    if (generation !== accountGeneration) return { ok: false };
    enterApp(data); nativeState(); return { ok: true };
  } catch (error) { if (generation === accountGeneration) showLogin('登录未完成，请重试'); return { ok: false }; }
}
async function logoutAccount(message) {
  accountGeneration++;
  var headers = session ? writeHeaders() : null;
  showLogin(message || '已退出');
  if (headers) { try { await request('/marshal/logout', { method: 'POST', headers: headers, body: '{}' }); } catch (error) {} }
}
document.getElementById('accountEnter').onclick = function() {
  if (!nativePort) { loginStatus.textContent = '请在 DeepSeek Harness 的调度官插件中进入'; return; }
  loginStatus.textContent = '正在验证 DSH 账号…'; nativePost({ type: 'account-needed' });
};

function enterApp(data) {
  session = data;
  document.getElementById('loginView').hidden = true;
  document.getElementById('appView').hidden = false;
  document.getElementById('who').textContent = data.account ? data.account.name + ' · ' + data.workspaceName : '已连接调度中心';
  document.getElementById('who').title = '管理身份：' + data.operatorId + ' · 登录到期：'
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
  if (!token) { loginStatus.textContent = '请输入管理令牌'; return; }
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
  await logoutAccount('已退出');
};

/* ---------------- 索引与选择 ---------------- */

function dot(running) {
  return textNode('span', '', running ? 'dot running' : 'dot');
}

function agentLabel(agent) { return agent === 'dsh' ? 'DSH' : agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : agent; }

function sessionName(row) { return row.title || (row.blank ? '新会话' : '未命名会话'); }

function shortSessionId(id) { return id.replace(/^session-/, '').slice(0, 8); }

function updateSessionHeading(device, row) {
  log.className = row ? 'selected' : '';
  document.getElementById('sessionTitle').textContent = row ? sessionName(row) : '尚未选择会话';
  document.getElementById('sessionSubtitle').textContent = row
    ? (device ? device.name : row.deviceId) + ' · ' + agentLabel(row.agent)
    : '从左侧选择设备与会话，开始协作。';
}

function selectRow(root, selected) {
  for (var other of root.querySelectorAll('.row')) {
    var active = other === selected;
    other.classList.toggle('active', active);
    other.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function capabilitiesOf(device, agent) {
  if (!device || !device.capabilities || typeof device.capabilities !== 'object') return null;
  var doc = device.capabilities[agent];
  return doc && typeof doc === 'object' ? doc : null;
}

/**
 * 只读选择与写权分离：写权只认源端能力文档，选择会话本身绝不移交写权。
 * capability 参数优先于设备列表里的 agent 级文档，页面从不自行推断 ownership。
 */
function evaluateWriteState(device, row, capability) {
  if (barrierBlocked) { writeReason = '状态未知、暂不可答'; return 'unknown'; }
  if (unknownDevices[device.id]) { writeReason = '状态未知、暂不可答'; return 'unknown'; }
  if (device.syncing === true) { writeReason = '正在同步'; return 'stale'; }
  if (device.stale === true) { writeReason = '会话索引已过期'; return 'stale'; }
  var caps = capability && typeof capability === 'object' ? capability : capabilitiesOf(device, row.agent);
  if (caps === null || caps === undefined) { writeReason = '能力未知'; return 'unknown'; }
  if (caps.stale === true) { writeReason = '能力已过期'; return 'stale'; }
  // 受管会话与已连接的原生运行时可写；未知状态仍关闭。
  if (caps.ownership === 'foreign-running') { writeReason = '外部写者运行中'; return 'busy'; }
  if (caps.ownership === 'unverified') { writeReason = '写权未确认（ownership-unverified）'; return 'unknown'; }
  if (caps.ownership !== 'ours' && caps.ownership !== 'attached') {
    var offered = Array.isArray(caps.operations) ? caps.operations : [];
    if (caps.ownership === 'foreign-unknown' && offered.indexOf('acquire') >= 0) {
      writeReason = '首次发送将自动接管并继续原会话';
    } else if (caps.ownership === 'foreign-unknown') {
      writeReason = '所有权未确认（ownership-unverified）';
    } else {
      writeReason = '所有权未确认';
    }
    return 'unknown';
  }
  if (row.running === true) { writeReason = '会话忙碌'; return 'busy'; }
  var operations = Array.isArray(caps.operations) ? caps.operations : [];
  if (operations.indexOf('prompt') < 0) { writeReason = '不支持写入'; return 'unknown'; }
  writeReason = '';
  return 'ready';
}

function applyWriteState() {
  var canAcquire = acquireEligible();
  var disabled = sendingPrompt || acquirePending || (writeState !== 'ready' && !canAcquire);
  sendForm.querySelector('button').disabled = disabled;
  sendForm.querySelector('button').textContent = canAcquire ? '接管并发送' : '发送';
  textInput.disabled = disabled;
  if (canAcquire && !disabled) { setStatus('首次发送将自动接管并继续原会话'); return; }
  if (disabled && writeReason) { setStatus('写入已禁用：' + writeReason); return; }
  // 只有之前那条“写入已禁用”提示可以清除；其它状态（错误/受理）不能被覆盖。
  if (statusRoot.textContent && statusRoot.textContent.indexOf('写入已禁用：') === 0) setStatus('');
  if (!statusRoot.textContent && !disabled) setStatus('可以发送消息');
  nativeState();
}

function deviceForCurrent() {
  if (current === null) return null;
  return findDevice(devicesData, current.deviceId);
}

/** 用当前能力文档重新评估写状态；设备列表只提供 syncing/stale 与兜底能力。 */
function evaluateCurrentWriteState() {
  if (current === null) return;
  var device = deviceForCurrent();
  if (device === null) { writeState = 'unknown'; writeReason = '能力未知'; applyWriteState(); return; }
  writeState = evaluateWriteState(device, currentRow || { agent: current.agent, running: false }, currentCapability);
  applyWriteState();
}

function updateCurrentRunning(running) {
  if (current === null || currentRow === null) return;
  currentRow.running = running;
  var key = sessionKey(current);
  for (var row of sessionsRoot.querySelectorAll('.row')) {
    if (row.dataset.sessionKey !== key) continue;
    var indicator = row.querySelector('.dot');
    var label = row.querySelector('.session-state');
    if (indicator) indicator.classList.toggle('running', running);
    if (label) label.textContent = running ? '运行中' : '空闲';
    break;
  }
  // 完成事件只更新运行状态，写权与同步屏障仍由原有能力检查决定。
  evaluateCurrentWriteState();
  nativeState();
}

var OWNERSHIP_LABELS = {
  ours: '可继续会话',
  attached: '已连接原生会话',
  'foreign-unknown': '尚未接管',
  'foreign-running': '外部写者运行中（foreign-running）',
  unverified: '写权未验证（unverified）',
};

function formatValue(value) {
  if (typeof value === 'string') return value;
  try {
    var text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch (error) {
    return String(value);
  }
}

/** 只读刷新时忽略每次读取都会变的 readAt，避免无谓重渲染清空用户选择。 */
function capabilityDigest(document) {
  if (!document || typeof document !== 'object') return '';
  try {
    var copy = {};
    for (var key in document) {
      if (key === 'readAt') continue;
      copy[key] = document[key];
    }
    return JSON.stringify(copy);
  } catch (error) {
    return '';
  }
}

/** 取得写权只对“能力声明 acquire 且 ownership 未取得”的当前会话开放。 */
function acquireEligible() {
  if (currentRow?.running === true || acquirePending || current === null || currentCapability === null
    || typeof currentCapability !== 'object') return false;
  if (barrierBlocked || unknownDevices[current.deviceId]) return false;
  var device = deviceForCurrent();
  if (device === null || device.syncing === true || device.stale === true) return false;
  if (currentCapability.ownership !== 'foreign-unknown') return false;
  var operations = Array.isArray(currentCapability.operations) ? currentCapability.operations : [];
  return operations.indexOf('acquire') >= 0;
}

function clearCapability() {
  currentCapability = null;
  capabilityNotice = '';
  acquirePending = false;
  if (capabilityRoot) clearNode(capabilityRoot);
}

function renderCapability() {
  var settingsOpen = capabilityRoot.querySelector('[data-section="settings"]')?.open === true;
  var diagnosticsOpen = capabilityRoot.querySelector('[data-section="diagnostics"]')?.open === true;
  clearNode(capabilityRoot);
  if (current === null) return;
  if (currentCapability === null || typeof currentCapability !== 'object') {
    capabilityRoot.append(textNode('div', '能力未知', 'reason'));
    return;
  }
  var capability = currentCapability;
  var ownership = textNode('div', '', 'ownership');
  if (typeof capability.ownership === 'string') {
    ownership.append(textNode('span', '所有权：' + (OWNERSHIP_LABELS[capability.ownership] || capability.ownership)));
  }
  capabilityRoot.append(ownership);
  if (capability.pending && typeof capability.pending === 'object') {
    var pendingStatus = capability.pending.status;
    var label = pendingStatus === 'readback-timeout' ? '回读超时（未自动重试）'
      : pendingStatus === 'pending' ? '回读确认中' : '';
    if (label !== '') {
      var field = typeof capability.pending.field === 'string' ? capability.pending.field : '';
      capabilityRoot.append(textNode('div', '待回读：' + field + ' · ' + label, 'reason'));
    }
  }
  if (capabilityNotice) capabilityRoot.append(textNode('div', capabilityNotice, 'reason'));
  if (acquireEligible()) {
    var acquire = document.createElement('button');
    acquire.type = 'button';
    acquire.textContent = '接管并继续';
    acquire.onclick = function() { acquireWrite(); };
    ownership.append(acquire);
    capabilityRoot.append(textNode('div', '恢复原会话及上下文，不会停止其他窗口；请避免同时向同一会话发送消息。', 'reason'));
  }
  var tunables = Array.isArray(capability.tunables) ? capability.tunables : [];
  var settings = document.createElement('details');
  settings.dataset.section = 'settings';
  settings.open = settingsOpen;
  settings.append(textNode('summary', '会话设置'));
  var settingsBody = textNode('div', '', 'detail-body');
  settings.append(settingsBody);
  for (var index = 0; index < tunables.length; index += 1) {
    var tunable = tunables[index];
    if (!tunable || typeof tunable !== 'object' || typeof tunable.id !== 'string') continue;
    renderTunable(capability, tunable, settingsBody);
  }
  if (tunables.length > 0) capabilityRoot.append(settings);
  var diagnostics = document.createElement('details');
  diagnostics.dataset.section = 'diagnostics';
  diagnostics.open = diagnosticsOpen;
  diagnostics.append(textNode('summary', '诊断信息'));
  var diagnosticBody = textNode('div', '', 'detail-body');
  diagnosticBody.append(textNode('div', '会话 ID：' + current.sessionId));
  if (typeof capability.runtimeEpoch === 'string' && capability.runtimeEpoch !== '') {
    diagnosticBody.append(textNode('div', '实例代次：' + capability.runtimeEpoch));
  }
  if (Number.isInteger(capability.settingsRevision)) {
    diagnosticBody.append(textNode('div', '设置修订：' + String(capability.settingsRevision)));
  }
  diagnostics.append(diagnosticBody);
  capabilityRoot.append(diagnostics);
}

/**
 * 每个可编辑设置一个控件和“应用”；不回写 current，只把用户输入作为新值发送。
 * 值为枚举时用 select，goal 用文本框，其余没有可靠输入形态就不渲染控件。
 */
function renderTunable(capability, tunable, container) {
  var target = current;
  if (target === null) return;
  var row = document.createElement('div');
  row.className = 'tunable';
  row.append(textNode('label', tunable.id));
  if (tunable.current !== undefined) row.append(textNode('div', formatValue(tunable.current)));
  if (tunable.editable !== true) {
    if (typeof tunable.reason === 'string' && tunable.reason !== '') {
      row.append(textNode('div', '不可编辑：' + tunable.reason, 'reason'));
    }
    container.append(row);
    return;
  }
  var revisionReady = typeof capability.runtimeEpoch === 'string' && capability.runtimeEpoch !== ''
    && Number.isInteger(capability.settingsRevision);
  var control = null;
  var values = Array.isArray(tunable.values) ? tunable.values.filter(function(value) {
    return value && typeof value.id === 'string' && typeof value.label === 'string';
  }) : [];
  if (values.length > 0) {
    control = document.createElement('select');
    for (var index = 0; index < values.length; index += 1) {
      var option = document.createElement('option');
      option.value = values[index].id;
      option.textContent = values[index].label;
      if (typeof tunable.current === 'string' && tunable.current === values[index].id) option.selected = true;
      control.append(option);
    }
    row.append(control);
  } else if (tunable.id === 'goal') {
    control = document.createElement('input');
    control.type = 'text';
    row.append(control);
  }
  if (control === null) {
    container.append(row);
    return;
  }
  var apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = '应用';
  if (!revisionReady) {
    apply.disabled = true;
    row.append(apply, textNode('div', '实例代次未知，不能配置', 'reason'));
  } else {
    apply.onclick = function() {
      // goal 的原生值是 { objective }；其它字段按控件原始值发送，由后端校验。
      var value = tunable.id === 'goal' ? { objective: control.value } : control.value;
      configureTunable(tunable, value, target);
    };
    row.append(apply);
  }
  container.append(row);
}

function configureLabel(body) {
  if (body && body.status === 'rejected') return '拒绝：' + (body.code || 'invalid');
  if (body && (body.status === 'pending-confirmation' || body.status === 'readback-timeout'
    || body.code === 'readback-timeout')) return '回读未确认，不自动重试';
  if (body && (body.ok || body.status === 'accepted' || body.status === 'confirmed')) return '已受理，等待源端回读';
  return '未确认（结果未知，先查状态，不自动重发）';
}

async function configureTunable(tunable, value, target) {
  // 同一时间只允许一笔配置在途，避免双击产生两个不同幂等键的重复写。
  if (configuringField !== null) return;
  if (target === null || current === null || sessionKey(current) !== sessionKey(target)) return;
  var capability = currentCapability;
  if (capability === null || typeof capability !== 'object'
    || typeof capability.runtimeEpoch !== 'string' || capability.runtimeEpoch === ''
    || !Number.isInteger(capability.settingsRevision)) {
    capabilityNotice = '实例代次未知，不能配置';
    renderCapability();
    return;
  }
  var expectedRevision = capability.runtimeEpoch + '#' + capability.settingsRevision;
  var key = newKey();
  var intent = {
    id: intentId(key, target, 'configure'), owner: origin + '|' + (session ? session.operatorId : ''),
    key: key, op: 'configure', target: target, status: 'pending', at: Date.now(),
  };
  configuringField = tunable.id;
  try {
    var stored = await persistIntent(intent);
    if (!stored) { setStatus('持久存储不可用，拒绝发送'); return; }
    if (current !== null && sessionKey(current) === sessionKey(target)) {
      // 明确提示“在途”，但绝不提前修改 current；超时也不自动重发。
      capabilityNotice = '配置 ' + tunable.id + '：已发送，等待源端回读';
      renderCapability();
    }
    var body = await command('configure', { expectedRevision: expectedRevision, field: tunable.id, value },
      target, false, key);
    if (body === null) {
      await updateIntent(intent.id, { status: 'unknown' });
      if (current !== null && sessionKey(current) === sessionKey(target)) {
        capabilityNotice = '配置 ' + tunable.id + '：未确认（结果未知，先查状态，不自动重发）';
        renderCapability();
      }
      return;
    }
    await updateIntent(intent.id, { status: intentStatus(body) });
    if (current === null || sessionKey(current) !== sessionKey(target)) return;
    // 只显示受理/拒绝状态；current 永远等源端 capability.changed 回读。
    capabilityNotice = '配置 ' + tunable.id + '：' + configureLabel(body);
    renderCapability();
    refreshCurrentCapability();
  } finally {
    configuringField = null;
  }
}

async function acquireWrite() {
  var target = current;
  if (target === null || !acquireEligible()) return;
  acquirePending = true;
  var key = newKey();
  var intent = {
    id: intentId(key, target, 'acquire'), owner: origin + '|' + (session ? session.operatorId : ''),
    key: key, op: 'acquire', target: target, status: 'pending', at: Date.now(),
  };
  var stored = await persistIntent(intent);
  if (!stored) {
    acquirePending = false;
    setStatus('持久存储不可用，拒绝发送');
    renderCapability();
    return;
  }
  if (current === target) {
    capabilityNotice = '正在恢复原会话，等待源端确认…';
    renderCapability();
  }
  var body = await command('acquire', {}, target, false, key);
  await updateIntent(intent.id, { status: body === null ? 'unknown' : intentStatus(body) });
  acquirePending = false;
  if (current !== target) return;
  var label = body === null ? '未确认（结果未知，先查状态，不自动重发）'
    : outcomeLabel(body.status === 'rejected' ? 200 : (body.ok ? 200 : 202), body);
  // 不乐观设置 ownership/writeState：只提示受理结果，等 capability.changed 或刷新。
  capabilityNotice = '接管会话：' + label;
  renderCapability();
  await refreshCurrentCapability();
  return current === target && writeState === 'ready';
}

/** 重新读取当前会话的能力文档；响应迟到时不覆盖更新的选择。 */
async function refreshCurrentCapability() {
  var target = current;
  if (target === null) return;
  var response;
  try {
    response = await request('/marshal/api/sessions?device=' + encodeURIComponent(target.deviceId), { method: 'GET' });
  } catch (error) { return; }
  if (!response.ok) return;
  var data;
  try { data = await response.json(); } catch (error) { return; }
  if (current !== target) return;
  if (!data || !Array.isArray(data.sessions)) return;
  var key = sessionKey(target);
  for (var index = 0; index < data.sessions.length; index += 1) {
    var rowData = data.sessions[index];
    if (!rowData || sessionKey({
      deviceId: rowData.deviceId, agent: rowData.agent, sessionId: rowData.sessionId,
    }) !== key) continue;
    var next = rowData.capability && typeof rowData.capability === 'object' ? rowData.capability : capabilitiesOf(deviceForCurrent(), target.agent);
    currentRow = rowData;
    var changed = capabilityDigest(next) !== capabilityDigest(currentCapability);
    currentCapability = next;
    if (changed) renderCapability();
    evaluateCurrentWriteState();
    return;
  }
}

function applyCapabilityDocument(document) {
  if (current === null) return;
  var next = document && typeof document === 'object' && !Array.isArray(document) ? document : null;
  if (next === null) return;
  // 旧文档（readAt 更小）或重复投递不能覆盖更新的能力/清空在编辑的控件。
  if (currentCapability !== null && typeof currentCapability === 'object'
    && Number.isInteger(next.readAt) && Number.isInteger(currentCapability.readAt)
    && next.readAt < currentCapability.readAt) return;
  var changed = capabilityDigest(next) !== capabilityDigest(currentCapability);
  currentCapability = next;
  if (!changed) { evaluateCurrentWriteState(); return; }
  capabilityNotice = '';
  renderCapability();
  evaluateCurrentWriteState();
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
  // 保留最近一次设备载荷：acquire 资格与 ownership 兜底都要看 syncing/stale。
  devicesData = data;
  var signature = JSON.stringify(data.devices.map(function(device) {
    return [device.id, device.name, device.agents, device.online, device.stale, device.syncing, !!unknownDevices[device.id]];
  }));
  // 常规状态刷新不重建未变化的导航，保留键盘焦点。
  if (signature === devicesRenderSignature) {
    if (current !== null) evaluateCurrentWriteState();
    return data;
  }
  devicesRenderSignature = signature;
  clearNode(devicesRoot);
  for (var index = 0; index < data.devices.length; index += 1) {
    var device = data.devices[index];
    if (!device || typeof device.id !== 'string') continue;
    if (unknownDevices[device.id]) device.stale = true;
    var group = textNode('section', '', 'device-group');
    var heading = textNode('div', '', 'device-heading');
    var name = textNode('strong', device.name || device.id);
    name.title = device.id;
    var online = device.online !== false && device.stale !== true && device.syncing !== true;
    heading.append(name, textNode('span', device.syncing === true ? '同步中' : online ? '在线' : '离线', online ? 'device-state online' : 'device-state'));
    var rename = textNode('button', '✎');
    rename.type = 'button'; rename.setAttribute('aria-label', '重命名设备 ' + (device.name || device.id));
    rename.style.cssText = 'padding:2px 5px;font-size:12px;border:0';
    rename.onclick = (function(item, section) { return function() {
      if (section.querySelector('form')) return;
      var form = document.createElement('form'); form.style.cssText = 'display:grid;gap:6px;padding:6px';
      var input = document.createElement('input'); input.value = item.name; input.maxLength = 80;
      input.setAttribute('aria-label', '新的设备名称'); input.style.minWidth = '0';
      var save = textNode('button', '保存名称'); save.type = 'submit';
      var cancel = textNode('button', '取消'); cancel.type = 'button'; cancel.onclick = function() { form.remove(); };
      form.append(input, save, cancel); section.prepend(form); input.focus(); input.select();
      form.onsubmit = async function(event) {
        event.preventDefault(); save.disabled = true;
        try {
          var response = await request('/marshal/api/device-name', { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ deviceId: item.id, name: input.value }) });
          if (!response.ok) throw Error('名称需为 1–80 个字符');
          form.remove(); devicesRenderSignature = ''; await refreshDevices(); nativeState();
        } catch (error) { setStatus(error.message); save.disabled = false; }
      };
    }; })(device, group);
    heading.append(rename);
    group.append(heading);
    if (device.inventory && Array.isArray(device.inventory.squads)) {
      var inventoryNames = [];
      for (var s = 0; s < device.inventory.squads.length; s += 1) {
        var squad = device.inventory.squads[s];
        if (!squad || !Array.isArray(squad.members)) continue;
        for (var m = 0; m < squad.members.length; m += 1) {
          if (squad.members[m] && typeof squad.members[m].name === 'string') inventoryNames.push(squad.members[m].name);
        }
      }
      if (inventoryNames.length > 0) group.append(textNode('p', '智能体：' + inventoryNames.join('、'), 'device-inventory'));
    }
    devicesRoot.append(group);
    if (!Array.isArray(device.agents)) continue;
    for (var a = 0; a < device.agents.length; a += 1) {
      var agent = device.agents[a];
      var row = textNode('button', '', 'row');
      row.type = 'button';
      var active = selectedAgent !== null && selectedAgent.deviceId === device.id && selectedAgent.agent === agent;
      if (active) row.classList.add('active');
      row.setAttribute('aria-pressed', active ? 'true' : 'false');
      row.setAttribute('aria-label', (device.name || device.id) + ' · ' + agentLabel(agent));
      row.append(textNode('span', agent === 'codex' ? '</>' : agent === 'claude' ? 'AI' : '>_', 'agent-symbol'), document.createTextNode(agentLabel(agent)));
      row.onclick = selectAgent(device, agent, row);
      group.append(row);
    }
  }
  if (data.devices.length === 0) devicesRoot.append(textNode('p', '暂无设备连接', 'empty-list'));
  renderPhones(data);
  if (current !== null) evaluateCurrentWriteState();
  return data;
}

function renderPhones(data) {
  var root = document.getElementById('phones');
  if (!root) return;
  clearNode(root);
  var phones = data && Array.isArray(data.phones) ? data.phones : [];
  if (phones.length === 0) { root.append(textNode('p', '没有配对的手机', 'empty-list')); return; }
  for (var index = 0; index < phones.length; index += 1) {
    var phone = phones[index];
    var row = textNode('div', '', 'row');
    row.append(textNode('span', phone.online ? '在线' : '离线', 'agent-symbol'), document.createTextNode(phone.name || phone.id));
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '吊销';
    button.onclick = (function(id) {
      return async function() {
        await request('/marshal/api/phones/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) });
        devicesRenderSignature = '';
        await refreshDevices();
      };
    })(phone.id);
    row.append(button);
    root.append(row);
  }
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
    selectRow(devicesRoot, row);
    loadSessions(device.id, agent, device);
  };
}

async function loadSessions(deviceId, agent, device) {
  // 单调加载令牌：旧响应晚到不能覆盖后发起的列表。
  var token = ++loadToken;
  selectedAgent = { deviceId: deviceId, agent: agent };
  document.getElementById('sessionListTitle').textContent = agentLabel(agent) + ' 会话';
  document.getElementById('sessionCount').hidden = true;
  // 换设备/agent 后旧选中不再属于当前列表，先作废并释放旧订阅。
  if (current !== null && (current.deviceId !== deviceId || current.agent !== agent)) {
    var previous = current;
    selectionToken += 1;
    current = null;
    currentRow = null;
    writeState = 'unknown';
    writeReason = '未选择会话';
    applyWriteState();
    clearCapability();
    clearNode(cardsRoot);
    clearNode(log);
    updateSessionHeading(null, null);
    cardMap.clear();
    await releaseSubscription(previous);
    if (token !== loadToken) return;
  }
  var response;
  try {
    response = await request('/marshal/api/sessions?device=' + encodeURIComponent(deviceId), { method: 'GET' });
  } catch (error) { setStatus('加载会话失败'); return; }
  if (token !== loadToken) return;
  if (!response.ok) { setStatus('加载会话失败'); return; }
  var data;
  try { data = await response.json(); } catch (error) { return; }
  if (token !== loadToken) return;
  if (!data || !Array.isArray(data.sessions)) { setStatus('加载会话失败'); return; }
  clearNode(sessionsRoot);
  var visible = data.sessions.filter(function(row) { return row && typeof row.sessionId === 'string' && row.agent === agent; });
  visible.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  document.getElementById('sessionCount').textContent = String(visible.length);
  document.getElementById('sessionCount').hidden = false;
  if (visible.length === 0) sessionsRoot.append(textNode('p', '这个智能体暂无会话。', 'empty-list'));
  for (var index = 0; index < visible.length; index += 1) {
    var rowData = visible[index];
    var row = textNode('button', '', 'row session-row');
    row.type = 'button';
    row.title = sessionName(rowData) + ' · ' + rowData.sessionId;
    row.dataset.sessionKey = sessionKey({ deviceId: deviceId, agent: agent, sessionId: rowData.sessionId });
    var active = current !== null && current.sessionId === rowData.sessionId && current.agent === agent && current.deviceId === deviceId;
    if (active) row.classList.add('active');
    row.setAttribute('aria-pressed', active ? 'true' : 'false');
    var copy = textNode('span', '', 'session-copy');
    copy.append(textNode('span', sessionName(rowData), 'session-name'));
    if (typeof rowData.updatedAt === 'number' && Number.isFinite(rowData.updatedAt) && rowData.updatedAt > 0) {
      copy.append(textNode('span', new Date(rowData.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 'session-time'));
    }
    row.append(dot(rowData.running), copy, textNode('span', rowData.running ? '运行中' : '空闲', 'session-state'));
    row.onclick = selectSession(device, rowData, row);
    sessionsRoot.append(row);
  }
}

function selectSession(device, rowData, row) {
  return async function() {
    if (current !== null && current.deviceId === device.id && current.agent === rowData.agent
      && current.sessionId === rowData.sessionId) return;
    // 选择令牌：任一 await 之后只有仍然是最新选择才允许应用状态。
    var token = ++selectionToken;
    var target = { deviceId: device.id, agent: rowData.agent, sessionId: rowData.sessionId };
    var previous = current;
    if (previous !== null) {
      await releaseSubscription(previous);
      if (token !== selectionToken) return;
    }
    // 先切目标再发 subscribe：跟随事件可能先于 HTTP 响应到达 SSE。
    current = target;
    currentRow = rowData;
    updateSessionHeading(device, rowData);
    clearNode(log);
    clearNode(cardsRoot);
    cardMap.clear();
    lastSeq.delete(sessionKey(target));
    currentCapability = rowData.capability && typeof rowData.capability === 'object' ? rowData.capability : capabilitiesOf(device, rowData.agent);
    capabilityNotice = '';
    renderCapability();
    evaluateCurrentWriteState();
    selectRow(sessionsRoot, row);
    nativeState();
    var body = await command('observe', { kind: 'follow', action: 'subscribe' }, target, true);
    if (token !== selectionToken) return;
    if (body === null) {
      if (current === target) {
        current = previous;
        currentRow = null;
        updateSessionHeading(null, null);
        clearCapability();
        renderCapability();
        evaluateCurrentWriteState();
      }
      return;
    }
    var result = body.result;
    if (result && typeof result.subscriptionId === 'string') {
      try { sessionStorage.setItem('marshal-sub:' + sessionKey(target), result.subscriptionId); } catch (error) {}
    }
    // 选择会话只 observe；待答卡来自只读快照，不触发任何原生动作。
    await loadInputs(target, device);
    if (token !== selectionToken) return;
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
  // 迟到的旧响应不得把卡片渲染进另一个会话。
  if (current === null || sessionKey(current) !== sessionKey(target)) return;
  var key = sessionKey(target);
  var high = typeof data.highWatermark === 'number' ? data.highWatermark : 0;
  lastSeq.set(key, Math.max(lastSeq.get(key) || 0, high));
  if (device) {
    writeState = evaluateWriteState(device, currentRow || { agent: target.agent, running: false }, currentCapability);
    applyWriteState();
  }
  for (var index = 0; index < data.cards.length; index += 1) renderCard(data.cards[index], target);
}

/** 任何“总是/记住/会话内/别再问”语义的审批选项都不得渲染，也不得发送。 */
function decisionIsSafe(decision) {
  if (!decision || typeof decision.id !== 'string' || typeof decision.label !== 'string') return false;
  var unsafe = /always|persist|remember|session|don'?t\\s*ask|总是|始终|会话内/i;
  return !unsafe.test(decision.id) && !unsafe.test(decision.label);
}

/**
 * 审批卡只呈现“这一次”的决定：每个安全 decision 一个按钮，一次点击一题答案，
 * 没有文本输入、没有多选、也没有会话级 allow 按钮。
 */
function renderApprovalCard(element, card, target, interactive) {
  var approval = card.approval && typeof card.approval === 'object' ? card.approval : null;
  var action = card.approval && typeof card.approval === 'object'
    && typeof card.approval.action === 'string' && card.approval.action !== ''
    ? card.approval.action : '审批请求';
  element.append(textNode('div', '审批：' + action));
  if (approval && typeof approval.detail === 'string' && approval.detail !== '') {
    element.append(textNode('div', approval.detail, 'tool'));
  }
  var raw = approval && Array.isArray(approval.decisions) ? approval.decisions : [];
  var decisions = raw.filter(decisionIsSafe);
  if (!interactive || decisions.length === 0) {
    var why = !interactive
      ? (barrierBlocked ? '状态未知、暂不可答' : (card.reason || '需在本机处理'))
      : '没有可安全表达的本机决定';
    element.append(textNode('div', '此卡不能远端作答（' + why + '）', 'reason'));
    return;
  }
  var buttons = [];
  var busy = false;
  for (var index = 0; index < decisions.length; index += 1) {
    (function(decision) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = decision.label;
      button.onclick = async function() {
        if (busy) return;
        busy = true;
        for (var b = 0; b < buttons.length; b += 1) buttons[b].disabled = true;
        var key = newKey();
        var intent = {
          id: intentId(key, target, 'answer'), owner: origin + '|' + (session ? session.operatorId : ''),
          key: key, op: 'answer', target: target, status: 'pending', at: Date.now(),
        };
        var stored = await persistIntent(intent);
        if (!stored) {
          setStatus('持久存储不可用，拒绝发送');
          busy = false;
          for (var r = 0; r < buttons.length; r += 1) buttons[r].disabled = false;
          return;
        }
        var payload = { requestId: card.requestId, answers: [{ id: decision.id, selectedOptionIds: [] }] };
        var body = await command('answer', payload, target, false, key);
        if (body === null) {
          busy = false;
          await updateIntent(intent.id, { status: 'unknown' });
          for (var u = 0; u < buttons.length; u += 1) buttons[u].disabled = false;
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
      buttons.push(button);
      element.append(button);
    })(decisions[index]);
  }
}

function renderCard(card, target) {
  if (!card || typeof card.requestId !== 'string') return;
  // 卡片闭包固定使用创建时的完整 target，不读取可变的 current。
  var cardTarget = { deviceId: target.deviceId, agent: target.agent, sessionId: target.sessionId };
  var runtimeEpoch = typeof card.runtimeEpoch === 'string' ? card.runtimeEpoch : 'unknown';
  var key = cardKey(cardTarget, runtimeEpoch, card.requestId);
  var existing = cardMap.get(key);
  if (existing) return;
  var element = document.createElement('div');
  element.className = 'ask';
  element.dataset.requestId = card.requestId;
  // acceptOnceEligible 是 node 侧 relay=remote 与 hub allowInteractions 双授权后的结果；
  // 页面只按它渲染可答控件，最终仍由后端校验。
  var interactive = !barrierBlocked && card.acceptOnceEligible === true
    && card.ambiguous !== true && card.truncated !== true;
  if (card.kind === 'approval' || card.approval) {
    renderApprovalCard(element, card, cardTarget, interactive);
    cardsRoot.append(element);
    cardMap.set(key, { element: element, card: card, target: cardTarget });
    return;
  }
  var questions = Array.isArray(card.questions) ? card.questions : [];
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
        id: intentId(key, cardTarget, 'answer'), owner: origin + '|' + (session ? session.operatorId : ''),
        key: key, op: 'answer', target: cardTarget, status: 'pending', at: Date.now(),
      };
      var stored = await persistIntent(intent);
      if (!stored) {
        setStatus('持久存储不可用，拒绝发送');
        busy = false;
        submit.disabled = false;
        return;
      }
      var body = await command('answer', payload, cardTarget, false, key);
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
  cardMap.set(key, { element: element, card: card, target: cardTarget });
}

function resolveCard(event, state) {
  var target = { deviceId: event.deviceId, agent: event.agent, sessionId: event.sessionId };
  var targetKey = sessionKey(target);
  var runtimeEpoch = typeof event.payload?.runtimeEpoch === 'string' ? event.payload.runtimeEpoch : 'unknown';
  var requestId = String(event.payload?.requestId || '');
  var key = cardKey(target, runtimeEpoch, requestId);
  var entry = cardMap.get(key);
  var matchedKey = key;
  if (!entry) {
    // 代次缺失/不一致时只在同一完整 target 内按 requestId 兜底。
    cardMap.forEach(function(value, mapKey) {
      if (entry || sessionKey(value.target) !== targetKey || value.card.requestId !== requestId) return;
      entry = value;
      matchedKey = mapKey;
    });
  }
  // 未知键（重复/过期终态）直接忽略，不影响其它会话的卡片。
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
  cardMap.delete(matchedKey);
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
  var nextContinuity = { hubEpoch: payload.hubEpoch, devices: payload.continuity || {} };
  var oldDevice = current && streamContinuity && streamContinuity.devices[current.deviceId];
  var newDevice = current && nextContinuity.devices[current.deviceId];
  var keepMessages = payload.complete === true && streamContinuity && typeof payload.hubEpoch === 'string'
    && streamContinuity.hubEpoch === payload.hubEpoch && oldDevice && newDevice
    && typeof newDevice.nodeEpoch === 'string' && Number.isInteger(newDevice.purge)
    && oldDevice.nodeEpoch === newDevice.nodeEpoch && oldDevice.purge === newDevice.purge;
  streamContinuity = nextContinuity;
  var generation = ++rebuildGeneration;
  rebuilding = true;
  queuedEvents.length = 0;
  // 换代后旧的列表/选择/能力响应都不再可信。
  loadToken += 1;
  selectionToken += 1;
  barrierBlocked = payload.complete === false;
  // Rebuild authorization on every reset. Preserve already displayed messages
  // only when the Hub proves node identity and content-purge generation match.
  clearNode(cardsRoot);
  if (!keepMessages) { clearNode(log); nativePost({ type: 'clear' }); }
  cardMap.clear();
  if (!keepMessages) lastSeq.clear();
  if (keepMessages && payload.replay && payload.replay.gap) appendLog(textNode('div', '连接已恢复，中断期间可能有消息未同步。', 'reason'), Date.now());
  clearCapability();
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
    // 事件可能已给出新能力；再读一次当前会话的能力文档作为权威快照。
    await refreshCurrentCapability();
    evaluateCurrentWriteState();
  }
}

function deltaText(payload, label) {
  if (payload.redacted !== true && typeof payload.text === 'string' && payload.text.length > 0) return payload.text;
  var count = Number.isInteger(payload.chars) && payload.chars >= 0 ? payload.chars + '字，' : '';
  return label + '更新（' + count + '正文未同步）';
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
  // 能力文档可能由 hub 派生为 seq 0，不能按内容序号丢弃；重复投递只是重渲染。
  if (event.kind === 'capability.changed') {
    applyCapabilityDocument(event.payload);
    return;
  }
  var key = sessionKey(current);
  var turnEvent = event.kind === 'turn.started' || event.kind === 'turn.completed';
  if (turnEvent && !Number.isInteger(event.seq)) return;
  if (typeof event.seq === 'number') {
    var previous = lastSeq.get(key) || 0;
    if (event.seq <= previous) return;
    lastSeq.set(key, event.seq);
  }
  nativePost({ type: 'event', event: event });
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
    appendMessage(deltaText(payload, '思考'), 'reason', payload.itemId || event.seq, event.ts); return;
  } else if (event.kind === 'message.delta') {
    appendMessage(deltaText(payload, '回复'), 'assistant', payload.itemId || event.seq, event.ts); return;
  } else if (event.kind === 'message.completed') {
    node = textNode('div', '消息完成', 'reason');
  } else if (event.kind === 'tool.started') {
    node = textNode('div', '▶ ' + (payload.name || payload.tool || 'tool'), 'tool');
  } else if (event.kind === 'tool.completed') {
    node = textNode('div', (payload.isError ? '✗ ' : '✓ ') + (payload.redacted ? payload.chars + ' 字' : String(payload.content || '').slice(0, 400)), 'tool');
  } else if (event.kind === 'turn.started') {
    updateCurrentRunning(true);
    node = textNode('div', '回合开始', 'reason');
  } else if (event.kind === 'turn.completed') {
    updateCurrentRunning(false);
    node = textNode('div', '回合完成（' + (payload.state || 'completed') + '）', 'reason');
  } else {
    return;
  }
  appendLog(node, event.ts);
}

/* ---------------- 发送 ---------------- */

async function submitPrompt(text, requestId, extras) {
  if (current === null) { setStatus('失败：请先选择会话'); return; }
  if (sendingPrompt || acquirePending) return;
  if (writeState !== 'ready' && !acquireEligible()) { setStatus('写入已禁用：' + (writeReason || '状态未知')); return; }
  text = text.trim();
  if (!text) return;
  var target = current;
  sendingPrompt = true; applyWriteState();
  try {
  if (writeState !== 'ready') {
    var acquired = await acquireWrite();
    if (!acquired || current !== target) return;
  }
  // Selection, busy state or synchronization can change during acquisition.
  evaluateCurrentWriteState();
  if (current !== target || writeState !== 'ready') return;
  var key = requestId || newKey();
  var intent = {
    id: intentId(key, target, 'prompt'), owner: origin + '|' + (session ? session.operatorId : ''),
    key: key, op: 'prompt', target: target, status: 'pending', at: Date.now(),
  }
  // 先持久化再发送；存储不可用时拒绝新写。
  var stored = await persistIntent(intent);
  if (!stored) { setStatus('持久存储不可用，拒绝发送'); return; }
  appendMessage(text, 'user', key, Date.now());
  var body = await command('prompt', { text: text, ...(extras || {}) }, target, false, key);
  if (body === null) {
    await updateIntent(intent.id, { status: 'unknown' });
    return;
  }
  var label = outcomeLabel(body.status === 'rejected' ? 200 : (body.ok ? 200 : 202), body);
  setStatus(label);
  await updateIntent(intent.id, { status: intentStatus(body) });
  reconcilePending();
  return body;
  } finally { sendingPrompt = false; applyWriteState(); }
}

sendForm.onsubmit = async function(event) {
  event.preventDefault();
  var text = textInput.value;
  var result = await submitPrompt(text);
  if (result?.ok && textInput.value === text) textInput.value = '';
};

${DISCUSSION_SCRIPT}
applyWriteState();
if (accountMode) showLogin('请从 DeepSeek Harness 插件进入你的调度空间'); else restore();
setInterval(function() {
  if (session === null) return;
  refreshDevices().then(function() { return refreshCurrentCapability(); }).catch(function() {});
}, 5000);
try {
  var channel = new BroadcastChannel('marshal-intents');
  channel.onmessage = function() { if (session !== null) reconcilePending(); };
} catch (error) {}
</script></body></html>`;
/** Reuse the static UI with an isolated cookie/API namespace inside Desktop. */
export const DESKTOP_PAGE_HTML = PAGE_HTML
    .replaceAll('/marshal/', '/marshal/desktop/')
    .replaceAll('__Host-marshal-csrf', '__Host-marshal-desktop-csrf')
    .replace('<body>', '<body class="desktop-embed">');
