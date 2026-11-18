/* Human-create observer for the dsh-marshal superagent bridge.
 *
 * The task board has no "card created" event and does not record who created a
 * card. The one place that separates a human GUI create from an agent tool call
 * is the browser: only the GUI posts a create action over fetch. This observer
 * therefore waits for a successful POST to the board's action endpoint, reads
 * the create request's own task id, and tells the local host. It never changes
 * the request or the response, and every failure is swallowed: a broken bridge
 * must not break the board.
 *
 * Appended to the generated client bundle by the build; kept as a standalone
 * file so it can be tested in a virtual window and re-appended if the bundle is
 * regenerated.
 */
(function installMarshalSuperagentHook(win) {
  if (win === null || win === undefined) return;
  if (win.__marshalSuperagentHook === true) return;
  win.__marshalSuperagentHook = true;
  win.__marshalSuperagentHookVersion = 1;
  const original = win.fetch;
  if (typeof original !== 'function') return;
  const seen = new Set();
  const endpoint = () => {
    try {
      const base = win.document && typeof win.document.baseURI === 'string'
        ? win.document.baseURI
        : (win.location && typeof win.location.href === 'string' ? win.location.href : undefined);
      return new URL('api/marshal-superagent/human-create', base === undefined ? '/' : base).href;
    }
    catch {
      return '/marshal-superagent/api/human-create';
    }
  };
  const notify = (taskId, requestId) => {
    if (typeof taskId !== 'string' || taskId === '' || seen.has(taskId)) return;
    seen.add(taskId);
    if (seen.size > 500) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId,
          source: 'board-ui',
          ...(typeof requestId === 'string' && requestId !== '' ? { requestId } : {}),
        }),
      };
      const result = original.call(win, endpoint(), init);
      if (result !== null && typeof result.then === 'function') result.catch(() => {});
    }
    catch {
      /* observation only */
    }
  };
  const wrapped = function wrappedFetch(input, init) {
    const promise = original.apply(this === undefined || this === null ? win : this, arguments);
    try {
      const url = typeof input === 'string'
        ? input
        : (input !== null && input !== undefined && typeof input.url === 'string' ? input.url : '');
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const body = init && typeof init.body === 'string' ? init.body : undefined;
      if (method === 'POST' && body !== undefined && url.indexOf('api/task-board/action') !== -1) {
        if (promise !== null && typeof promise.then === 'function') {
          promise.then(response => {
            try {
              if (response === null || response === undefined || response.ok !== true) return;
              const envelope = JSON.parse(body);
              const action = envelope && envelope.action;
              if (action === null || action === undefined || action.kind !== 'create' || typeof action.id !== 'string') return;
              notify(action.id, envelope.requestId);
            }
            catch {
              /* not a create envelope; ignore */
            }
          }).catch(() => {});
        }
      }
    }
    catch {
      /* observation only */
    }
    return promise;
  };
  try {
    win.fetch = wrapped;
  }
  catch {
    /* a frozen window: leave the original in place */
  }
})(typeof window === 'undefined' ? undefined : window);
