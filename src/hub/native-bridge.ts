/** The desktop iframe keeps its authenticated cloud origin. Only this fixed
 * MessagePort protocol crosses into DSH. Only short one-use login tickets cross;
 * cookies and native Platform grants never do. */
export const NATIVE_BRIDGE_CSS = `
.native-bridge #singleWorkspace { display:grid; grid-template-columns:122px minmax(0,1fr); min-height:0; }
.native-bridge #singleWorkspace > main { display:none; }
.native-bridge #singleWorkspace .device-rail { padding:12px 4px; border-right:1px solid var(--line); border-bottom:0; }
.native-bridge #devices { display:block; overflow:visible; }
.native-bridge .device-group { min-width:0; }
.native-bridge .device-group + .device-group { margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
.native-bridge #singleWorkspace .session-rail { max-height:none; padding:12px 4px; border-bottom:0; }
.native-bridge .session-heading { padding:0 6px 12px; }
.native-bridge .device-heading { padding:0 6px 8px; flex-wrap:wrap; gap:2px; }
.native-bridge .device-heading strong { font-size:11px; }
.native-bridge .row { padding:8px 6px; gap:5px; }
.native-bridge .session-state { display:none; }
.native-bridge .session-name { font-family:inherit; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.native-bridge .device-heading strong { flex-basis:100%; }
.native-bridge .app-header { padding:8px; gap:8px; min-height:46px; flex-wrap:wrap; }
.native-bridge .app-header .brand,.native-bridge #who { display:none; }
.native-bridge .account { gap:6px; }
.native-bridge .app-header button { padding:6px 8px; font-size:12px; }
.native-bridge body,.native-bridge #appView { height:100vh; min-height:0; }
html.native-bridge,body.native-bridge { height:100vh; overflow:hidden; }
`;

export const NATIVE_BRIDGE_SCRIPT = `
var nativePort = null;
function nativePost(value) { if (nativePort) nativePort.postMessage(value); }
function nativeState() {
  if (!nativePort) return;
  nativePost({ type: 'state', authenticated: session !== null, group: typeof groupVisible !== 'undefined' && groupVisible,
    title: currentRow ? sessionName(currentRow) : '', deviceName: deviceForCurrent()?.name || '',
    account: session?.account || null, workspaceName: session?.workspaceName || '',
    statistics: current?.agent === 'dsh' || current?.agent === 'codex' ? currentRow?.counts || null : null,
    target: current, running: !!(currentRow && currentRow.running), canSend: !sendingPrompt && !acquirePending && (writeState === 'ready' || acquireEligible()),
    reason: statusRoot.textContent || writeReason || '', capability: currentCapability });
}
window.addEventListener('message', function(event) {
  if (!document.body.classList.contains('desktop-embed') || event.source !== window.parent
    || event.origin !== 'dsh-app://app' || event.data?.type !== 'marshal.native.connect' || event.ports.length !== 1) return;
  if (nativePort) nativePort.close();
  nativePort = event.ports[0];
  document.documentElement.classList.add('native-bridge'); document.body.classList.add('native-bridge');
  nativePort.onmessage = async function(message) {
    var call = message.data;
    if (!call || typeof call.id !== 'string' || !['history','prompt','interrupt','controls','upload','acquire','account.login','account.logout'].includes(call.op)) return;
    var reply = { ok: false, code: 'session-mismatch' };
    try {
      if (call.op === 'account.login') reply = await loginWithAccount(call.args);
      else if (call.op === 'account.logout') { await logoutAccount(accountError(call.args?.code)); reply = { ok: true }; }
      else if (session && current && call.target && sessionKey(current) === sessionKey(call.target)) {
        var target = current, token = selectionToken;
        if (call.op === 'history') {
          var response = await request('/marshal/api/history', { method: 'POST', headers: writeHeaders(),
            body: JSON.stringify({ target: target, limit: 20, ...(typeof call.args?.cursor === 'string' ? { cursor: call.args.cursor } : {}) }) });
          reply = await response.json();
          if (response.status === 401) showLogin('会话已失效');
        } else if (call.op === 'prompt' && typeof call.args?.text === 'string' && typeof call.args?.requestId === 'string') {
          reply = await submitPrompt(call.args.text, call.args.requestId, { options: call.args.options, attachments: call.args.attachments });
        } else if (call.op === 'acquire') {
          reply = { ok: await acquireWrite() };
        } else if (call.op === 'controls' || call.op === 'upload') {
          reply = await command(call.op, call.op === 'controls' ? {} : call.args, target, false, call.id);
        } else if (call.op === 'interrupt') {
          var cap = currentCapability;
          if (cap && cap.operations?.includes('interrupt') && typeof cap.runtimeEpoch === 'string') {
            reply = await command('interrupt', { runtimeEpoch: cap.runtimeEpoch }, target, false, call.id);
          } else reply = { ok: false, code: 'unsupported' };
        }
        if (token !== selectionToken || current !== target) reply = { ok: false, code: 'stale-connection' };
      }
    } catch (error) { reply = { ok: false, code: 'outcome-unknown' }; }
    nativePost({ type: 'reply', id: call.id, result: reply });
    nativeState();
  };
  nativePort.start(); nativeState();
  if (accountMode) nativePost({ type: 'account-needed' });
});
`;
