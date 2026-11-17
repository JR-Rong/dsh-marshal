/* DSH 0.2.1-rc.5 compatibility boundary: only our retained presentation sessions.
 * No host session records, agent factories, or ordinary DSH transports are changed.
 * The native Session is not exported by this host version; shape checks fail closed.
 */
function marshalNative() {
    const SUPPORTED_METHODS = ['installWindow', 'handleRunning', 'handleBlank', 'getSnapshot', 'beginSubmission'];
    const targetKey = target => JSON.stringify([target.deviceId, target.agent, target.sessionId]);
    const errorResult = message => ({ ok: false, error: { code: 'session/agent-busy', message, data: { reason: message } } });

    function projectTranscript(frames) {
      const entries = [];
      const messages = new Map();
      const tools = new Map();
      const users = new Map();
      let turn = 0, step = 0, open = false, messagesInTurn = 0;
      const add = (type, data, time, surface = false) => {
        const event = { type, seq: entries.length, time: time || Date.now(), data };
        if (surface) event.surfaceOp = 'append';
        entries.push({ type: 'event', event });
        return event;
      };
      const start = time => {
        if (open) return;
        turn++; step = 1; open = true; messagesInTurn = 0;
        add('turn/start', { turn }, time);
        add('step/start', { turn, step }, time);
      };
      for (const frame of frames) {
        const p = frame.payload || {};
        const time = frame.ts;
        if (frame.kind === 'turn.started') { start(time); continue; }
        if (frame.kind === 'turn.completed') {
          if (open) {
            add('step/end', { turn, step }, time);
            add('turn/end', { turn, reason: { kind: p.state === 'failed' ? 'error' : p.state === 'interrupted' ? 'interrupted' : 'completed', ...(p.state === 'failed' ? { error: { code: 'AGENT_ERROR', message: '原始智能体执行失败' } } : {}) } }, time);
            open = false;
          }
          continue;
        }
        if (frame.kind === 'user.message') {
          start(time);
          const previous = users.get(p.itemId);
          if (previous) { if (p.chunkIndex > 0) previous.data.content[0].text += p.text || ''; continue; }
          const entry = add('user/message', { id: p.itemId, content: [{ type: 'text', text: p.text || '' }],
            source: { kind: 'user', ...(p.rpcId ? { rpcId: p.rpcId } : {}) } }, time, true);
          users.set(p.itemId, entry);
          continue;
        }
        if (['message.delta', 'message.completed', 'reasoning.delta'].includes(frame.kind)) {
          if (typeof p.text !== 'string') continue;
          start(time);
          const key = `${turn}:${frame.kind === 'reasoning.delta' ? 'reasoning' : 'text'}:${p.itemId}`;
          let event = messages.get(key);
          if (!event) {
            if (messagesInTurn++) { add('step/end', { turn, step }, time); step++; add('step/start', { turn, step }, time); }
            event = add('assistant/message', { turn, step, stream: [], message: { id: p.itemId, role: 'assistant', source: { provider: '', model: '' },
              content: [{ type: frame.kind === 'reasoning.delta' ? 'reasoning' : 'text', text: '' }] } }, time, true);
            messages.set(key, event);
          }
          const block = event.data.message.content[0];
          // Completed items are authoritative snapshots; privacy chunks carry chunkIndex.
          if (frame.kind === 'message.completed' && !p.chunkIndex) block.text = p.text;
          else block.text += p.text;
          continue;
        }
        if (frame.kind === 'tool.started' || frame.kind === 'tool.completed') {
          start(time);
          if (!tools.has(p.callId)) {
            tools.set(p.callId, true);
            add('tool/call', { turn, step, callId: p.callId, name: p.tool || 'tool', arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {}) }, time);
          }
          if (frame.kind === 'tool.completed') add('tool/result', { turn, step, message: {
            id: `${p.callId}:result`, role: 'tool', source: { kind: 'tool', callId: p.callId },
            content: [{ type: 'text', text: typeof p.text === 'string' ? p.text : typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '' }], isError: p.status === 'error',
          } }, time, true);
        }
      }
      return entries;
    }

    function createSessionBridge(ctx, target, invoke, onLocal = () => {}) {
      if (typeof ctx.sessions?.retainAgentScope !== 'function') throw Error('当前 DSH 版本不支持原生会话适配');
      const id = 'marshal-view:' + encodeURIComponent(targetKey(target)) + ':' + crypto.randomUUID();
      if (ctx.sessions.binding(id)) throw Error('调度官会话仍在释放，请重试');
      const reference = ctx.sessions.retainAgentScope(id);
      const session = reference.binding.session;
      if (!SUPPORTED_METHODS.every(name => typeof session[name] === 'function') || !('remote' in session) || !('openState' in session)) {
        reference.release(); throw Error('DSH 会话接口已变化，请升级调度官适配器');
      }
      let frames = [], timer, closed = false, pending = false, allowed = true, unavailable = '';
      const publish = () => {
        clearTimeout(timer); timer = undefined;
        if (closed) return;
        session.openState = 'open';
        session.handleBlank(false);
        session.installWindow(projectTranscript(frames), false);
      };
      const unsupported = async () => errorResult('该功能尚未映射到原始智能体，请在原始应用中操作');
      // Replace the transport ONLY on the newly owned, namespaced instance.
      session.remote = {
        session: new Proxy({
          async prompt(request) {
            if (closed || pending || !allowed) return errorResult(unavailable || '会话不可用或正在发送');
            if (!Array.isArray(request.content) || request.content.some(part => part.type !== 'text')) return errorResult('此会话目前支持文本输入');
            pending = true;
            try {
              const text = request.content.map(part => part.text).join('\n');
              const insertion = frames.length;
              const result = await invoke('prompt', { text, requestId: request.requestId });
              if (closed) return errorResult('会话已切换，请回原会话核对发送结果');
              if (!result?.ok || !['accepted', 'confirmed'].includes(result.status)) return errorResult(result?.code || '发送结果未确认，请查看调度官状态后再操作');
              const frame = { kind: 'user.message', ts: Date.now(), payload: { itemId: request.requestId, rpcId: request.requestId, text } };
              frames.splice(insertion, 0, frame); onLocal(frame);
              publish();
              return { ok: true, value: { accepted: true } };
            } catch (error) { return errorResult(error.message || '连接已断开'); }
            finally { pending = false; }
          },
          async cancel() {
            try {
              const result = await invoke('interrupt', {});
              return result?.ok ? { ok: true, value: {} } : errorResult(result?.code || '停止未确认');
            } catch (error) { return errorResult(error.message); }
          },
        }, { get(object, key) { return object[key] || unsupported; } }),
        commands: { execute: unsupported }, subagents: { prompt: unsupported, interruptByParent: unsupported },
      };
      publish();
      return {
        reference,
        target,
        replace(next) { frames = next.slice(); publish(); },
        append(frame) { if (closed) return; frames.push(frame); if (!timer) timer = setTimeout(publish, 120); },
        availability(canSend, reason) { allowed = canSend === true; unavailable = reason || ''; },
        running(value) { if (!closed) session.handleRunning(value === true); },
        dispose() { if (closed) return; closed = true; clearTimeout(timer); frames = []; reference.release(); },
      };
    }
    return { createSessionBridge, projectTranscript, targetKey };
}
