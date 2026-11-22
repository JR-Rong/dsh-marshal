    const mvVoiceIdle = Object.freeze({ status: 'idle' });
    const mvVoiceLabels = { connecting: '正在连接', active: '通话中', ending: '正在结束', summary: '语音纪要' };
    const mvVoiceNow = () => performance.now();

    // Adapter contract: connect({agent, signal, onTranscript}), optional
    // setMuted(bool) and end({signal}) -> {summary}, and synchronous dispose().
    // dispose releases all session resources and permits a later fresh connect.
    function createVoiceCallProvider(adapter) {
      const store = createMvStore(mvVoiceIdle);
      const get = store.getSnapshot;
      const patch = next => store.set({ ...get(), ...next });
      let session, disposed = false;
      const release = call => {
        if (call.released) return;
        call.released = true;
        call.connection.abort();
        call.ending.abort();
        try { adapter.dispose?.(); } catch {}
      };
      const clearSession = () => {
        const call = session;
        session = undefined;
        if (call) {
          call.actions.abort();
          release(call);
        }
      };
      const reset = () => {
        if (disposed || !['idle', 'summary'].includes(get().status)) return false;
        clearSession();
        store.set(mvVoiceIdle);
        return true;
      };
      // Failed or cancelled connections never acquire an active session or a summary.
      const exitConnecting = (outcome, message) => {
        if (get().status !== 'connecting' || !session) return false;
        clearSession();
        store.set({ status: 'idle', outcome, message });
        return true;
      };
      const end = async () => {
        const call = session;
        if (!call || get().status !== 'active') return;
        patch({ status: 'ending', duration: mvVoiceNow() - get().startedAt });
        if (session !== call) return;
        let result;
        try { result = await adapter.end?.({ signal: call.ending.signal }); }
        catch {
          if (session !== call) return;
          clearSession();
          store.set({ status: 'idle', outcome: 'error', message: '语音连接结束失败，未生成纪要。' });
          return;
        }
        if (session !== call) return;
        release(call);
        if (session !== call) return;
        const { notes, transcript } = get();
        const summary = [typeof result?.summary === 'string' ? result.summary : '', notes].filter(Boolean).join('\n\n')
          || transcript.map(line => line.speaker + '：' + line.text).join('\n');
        patch({ status: 'summary', expanded: true, summary: summary.slice(0, 3000), message: '' });
      };
      const action = async (kind, targetTicketId) => {
        const call = session;
        const { status, agent, summary, busy, savedId } = get();
        const text = summary?.trim();
        if (!call || status !== 'summary' || !text || busy ||
          (kind === 'save' ? Boolean(savedId) : get().synced || (!targetTicketId && !savedId))) return;
        const { signal } = call.actions;
        patch({ busy: kind, message: '' });
        try {
          if (kind === 'save') {
            const result = await fetchJson('marshal/agent-tasks/create', {
              agentKey: agent.agentKey, type: 'direct', title: ('语音纪要 · ' + agent.name).slice(0, 512),
              lastSummary: text, ...(targetTicketId ? { linkedTicketId: targetTicketId } : {}),
            }, true, signal);
            if (!result.task?.id) throw Error('Missing task id');
            if (session === call) patch({ savedId: result.task.id, message: '已保存为 1:1 任务。' });
          } else {
            await fetchJson('marshal/agents/guidance-sync', {
              agentKey: agent.agentKey, guidanceText: text,
              ...(savedId ? { taskIds: [savedId] } : {}),
              ...(targetTicketId ? { targetTicketId } : {}),
            }, true, signal);
            if (session === call) patch({ synced: true, message: '已同步指导。' });
          }
        } catch (error) {
          if (session === call) patch({ message: kind === 'save'
            ? '未确认保存，请核对任务清单。'
            : error?.code === 'direct-session-not-found' ? '请先建立智能体的 1:1 直连会话。' : '未确认同步，请核对目标会话。' });
        } finally { if (session === call) patch({ busy: null }); }
      };
      return {
        getSnapshot: get, subscribe: store.subscribe, local: adapter.local === true,
        async start(agent, { targetTicketId } = {}) {
          if (disposed || get().status !== 'idle' || !agent?.agentKey) return;
          const call = { connection: new AbortController(), ending: new AbortController(), actions: new AbortController() };
          session = call;
          store.set({ status: 'connecting', agent, targetTicketId, expanded: true, muted: false, notes: '', transcript: [] });
          if (session !== call) return;
          try {
            await adapter.connect({ agent, signal: call.connection.signal, onTranscript(line) {
              if (session !== call || call.released || !['connecting', 'active', 'ending'].includes(get().status) ||
                typeof line?.text !== 'string' || !line.text.trim()) return;
              patch({ transcript: [...get().transcript.slice(-199),
                { speaker: String(line.speaker || agent.name).slice(0, 120), text: line.text.slice(0, 3000) }] });
            } });
            if (session === call && get().status === 'connecting') patch({ status: 'active', startedAt: mvVoiceNow() });
          } catch { if (session === call) exitConnecting('error', '无法建立语音会话。'); }
        },
        async toggleMuted() {
          const call = session;
          if (!call || call.muting || get().status !== 'active') return;
          call.muting = true;
          const muted = !get().muted;
          try {
            await adapter.setMuted?.(muted);
            if (session === call && get().status === 'active') patch({ muted, message: '' });
          } catch {
            if (session === call && get().status === 'active') patch({ message: '无法切换静音。' });
          } finally { call.muting = false; }
        },
        end, reset,
        cancel() { return exitConnecting('cancelled', '已取消语音连接。'); },
        setExpanded(expanded) { if (session) patch({ expanded }); },
        setNotes(notes) { if (['connecting', 'active'].includes(get().status)) patch({ notes: notes.slice(0, 3000) }); },
        editSummary(summary) {
          const { status, busy, savedId, synced } = get();
          if (status === 'summary' && !busy && !(savedId && synced)) patch({ summary: summary.slice(0, 3000) });
        },
        saveSummary() { return action('save', get().targetTicketId); },
        syncGuidance() { return action('sync', get().targetTicketId); },
        close() { if (get().status === 'summary' && !get().busy) reset(); },
        dispose() {
          if (disposed) return;
          disposed = true;
          // Destruction is not an operation on the live state machine.
          store.clear();
          clearSession();
          store.set(mvVoiceIdle);
        },
      };
    }

    function createLocalVoiceSessionProvider() {
      // This adapter deliberately does not request a microphone or simulate speech.
      return createVoiceCallProvider({ local: true, connect({ signal }) { signal.throwIfAborted(); } });
    }

    function mvVoiceDuration(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      const pad = value => String(value).padStart(2, '0');
      return pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    }
    function MvVoiceTimer({ call }) {
      const [now, setNow] = React.useState(mvVoiceNow);
      React.useEffect(() => {
        if (call.status !== 'active') return;
        let timer;
        const tick = () => {
          const time = mvVoiceNow();
          setNow(time);
          timer = setTimeout(tick, 1000 - (Math.max(0, time - call.startedAt) % 1000));
        };
        tick();
        return () => clearTimeout(timer);
      }, [call.status, call.startedAt]);
      return h('span', { className: 'mv-time', 'aria-label': '通话时长' },
        mvVoiceDuration(call.duration ?? (call.startedAt === undefined ? 0 : now - call.startedAt)));
    }
    function MvVoiceTranscript({ lines }) {
      return h('div', { className: 'mv-transcript', 'aria-label': '对话记录' },
        lines.length ? lines.map((line, index) => h('div', { key: index }, h('strong', null, line.speaker + '：'), line.text))
          : h('span', { className: 'mv-muted' }, '暂无对话记录'));
    }
    function MarshalVoiceSummaryCard({ voice, call }) {
      const canSync = Boolean(call.targetTicketId || call.savedId);
      return h('section', { id: 'marshal-voice-detail', className: 'mv-summary-card mv-stack', role: 'region', 'aria-label': '语音纪要' },
        h('div', { className: 'mv-line' }, h(MvAvatar, { agent: call.agent }),
          h('div', { className: 'mv-copy' }, h('h2', { className: 'mv-voice-title' }, '语音纪要 · ' + call.agent.name),
            h(MvVoiceTimer, { call }))),
        h('label', { className: 'mv-stack' }, '纪要摘要',
          h('textarea', { className: 'mv-field', rows: 4, maxLength: 3000, value: call.summary,
            readOnly: Boolean(call.busy || (call.savedId && call.synced)), onChange: event => voice.editSummary(event.target.value) })),
        call.transcript.length > 0 && h('details', null, h('summary', null, '对话记录'), h(MvVoiceTranscript, { lines: call.transcript })),
        h('div', { className: 'mv-muted' }, call.targetTicketId ? '同步目标：关联工单群' :
          canSync ? '同步目标：智能体 1:1 直连会话' : '先保存为任务，再同步至智能体的 1:1 会话。'),
        h('div', { className: 'mv-actions' },
          h(MvButton, { icon: 'save', label: call.savedId ? '已保存' : '保存为 1:1 任务',
            disabled: Boolean(call.busy || call.savedId || !call.summary.trim()), onClick: () => void voice.saveSummary() }),
          h(MvButton, { icon: 'send', label: call.synced ? '已同步' : '汇总同步指导',
            disabled: Boolean(call.busy || call.synced || !canSync || !call.summary.trim()), onClick: () => void voice.syncGuidance() }),
          h(MvButton, { icon: 'close', label: '关闭', disabled: Boolean(call.busy), onClick: () => voice.close() })),
        h('div', { className: 'mv-muted', role: 'status' }, call.busy ? '正在提交…' : call.message));
    }
    function MarshalVoiceCallOverlay({ voice }) {
      const call = useMvSnapshot(voice);
      if (call.status === 'idle') return call.message ? h('div', { className: 'mv-scope mv-voice-dock' },
        h('section', { className: 'mv-voice-panel mv-line' },
          h('span', { className: 'mv-copy', role: 'status' }, call.message),
          h(MvButton, { icon: 'close', label: '关闭', iconOnly: true, onClick: () => voice.reset() }))) : null;
      const summary = call.status === 'summary';
      const connecting = call.status === 'connecting';
      const label = call.status === 'active' && call.muted ? '已静音' : mvVoiceLabels[call.status];
      return h('div', { className: 'mv-scope mv-voice-dock' },
        h(MvButton, { icon: call.expanded ? 'down' : 'phone', label: label, className: 'mv-capsule',
          'aria-expanded': call.expanded, 'aria-controls': call.expanded ? 'marshal-voice-detail' : undefined,
          onClick: () => voice.setExpanded(!call.expanded) },
          label + ' · ' + call.agent.name, h(MvVoiceTimer, { call })),
        call.expanded && (summary ? h(MarshalVoiceSummaryCard, { voice, call })
          : h('section', { id: 'marshal-voice-detail', className: 'mv-voice-panel mv-stack', role: 'region', 'aria-label': '语音小会话' },
            h('div', { className: 'mv-line' },
              h(MvAvatar, { agent: call.agent, breathing: call.status === 'active' && !call.muted }),
              h('div', { className: 'mv-copy' }, h('h2', { className: 'mv-voice-title' }, '语音小会话 · ' + call.agent.name),
                h('div', { className: 'mv-muted', role: 'status' }, label))),
            h('div', { className: 'mv-muted' }, voice.local ? '本地笔记模式，不录音。' : '此通话与会话输入框独立。', 'SenseVoice 听写仍可在原输入框使用。'),
            h(MvVoiceTranscript, { lines: call.transcript }),
            h('label', { className: 'mv-stack' }, '通话笔记', h('textarea', { className: 'mv-field', rows: 2,
              maxLength: 3000, value: call.notes, readOnly: call.status === 'ending', onChange: event => voice.setNotes(event.target.value) })),
            h('div', { className: 'mv-actions' },
              h(MvButton, { icon: call.muted ? 'mute' : 'mic', label: '静音', disabled: call.status !== 'active',
                'aria-pressed': call.muted, onClick: () => void voice.toggleMuted() }),
              h(MvButton, { icon: 'hangup', label: connecting ? '取消连接' : '挂断并生成纪要',
                className: 'mv-danger', disabled: call.status === 'ending',
                onClick: () => { if (connecting) voice.cancel(); else void voice.end(); } })),
            call.message && h('div', { className: 'mv-muted', role: 'status' }, call.message))));
    }
