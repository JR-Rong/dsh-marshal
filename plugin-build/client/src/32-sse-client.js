    const marshalSseConnections = new Map();
    const marshalSseRetryDelays = [1000, 2000, 5000, 15000];

    function marshalAuthDenied(status) {
      return status === 401 || status === 403;
    }

    async function refreshMarshalSseProof(connection) {
      const proof = await ensureMemorySession(connection.rejectedProof, connection.controller.signal);
      connection.auth = 'refreshed';
      connection.rejectedProof = undefined;
      connection.refreshedProof = proof;
      return proof;
    }

    function notifyMarshalSubscriber(subscriber, topic, data) {
      if (!subscriber.active || (!subscriber.topics.has(topic) && !subscriber.topics.has('*'))) return;
      if (!subscriber.debounceMs) {
        try { void Promise.resolve(subscriber.listener(topic, data)).catch(() => {}); } catch {}
        return;
      }
      // Coalesce invalidations without waiting for a quiet period during continuous streaming.
      subscriber.pending = [topic, data];
      scheduleMarshalSubscriber(subscriber);
    }

    function scheduleMarshalSubscriber(subscriber) {
      if (!subscriber.active || !subscriber.pending || subscriber.running || subscriber.timer !== undefined) return;
      subscriber.timer = setTimeout(() => {
        subscriber.timer = undefined;
        void deliverMarshalRefresh(subscriber);
      }, subscriber.debounceMs);
    }

    async function deliverMarshalRefresh(subscriber) {
      const args = subscriber.pending;
      subscriber.pending = undefined;
      subscriber.running = true;
      try { await subscriber.listener(...args); } catch {}
      finally {
        subscriber.running = false;
        scheduleMarshalSubscriber(subscriber);
      }
    }

    function dispatchMarshalFrame(connection, frame) {
      let topic = 'message';
      const lines = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') topic = value || 'message';
        else if (field === 'data') lines.push(value);
      }
      if (!lines.length) return;
      let data;
      try { data = JSON.parse(lines.join('\n')); } catch { return; }
      if (topic === 'ready') {
        connection.ready = { data };
        connection.auth = undefined;
        connection.refreshedProof = undefined;
      }
      for (const subscriber of [...connection.subscribers]) notifyMarshalSubscriber(subscriber, topic, data);
    }

    async function runMarshalSse(connection) {
      if (connection.running || connection.controller.signal.aborted) return;
      connection.running = true;
      const { signal } = connection.controller;
      connection.ready = undefined;
      let openedAt;
      try {
        const proof = connection.auth === 'refreshing'
          ? await refreshMarshalSseProof(connection)
          : connection.auth === 'refreshed' ? memoryProof() ?? connection.refreshedProof
          : nativeMemory ? await ensureMemorySession(undefined, signal) : memoryProof();
        if (signal.aborted) return;
        const response = await fetch(connection.address + '/marshal/events', {
          headers: {
            accept: 'text/event-stream',
            ...(typeof proof === 'string' ? { 'x-marshal-csrf': proof } : proof),
          },
          credentials: 'same-origin',
          signal,
        });
        if (signal.aborted || !response.ok) {
          void response.body?.cancel().catch(() => {});
          if (!signal.aborted && marshalAuthDenied(response.status) && !connection.auth) {
            connection.auth = 'refreshing';
            connection.rejectedProof = proof;
            // Don't clear credentials another request has already refreshed.
            if (nativeMemory && desktopMemorySession === proof) desktopMemorySession = undefined;
            await refreshMarshalSseProof(connection);
          }
          return;
        }
        if (!response.body) return;
        openedAt = Date.now();
        const reader = response.body.getReader();
        connection.reader = reader;
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done || signal.aborted) break;
            buffer += decoder.decode(value, { stream: true });
            // Match LF and CRLF delimiters even when split across byte chunks.
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop();
            for (const frame of frames) {
              if (signal.aborted) break;
              dispatchMarshalFrame(connection, frame);
            }
            if (buffer.length > 1_048_576) break; // Bound an unterminated frame.
          }
        } finally {
          connection.reader = undefined;
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        // A session endpoint rejection, unlike a transport failure, cannot be retried in the background.
        if (marshalAuthDenied(error?.status)) connection.auth = 'denied';
      }
      finally {
        connection.running = false;
        connection.ready = undefined;
        if (!signal.aborted && connection.subscribers.size && connection.auth !== 'denied') {
          // A stream that immediately closes after ready is still a failed attempt.
          if (openedAt !== undefined && Date.now() - openedAt >= 30_000) connection.retry = 0;
          const delay = marshalSseRetryDelays[connection.retry] + Math.floor(Math.random() * 250);
          connection.retry = Math.min(connection.retry + 1, marshalSseRetryDelays.length - 1);
          connection.timer = setTimeout(() => {
            connection.timer = undefined;
            void runMarshalSse(connection);
          }, delay);
        }
      }
    }

    function resumeMarshalSseConnection(connection, fromSessionSuccess = false) {
      if (connection.auth !== 'denied' || connection.running || connection.controller.signal.aborted || !connection.subscribers.size) return;
      if (!fromSessionSuccess && nativeMemory && connection.rejectedProof && desktopMemorySession === connection.rejectedProof) {
        desktopMemorySession = undefined;
      }
      connection.auth = undefined;
      connection.rejectedProof = undefined;
      connection.refreshedProof = undefined;
      connection.retry = 0;
      clearTimeout(connection.timer);
      connection.timer = undefined;
      void runMarshalSse(connection);
    }

    function resumeDeniedMarshalSse(fromSessionSuccess = false) {
      for (const connection of [...marshalSseConnections.values()]) {
        resumeMarshalSseConnection(connection, fromSessionSuccess);
      }
    }

    function stopMarshalSubscriber(subscriber) {
      subscriber.active = false;
      clearTimeout(subscriber.timer);
      subscriber.pending = undefined;
    }

    function stopMarshalSse(connection) {
      marshalSseConnections.delete(connection.address);
      clearTimeout(connection.timer);
      if (connection.onWake) {
        window.removeEventListener?.('focus', connection.onWake);
        document.removeEventListener?.('visibilitychange', connection.onWake);
        connection.onWake = undefined;
      }
      for (const subscriber of connection.subscribers) stopMarshalSubscriber(subscriber);
      connection.subscribers.clear();
      connection.controller.abort();
      void connection.reader?.cancel().catch(() => {});
    }

    // Listeners receive (topic, data). Refresh views can opt into a synthetic initial
    // read and coalesced, serialized invalidations (including a replay of an active ready).
    function subscribeMarshalEvents(topics, listener, { debounceMs = 0, initial = false } = {}) {
      const address = readAddress();
      let connection = marshalSseConnections.get(address);
      const start = !connection;
      if (start) {
        connection = { address, controller: new AbortController(), subscribers: new Set(), retry: 0, running: false };
        connection.onWake = () => {
          if (document.visibilityState === 'hidden') return;
          resumeMarshalSseConnection(connection, false);
        };
        window.addEventListener?.('focus', connection.onWake);
        document.addEventListener?.('visibilitychange', connection.onWake);
        marshalSseConnections.set(address, connection);
      }
      const subscriber = { topics: new Set(typeof topics === 'string' ? [topics] : topics), listener, debounceMs, active: true };
      connection.subscribers.add(subscriber);
      if (initial) {
        subscriber.pending = ['initial', undefined];
        void deliverMarshalRefresh(subscriber);
      }
      if (connection.ready) notifyMarshalSubscriber(subscriber, 'ready', connection.ready.data);
      if (start && !connection.controller.signal.aborted) void runMarshalSse(connection);
      return () => {
        if (!connection.subscribers.delete(subscriber)) return;
        stopMarshalSubscriber(subscriber);
        if (!connection.subscribers.size) stopMarshalSse(connection);
      };
    }

    function disposeAllMarshalSse() {
      for (const connection of [...marshalSseConnections.values()]) stopMarshalSse(connection);
    }

    // SSE, manual refresh and the low-frequency fallback share one read at a time.
    // Keep one trailing refresh if an invalidation arrives during a read.
    function createVisibleMarshalRefresh(read, intervalMs) {
      let closed = false;
      let polling = false;
      let currentInterval = intervalMs;
      let queued = false;
      let timer, flight, controller;
      const visible = () => !closed && document.visibilityState !== 'hidden';
      const clearTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      const schedule = () => {
        if (!visible() || !polling || flight || timer !== undefined) return;
        timer = setTimeout(request, currentInterval + Math.floor(Math.random() * 750));
      };
      function request() {
        if (!visible()) return;
        clearTimer();
        queued = true;
        flight ??= Promise.resolve().then(async () => {
          while (queued && visible()) {
            queued = false;
            controller = new AbortController();
            try { await read(controller.signal); } catch {}
            finally { controller = undefined; }
          }
        }).finally(() => {
          flight = undefined;
          if (queued) request();
          else schedule();
        });
        return flight;
      }
      const cancel = () => {
        queued = false;
        clearTimer();
        controller?.abort();
      };
      const onVisibility = () => {
        if (visible()) request();
        else cancel();
      };
      document.addEventListener?.('visibilitychange', onVisibility);
      return {
        request,
        setPolling(enabled, nextIntervalMs) {
          if (closed) return;
          const nextInterval = typeof nextIntervalMs === 'number' && nextIntervalMs > 0 ? nextIntervalMs : intervalMs;
          if (polling === enabled && currentInterval === nextInterval) return;
          polling = enabled;
          currentInterval = nextInterval;
          clearTimer();
          if (enabled) schedule();
        },
        dispose() {
          closed = true;
          cancel();
          document.removeEventListener?.('visibilitychange', onVisibility);
        },
      };
    }
