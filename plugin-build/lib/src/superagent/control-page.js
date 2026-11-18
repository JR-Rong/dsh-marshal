/**
 * The human control page for the superagent bridge.
 *
 * It exists because the model-facing tool must stay read-only: an agent can
 * read status or reconcile, but only a same-origin browser request may change
 * the routing or dispatch a card. The page is intentionally dependency-free
 * (no React, no bundler) so it can be served by the host plugin itself.
 */
export const CONTROL_PAGE_TITLE = '调度官 · Super-agent 派发桥';

export function controlPageHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>调度官 · Super-agent 派发桥</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 860px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  p.hint { opacity: .7; margin: 0 0 16px; }
  section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
  pre { overflow: auto; padding: 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); font-size: 12px; max-height: 260px; }
  label { display: inline-flex; align-items: center; gap: 6px; margin: 4px 14px 4px 0; }
  input[type=text], input[type=number] { padding: 4px 6px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  button { padding: 6px 14px; border-radius: 7px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; cursor: pointer; }
  #msg { min-height: 20px; margin-top: 12px; white-space: pre-wrap; }
  .err { color: #c0392b; }
  .ok { color: #1e8449; }
  .row { margin: 8px 0; }
</style>
</head>
<body>
<h1>调度官 · Super-agent 派发桥</h1>
<p class="hint">只接受本机同源浏览器请求。agent 的模型工具只能查看状态与对账，不能改路由或补派；配置与补派只在这个页面。</p>

<section>
  <h2>状态</h2>
  <pre id="status">加载中…</pre>
</section>

<section>
  <h2>默认与开关</h2>
  <form id="config">
    <div class="row"><label>默认智能体 <input type="text" id="defaultAgent" placeholder="丞相" size="24"></label></div>
    <div class="row">
      <label><input type="checkbox" id="enabled"> 启用</label>
      <label><input type="checkbox" id="rootOnly"> 只派发根卡</label>
      <label><input type="checkbox" id="injectMemory"> 注入长期记忆</label>
    </div>
    <div class="row">
      <label>记忆条数 <input type="number" id="memoryLimit" min="0" max="6" step="1" value="6" style="width:70px"></label>
      <label>标签前缀 <input type="text" id="tagPrefix" value="@" size="4" style="width:60px"></label>
    </div>
    <button type="submit">保存配置</button>
  </form>
</section>

<section>
  <h2>人工补派（手机/远端建卡）</h2>
  <form id="dispatch">
    <div class="row"><label>卡片 id <input type="text" id="taskId" placeholder="task id" size="40"></label></div>
    <button type="submit">派发这张卡</button>
  </form>
</section>

<section>
  <h2>智能体</h2>
  <pre id="agents">加载中…</pre>
</section>

<section>
  <h2>最近派发</h2>
  <pre id="recent">加载中…</pre>
</section>

<div id="msg"></div>

<script>
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  var agentsEl = document.getElementById('agents');
  var recentEl = document.getElementById('recent');
  var msgEl = document.getElementById('msg');
  function say(text, ok) {
    msgEl.textContent = text || '';
    msgEl.className = ok ? 'ok' : 'err';
  }
  function pretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (error) { return String(value); }
  }
  async function call(path, body) {
    var options = body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    };
    var response = await fetch(path, options);
    var data = await response.json().catch(function () { return { ok: false, code: 'bad-response' }; });
    if (!response.ok || data.ok === false) {
      throw new Error((data && (data.code || data.error)) || ('HTTP ' + response.status));
    }
    return data;
  }
  function fill(value) {
    statusEl.textContent = pretty(value);
    document.getElementById('defaultAgent').value = value.defaultAgent || '';
    document.getElementById('enabled').checked = value.enabled === true;
    document.getElementById('rootOnly').checked = value.rootOnly !== false;
    document.getElementById('injectMemory').checked = value.injectMemory !== false;
    document.getElementById('memoryLimit').value = String(value.memoryLimit === undefined ? 6 : value.memoryLimit);
    document.getElementById('tagPrefix').value = value.tagPrefix || '@';
    recentEl.textContent = pretty(value.recent || []);
  }
  async function refresh() {
    try {
      fill(await call('/marshal-superagent/api/status'));
      var agents = await call('/marshal-superagent/api/agents');
      agentsEl.textContent = pretty(agents.agents || []);
      say('');
    } catch (error) {
      say('读取失败：' + error.message, false);
    }
  }
  document.getElementById('config').onsubmit = async function (event) {
    event.preventDefault();
    try {
      var patch = {
        defaultAgent: document.getElementById('defaultAgent').value.trim() || null,
        enabled: document.getElementById('enabled').checked,
        rootOnly: document.getElementById('rootOnly').checked,
        injectMemory: document.getElementById('injectMemory').checked,
        memoryLimit: Number(document.getElementById('memoryLimit').value),
        tagPrefix: document.getElementById('tagPrefix').value.trim() || '@'
      };
      fill((await call('/marshal-superagent/api/config', patch)).status);
      say('配置已保存。', true);
    } catch (error) {
      say('保存失败：' + error.message, false);
    }
  };
  document.getElementById('dispatch').onsubmit = async function (event) {
    event.preventDefault();
    var taskId = document.getElementById('taskId').value.trim();
    if (taskId === '') { say('请填卡片 id。', false); return; }
    try {
      var result = await call('/marshal-superagent/api/dispatch', { taskId: taskId });
      say('派发结果：' + pretty(result), true);
      await refresh();
    } catch (error) {
      say('派发失败：' + error.message, false);
    }
  };
  refresh();
})();
</script>
</body>
</html>`;
}
