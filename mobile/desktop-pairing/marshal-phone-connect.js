/* marshal-phone-connect: injected by 丞相. Only mounts inside the 跨设备 page; no global capsule. */
;(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  /* __QRCODE_LIB__ */
  var HUB = "__HUB__";
  var TOKEN = "__TOKEN__";
  var MODAL_ID = 'marshal-phone-connect-modal';
  var STYLE_ID = 'marshal-phone-connect-inline-style';
  var BUTTON_ID = 'marshal-phone-connect-inline';
  var ROW_ID = 'marshal-phone-connect-row';
  var OLD_BUTTON_ID = 'marshal-phone-connect';
  var OLD_STYLE_ID = 'marshal-phone-connect-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + BUTTON_ID + '{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;border:1px solid #2c4a40;background:#1d2b27;color:#83c7b0;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;cursor:pointer;white-space:nowrap}',
      '#' + BUTTON_ID + ':active{background:#263b34}',
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);padding:20px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#edf0f3}',
      '#' + MODAL_ID + ' [data-qr]{background:#fff;border-radius:12px;padding:10px;display:flex;align-items:center;justify-content:center;min-height:220px}',
      '#' + MODAL_ID + ' [data-qr] svg{width:100%;height:auto;display:block}',
      '#' + MODAL_ID + ' button{border:1px solid #30353b;border-radius:10px;background:#262b30;color:#edf0f3;padding:8px 12px;font:inherit;cursor:pointer}',
      '#' + MODAL_ID + ' button.primary{background:#83c7b0;border-color:#83c7b0;color:#112c22;font-weight:600}',
      '#' + MODAL_ID + ' button.ghost{background:transparent;color:#939da8}',
      '#' + MODAL_ID + ' .card{width:min(360px,92vw);max-height:90vh;overflow:auto;background:#1b1e21;border:1px solid #30353b;border-radius:16px;padding:16px}',
      '#' + MODAL_ID + ' .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}',
      '#' + MODAL_ID + ' .head strong{font-size:16px}',
      '#' + MODAL_ID + ' .muted{color:#939da8;font-size:12px;margin:0 0 10px}',
      '#' + MODAL_ID + ' .warn{color:#e1ae68;font-size:12px;margin:0 0 10px}',
      '#' + MODAL_ID + ' .status{color:#83c7b0;font-size:12px;margin:10px 0;min-height:18px}',
      '#' + MODAL_ID + ' .actions{display:flex;gap:8px;flex-wrap:wrap}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function qrSvg(link) {
    try {
      var qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      return qr.createSvgTag({ cellSize: 5, margin: 4 });
    } catch (error) {
      return '';
    }
  }

  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCrossDeviceHeading() {
    var nodes = document.querySelectorAll('div,span,strong,h1,h2,h3,p');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.textContent.trim() !== '跨设备群聊') continue;
      if (!isVisible(node)) continue;
      var rect = node.getBoundingClientRect();
      // 只在左栏（跨设备页的左面板）里认标题，排除右侧会话正文里的同名文字。
      if (rect.left > window.innerWidth * 0.45) continue;
      var nested = false;
      for (var j = 0; j < node.children.length; j += 1) {
        if (node.children[j].textContent.trim() === '跨设备群聊') { nested = true; break; }
      }
      if (nested) continue;
      return node;
    }
    return null;
  }

  function crossDeviceTabActive() {
    var nodes = document.querySelectorAll('[role="checkbox"],[role="tab"],button');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.textContent.trim() !== '跨设备') continue;
      var state = node.getAttribute('aria-checked') || node.getAttribute('aria-selected') || node.getAttribute('data-state') || node.getAttribute('data-active');
      if (state === 'true' || state === 'on' || state === 'checked' || state === 'active') return true;
      if (/(^|\s)(active|selected)(\s|$)/.test(String(node.className || ''))) return true;
    }
    return false;
  }

  function onCrossDevicePage() {
    return !!findCrossDeviceHeading();
  }

  function findReconnectButton() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) {
      var text = buttons[i].textContent.trim();
      if (text !== '重新连接' && text.indexOf('重新连接') === -1) continue;
      if (isVisible(buttons[i])) return buttons[i];
    }
    return null;
  }

  function removeOldFixed() {
    var old = document.getElementById(OLD_BUTTON_ID);
    if (old) old.remove();
    var oldStyle = document.getElementById(OLD_STYLE_ID);
    if (oldStyle) oldStyle.remove();
  }

  function ensureInline() {
    removeOldFixed();
    var oldRow = document.getElementById(ROW_ID);
    if (oldRow) oldRow.remove();
    var reconnect = findReconnectButton();
    var button = document.getElementById(BUTTON_ID);
    if (!reconnect || !onCrossDevicePage()) {
      if (button) button.remove();
      return;
    }
    if (button && reconnect.parentElement && reconnect.parentElement.contains(button)) return;
    if (button) button.remove();
    injectStyle();
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = '手机连接';
    button.innerHTML = '<span style="font-size:13px">\ud83d\udcf1</span><span>手机连接</span>';
    button.addEventListener('click', open);
    reconnect.parentElement.insertBefore(button, reconnect);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var run = function () {
      scheduled = false;
      try { ensureInline(); } catch (error) { /* keep the host app alive */ }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 50);
  }

  function open() {
    if (document.getElementById(MODAL_ID)) return;
    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = [
      '<div class="card">',
      '<div class="head"><strong>手机连接 · 一个码</strong><button class="ghost" data-close type="button">关闭</button></div>',
      '<p class="muted">扫一次：自动配好 Hub 与 DSH 工作台（智能体 / 会话 / 任务看板），不再分开扫。</p>',
      '<div data-qr></div>',
      '<p class="status" data-status>正在生成…</p>',
      '<p class="warn">二维码含 Hub 管理令牌与一次性 DSH 配对令牌；只给自己的手机扫，扫完请关闭。</p>',
      '<div class="actions"><button class="primary" data-refresh type="button">刷新二维码</button><button data-copy type="button">复制配对链接</button></div>',
      '</div>'
    ].join('');
    document.body.appendChild(modal);
    var qrBox = modal.querySelector('[data-qr]');
    var status = modal.querySelector('[data-status]');
    var currentLink = '';
    var timer = null;
    var refreshTimer = null;

    function setStatus(text) { status.textContent = text; }

    function close() {
      if (timer) { clearInterval(timer); timer = null; }
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      currentLink = '';
      qrBox.innerHTML = '';
      modal.remove();
    }

    function toBase64Url(text) {
      var bytes = new TextEncoder().encode(text);
      var binary = '';
      for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function stripBridgeToken(url) {
      try {
        var parsed = new URL(url);
        parsed.searchParams.delete('token');
        return parsed.toString();
      } catch (error) {
        return url;
      }
    }

    async function readTicket() {
      try {
        var response = await fetch(new URL('marshal/account/login', document.baseURI), {
          method: 'POST',
          headers: { 'x-marshal-account': '1' },
          cache: 'no-store'
        });
        var data = await response.json();
        if (data && data.ok && typeof data.ticket === 'string') {
          return { ticket: data.ticket, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : 0 };
        }
      } catch (error) { /* ticket is optional */ }
      return { ticket: '', expiresAt: 0 };
    }

    async function readBridge() {
      try {
        var response = await fetch(new URL('remote-bridge/pair/token', document.baseURI), { cache: 'no-store' });
        if (!response.ok) return null;
        var data = await response.json();
        if (!data || typeof data.token !== 'string' || typeof data.url !== 'string') return null;
        if (!/^wss?:\/\//.test(data.url)) return null;
        return {
          token: data.token,
          url: stripBridgeToken(data.url),
          expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + 30000
        };
      } catch (error) {
        return null;
      }
    }

    async function generate() {
      if (!HUB || TOKEN.length < 16) {
        setStatus('未注入 Hub 或管理令牌，请联系管理员重打补丁。');
        return;
      }
      setStatus('正在生成…');
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      var results = await Promise.all([readTicket(), readBridge()]);
      var ticketData = results[0];
      var bridge = results[1];
      var ticket = ticketData.ticket;
      var ticketExpiresAt = ticketData.expiresAt;
      var payload = { v: 1, hub: HUB, hubToken: TOKEN };
      if (ticket) payload.ticket = ticket;
      if (bridge) {
        payload.bridge = bridge.url;
        payload.bridgeToken = bridge.token;
        currentLink = 'marshal://setup?payload=' + toBase64Url(JSON.stringify(payload));
      } else {
        var params = new URLSearchParams();
        params.set('hub', HUB);
        params.set('token', TOKEN);
        if (ticket) params.set('ticket', ticket);
        currentLink = 'marshal://open?' + params.toString();
      }
      var svg = qrSvg(currentLink);
      if (!svg) {
        setStatus('二维码生成失败，请点「刷新二维码」重试。');
        return;
      }
      qrBox.innerHTML = svg;
      if (timer) { clearInterval(timer); timer = null; }
      var bridgeExpiresAt = bridge ? bridge.expiresAt : 0;
      var primaryExpiresAt = bridgeExpiresAt || ticketExpiresAt;
      function updateStatus() {
        var left = primaryExpiresAt ? Math.max(0, Math.round((primaryExpiresAt - Date.now()) / 1000)) : 0;
        var ticketLeft = ticketExpiresAt ? Math.max(0, Math.round((ticketExpiresAt - Date.now()) / 1000)) : 0;
        if (bridge) {
          if (left <= 0) {
            setStatus('DSH 配对令牌已过期；正在自动刷新，请扫最新二维码。');
          } else {
            setStatus('一个码：Hub + DSH 工作台；DSH 配对剩余 ' + left + ' 秒' + (ticket ? '；群聊 ticket ' + ticketLeft + ' 秒' : ''));
          }
        } else {
          setStatus('仅 Hub（DSH 配对端口未就绪）；Hub + 令牌已生成' + (ticket ? '；群聊 ticket ' + ticketLeft + ' 秒' : ''));
        }
      }
      updateStatus();
      timer = setInterval(updateStatus, 1000);
      if (bridge && bridgeExpiresAt > Date.now()) {
        var delay = Math.max(1000, bridgeExpiresAt - Date.now() - 5000);
        refreshTimer = setTimeout(function () {
          if (document.getElementById(MODAL_ID)) void generate();
        }, delay);
      }
    }

    modal.addEventListener('click', function (event) {
      if (event.target === modal) close();
    });
    modal.querySelector('[data-close]').addEventListener('click', close);
    modal.querySelector('[data-refresh]').addEventListener('click', function () { void generate(); });
    modal.querySelector('[data-copy]').addEventListener('click', function () {
      var button = modal.querySelector('[data-copy]');
      if (!currentLink) return;
      var done = function () { button.textContent = '已复制'; setTimeout(function () { button.textContent = '复制配对链接'; }, 2000); };
      var fail = function () { button.textContent = '复制失败，请扫码'; };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(currentLink).then(done).catch(fail);
      } else {
        fail();
      }
    });
    void generate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }
  try {
    var observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) { /* old WebView without MutationObserver */ }
  setInterval(schedule, 1500);
})();