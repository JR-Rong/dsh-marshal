    const mvVoiceIdle = Object.freeze({ status: 'idle' });
    const mvVoiceLabels = { connecting: '正在连接', active: '通话中', ending: '正在结束', summary: '语音纪要' };
    const mvVoicePhaseLabels = {
      listening: '聆听中',
      transcribing: '识别中',
      thinking: '思考中',
      speaking: '说话中',
      ptt: '按住说话',
      notes: '本地笔记模式',
    };
    const mvVoiceNow = () => performance.now();

    function mvBytesToBase64(bytes) {
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }

    /** Downsample Float32 mono PCM chunks to 16kHz 16-bit PCM WAV bytes. */
    function mvEncodePcm16Wav(chunks, inputSampleRate = 16000, targetRate = 16000) {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      if (total === 0) return new Uint8Array(0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      let samples = merged;
      if (inputSampleRate > 0 && inputSampleRate !== targetRate) {
        const ratio = inputSampleRate / targetRate;
        const outLen = Math.max(1, Math.round(merged.length / ratio));
        samples = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const a = merged[idx] ?? 0;
          const b = merged[Math.min(idx + 1, merged.length - 1)] ?? a;
          samples[i] = a + (b - a) * frac;
        }
      }
      const dataSize = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      const writeAscii = (at, str) => { for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i)); };
      writeAscii(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeAscii(8, 'WAVE');
      writeAscii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, targetRate, true);
      view.setUint32(28, targetRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(36, 'data');
      view.setUint32(40, dataSize, true);
      let pos = 44;
      for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(pos, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        pos += 2;
      }
      return new Uint8Array(buffer);
    }

    async function mvVoiceAuthFetch(path, body, signal, fetchImpl = fetch) {
      const url = new URL(path, document.baseURI);
      const send = proof => {
        signal?.throwIfAborted();
        return fetchImpl(url, {
          credentials: 'same-origin',
          ...(signal ? { signal } : {}),
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(typeof proof === 'string' ? { 'x-marshal-csrf': proof } : proof),
          },
        });
      };
      signal?.throwIfAborted();
      const proof = await ensureMemorySession(undefined, signal);
      let response = await send(proof);
      if (response.status === 401 || response.status === 403) {
        signal?.throwIfAborted();
        const refreshed = await ensureMemorySession(proof, signal);
        response = await send(refreshed);
      }
      return response;
    }

    async function* mvReadSseEvents(response, signal) {
      const reader = response.body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      const onAbort = () => { try { void reader.cancel(); } catch {} };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const parseBlock = block => {
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return null;
        try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch { return null; }
      };
      try {
        while (!signal?.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const parsed = parseBlock(buffer.slice(0, sep));
            buffer = buffer.slice(sep + 2);
            if (parsed) yield parsed;
          }
        }
        if (!signal?.aborted) {
          buffer += decoder.decode().replace(/\r\n/g, '\n');
          const tail = buffer.trim();
          if (tail) {
            const parsed = parseBlock(tail);
            if (parsed) yield parsed;
          }
        }
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        try { reader.releaseLock(); } catch {}
      }
    }

    // Adapter contract: connect({agent, targetTicketId, signal, onTranscript, onUpdateTranscript, onState}),
    // optional setMuted(bool), setMode(mode), setPttActive(bool), setTts({provider, voice}),
    // interrupt(), prepareStt(), end({signal, agent, targetTicketId, transcript, notes}) -> {summary},
    // and synchronous dispose(). dispose releases all session resources and permits a later fresh connect.
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
        const snapshot = get();
        patch({ status: 'ending', duration: mvVoiceNow() - snapshot.startedAt, level: 0 });
        if (session !== call) return;
        let result;
        try {
          result = await adapter.end?.({
            signal: call.ending.signal,
            agent: snapshot.agent,
            targetTicketId: snapshot.targetTicketId,
            transcript: snapshot.transcript,
            notes: snapshot.notes,
          });
        } catch {
          if (session !== call) return;
          clearSession();
          store.set({ status: 'idle', outcome: 'error', message: '语音连接结束失败，未生成纪要。' });
          return;
        }
        if (session !== call) return;
        release(call);
        if (session !== call) return;
        const { notes, transcript } = get();
        const hasSummary = typeof result?.summary === 'string' && result.summary.trim().length > 0;
        const summary = [
          typeof result?.summary === 'string' ? result.summary : '',
          hasSummary && result?.includesNotes ? '' : notes,
        ].filter(Boolean).join('\n\n')
          || transcript.map(line => line.speaker + '：' + line.text).join('\n');
        patch({ status: 'summary', expanded: true, summary: summary.slice(0, 3000), message: '' });
      };
      const action = async (kind, targetTicketId) => {
        const call = session;
        const { status, agent, summary, busy, savedId, savedTask } = get();
        const text = summary?.trim();
        if (!call || status !== 'summary' || !text || busy ||
          (kind === 'save' ? Boolean(savedId) : get().synced || (!targetTicketId && !savedId))) return;
        const { signal } = call.actions;
        patch({ busy: kind, message: '' });
        try {
          if (kind === 'save') {
            const draft = {
              agentKey: agent.agentKey, type: 'direct', title: ('语音纪要 · ' + agent.name).slice(0, 512),
              lastSummary: text, ...(targetTicketId ? { linkedTicketId: targetTicketId } : {}),
            };
            const result = await fetchJson('marshal/agent-tasks/create', draft, true, signal);
            if (!result.task?.id) throw Error('Missing task id');
            if (session === call) patch({ savedId: result.task.id, savedTask: { ...draft, ...result.task }, message: '已保存为 1:1 任务。' });
          } else {
            await fetchJson('marshal/agents/guidance-sync', {
              agentKey: agent.agentKey, guidanceText: text,
              ...(savedId ? { taskIds: [savedId] } : {}),
              ...(targetTicketId ? { targetTicketId, wakeTicket: savedTask?.linkedTicketId === targetTicketId } : {}),
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
        async start(agent, { targetTicketId, ticketNo } = {}) {
          if (disposed || get().status !== 'idle' || !agent?.agentKey) return;
          const call = { connection: new AbortController(), ending: new AbortController(), actions: new AbortController() };
          session = call;
          store.set({
            status: 'connecting', agent, targetTicketId, ticketNo, expanded: true, muted: false,
            notes: '', transcript: [], phase: adapter.local ? 'notes' : 'listening',
            mode: 'vad', pttActive: false, level: 0, ttsProvider: 'edge', ttsVoice: '',
            sttNeedsPrepare: false, preparingStt: false, fallbackLocal: adapter.local === true,
          });
          if (session !== call) return;
          try {
            await adapter.connect({
              agent, targetTicketId, signal: call.connection.signal,
              onTranscript(line) {
                if (session !== call || call.released || !['connecting', 'active', 'ending'].includes(get().status) ||
                  typeof line?.text !== 'string' || !line.text.trim()) return;
                patch({ transcript: [...get().transcript.slice(-199),
                  { id: line.id, speaker: String(line.speaker || agent.name).slice(0, 120), text: line.text.slice(0, 3000) }] });
              },
              onUpdateTranscript(id, text, speaker) {
                if (session !== call || call.released || !['connecting', 'active', 'ending'].includes(get().status) ||
                  typeof text !== 'string') return;
                const list = get().transcript;
                const idx = list.findIndex(item => item.id && item.id === id);
                const nextLine = { id, speaker: String(speaker || agent.name).slice(0, 120), text: text.slice(0, 3000) };
                if (idx >= 0) {
                  const copy = list.slice();
                  copy[idx] = nextLine;
                  patch({ transcript: copy });
                } else if (text.trim()) {
                  patch({ transcript: [...list.slice(-199), nextLine] });
                }
              },
              onState(partial) {
                if (session !== call || call.released || !['connecting', 'active', 'ending'].includes(get().status)) return;
                if (partial && typeof partial === 'object') patch(partial);
              },
            });
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
            if (session === call && get().status === 'active') patch({ muted, level: muted ? 0 : get().level, message: '' });
          } catch {
            if (session === call && get().status === 'active') patch({ message: '无法切换静音。' });
          } finally { call.muting = false; }
        },
        setMode(mode) {
          if (get().status !== 'active' || !['vad', 'ptt'].includes(mode)) return;
          patch({ mode, pttActive: false });
          adapter.setMode?.(mode);
        },
        setPttActive(active) {
          if (get().status !== 'active' || get().mode !== 'ptt' || get().muted) return;
          const next = Boolean(active);
          patch({ pttActive: next });
          adapter.setPttActive?.(next);
        },
        setTts(providerId, voice) {
          if (get().status !== 'active' || !providerId) return;
          patch({ ttsProvider: providerId, ...(voice !== undefined ? { ttsVoice: voice } : {}) });
          adapter.setTts?.({ provider: providerId, voice });
        },
        interrupt() {
          if (get().status !== 'active') return;
          adapter.interrupt?.();
        },
        prepareStt() {
          if (get().status !== 'active' || get().preparingStt) return;
          void adapter.prepareStt?.();
        },
        switchToLocalNotes() {
          if (get().status !== 'active') return;
          adapter.switchToLocalNotes?.();
          patch({ fallbackLocal: true, phase: 'notes', level: 0, message: '已切换为本地笔记模式，不录音。' });
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
        confirmGuidance(snapshot) {
          if (get() === snapshot && snapshot.status === 'summary') patch({ synced: true, message: '已同步指导。' });
        },
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

    /**
     * Live real-time voice call adapter:
     * - Microphone capture with hardware echoCancellation / noiseSuppression / autoGainControl
     * - VAD auto-endpointing (default) + Push-to-Talk dual mode
     * - SenseVoice STT via POST /marshal/voice/transcribe
     * - A1 SSE streaming dialogue via POST /marshal/voice/turn
     * - Pipelined sentence TTS playback queue via POST /marshal/voice/tts (T1 default / T2 local)
     * - Automatic & manual Barge-in interruption cancelling in-flight LLM/TTS/audio
     * - Post-call summary via POST /marshal/voice/summarize
     */
    function createLiveVoiceCallProvider(env = {}) {
      let activeAgent = null;
      let activeTicketId;
      let emitTranscript = () => {};
      let emitUpdateTranscript = () => {};
      let emitState = () => {};
      let muted = false;
      let mode = 'vad';
      let pttRecording = false;
      let phase = 'listening';
      let localFallback = false;
      let ttsProvider = 'edge';
      let ttsVoice = '';
      let history = [];
      let stream = null;
      let audioCtx = null;
      let sourceNode = null;
      let processorNode = null;
      let sinkGain = null;
      let sampleRate = 16000;
      let turnAbort = null;
      let ttsAbort = null;
      let callAbort = null;
      let prepareTimer = null;
      let disposed = false;
      let activeAudio = null;
      let stopActiveAudio = null;
      let playQueue = [];
      let playingQueue = false;
      let playbackSeq = 0;
      let utteranceSeq = 0;

      // VAD capture buffers
      let preRoll = [];
      let speechChunks = [];
      let inSpeech = false;
      let speechMs = 0;
      let silenceMs = 0;
      let bargeMs = 0;
      let lastLevelEmit = 0;
      const PRE_ROLL_MAX = 4;

      const getFetch = () => env.fetch ?? fetch;
      const liveFetchJson = async (path, body, signal) => {
        if (!env.fetch) return fetchJson(path, body, true, signal);
        const response = await mvVoiceAuthFetch(path, body, signal, getFetch());
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw Object.assign(new Error(data?.message || data?.error || ('HTTP ' + response.status)), {
            status: response.status,
            code: data?.code || data?.error,
            data,
          });
        }
        return data;
      };
      const getMedia = () => env.getUserMedia ?? (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? constraints => navigator.mediaDevices.getUserMedia(constraints) : null);
      const getAudioCtxCtor = () => env.AudioContext ?? (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null);
      const getAudioCtor = () => env.Audio ?? (typeof Audio !== 'undefined' ? Audio : null);
      const getUrlApi = () => env.URL ?? URL;

      const setPhase = nextPhase => {
        phase = nextPhase;
        emitState({ phase: nextPhase });
      };

      const stopAudioPlayback = () => {
        playbackSeq += 1;
        playQueue = [];
        playingQueue = false;
        const stopFn = stopActiveAudio;
        stopActiveAudio = null;
        if (stopFn) {
          try { stopFn(); } catch {}
        } else if (activeAudio) {
          const audio = activeAudio;
          activeAudio = null;
          try { audio.pause(); } catch {}
          try { audio.src = ''; } catch {}
        }
      };

      const cancelTurn = () => {
        if (turnAbort) { try { turnAbort.abort(); } catch {} turnAbort = null; }
        if (ttsAbort) { try { ttsAbort.abort(); } catch {} ttsAbort = null; }
        stopAudioPlayback();
      };

      const releaseCapture = () => {
        if (prepareTimer) { clearTimeout(prepareTimer); prepareTimer = null; }
        if (processorNode) {
          try { processorNode.onaudioprocess = null; processorNode.disconnect(); } catch {}
          processorNode = null;
        }
        if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
        if (sinkGain) { try { sinkGain.disconnect(); } catch {} sinkGain = null; }
        if (stream) {
          for (const track of stream.getTracks?.() ?? []) { try { track.stop(); } catch {} }
          stream = null;
        }
        if (audioCtx) { try { void audioCtx.close?.(); } catch {} audioCtx = null; }
        preRoll = [];
        speechChunks = [];
        inSpeech = false;
        speechMs = 0;
        silenceMs = 0;
        bargeMs = 0;
        pttRecording = false;
      };

      const playBlob = (blob, seq) => new Promise(resolve => {
        if (disposed || seq !== playbackSeq) { resolve(); return; }
        const AudioCtor = getAudioCtor();
        const urlApi = getUrlApi();
        if (!AudioCtor || typeof urlApi?.createObjectURL !== 'function') { resolve(); return; }
        const objectUrl = urlApi.createObjectURL(blob);
        const audio = new AudioCtor(objectUrl);
        activeAudio = audio;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (activeAudio === audio) activeAudio = null;
          if (stopActiveAudio === abortPlayback) stopActiveAudio = null;
          try { urlApi.revokeObjectURL?.(objectUrl); } catch {}
          resolve();
        };
        const abortPlayback = () => {
          try { audio.pause?.(); } catch {}
          try { audio.src = ''; } catch {}
          finish();
        };
        stopActiveAudio = abortPlayback;
        audio.onended = finish;
        audio.onerror = finish;
        audio.onpause = finish;
        try {
          const maybePromise = audio.play?.();
          if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(finish);
        } catch { finish(); }
      });

      const drainPlayQueue = async seq => {
        if (playingQueue) return;
        playingQueue = true;
        try {
          while (!disposed && seq === playbackSeq && playQueue.length > 0) {
            const job = playQueue.shift();
            const blob = await job;
            if (disposed || seq !== playbackSeq) break;
            if (blob) {
              setPhase('speaking');
              await playBlob(blob, seq);
            }
          }
        } finally {
          playingQueue = false;
          if (!disposed && seq === playbackSeq && !turnAbort) {
            setPhase(localFallback ? 'notes' : (mode === 'ptt' ? 'ptt' : 'listening'));
          }
        }
      };

      const enqueueTtsSentence = (sentence, seq, signal) => {
        if (!sentence || disposed || signal.aborted) return;
        const job = (async () => {
          try {
            const response = await mvVoiceAuthFetch('marshal/voice/tts', {
              provider: ttsProvider,
              voice: ttsVoice || undefined,
              text: sentence,
            }, signal, getFetch());
            if (!response.ok || signal.aborted || seq !== playbackSeq) return null;
            const fallback = response.headers?.get?.('x-marshal-tts-fallback');
            if (fallback) emitState({ message: '网络语音暂不可用，已自动切换本机离线朗读。' });
            return await response.blob();
          } catch {
            return null;
          }
        })();
        playQueue.push(job);
        void drainPlayQueue(seq);
      };

      const processUtterance = async wavBytes => {
        if (disposed || localFallback || !wavBytes || wavBytes.length <= 44) return;
        const myUtterance = ++utteranceSeq;
        cancelTurn();
        const mySeq = playbackSeq;
        const ctrl = new AbortController();
        const myTtsAbort = new AbortController();
        turnAbort = ctrl;
        ttsAbort = myTtsAbort;
        setPhase('transcribing');
        emitState({ message: '' });
        let recognized = '';
        try {
          const sttRes = await liveFetchJson('marshal/voice/transcribe', {
            audioBase64: mvBytesToBase64(wavBytes),
            language: 'auto',
          }, ctrl.signal);
          recognized = typeof sttRes?.text === 'string' ? sttRes.text.trim() : '';
        } catch (error) {
          if (ctrl.signal.aborted || disposed) return;
          if (error?.code === 'stt-not-ready') {
            emitState({ sttNeedsPrepare: true, message: 'SenseVoice 模型尚未就绪，请先点击「准备本地语音识别模型」。' });
          } else {
            emitState({ message: error?.message || '语音识别失败，请重试。' });
          }
          if (turnAbort === ctrl) turnAbort = null;
          setPhase(mode === 'ptt' ? 'ptt' : 'listening');
          return;
        }
        if (ctrl.signal.aborted || disposed || myUtterance !== utteranceSeq) return;
        if (!recognized) {
          if (turnAbort === ctrl) turnAbort = null;
          setPhase(mode === 'ptt' ? 'ptt' : 'listening');
          return;
        }

        emitTranscript({ speaker: '我', text: recognized });
        setPhase('thinking');
        const replyLineId = 'agent-turn-' + myUtterance;
        let replyText = '';
        try {
          const response = await mvVoiceAuthFetch('marshal/voice/turn', {
            agentKey: activeAgent.agentKey,
            text: recognized,
            history: history.slice(-12),
            ...(activeTicketId ? { targetTicketId: activeTicketId } : {}),
          }, ctrl.signal, getFetch());
          if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw Object.assign(new Error(errBody?.message || '模型回复失败'), { code: errBody?.code || 'turn-failed' });
          }
          for await (const { event, data } of mvReadSseEvents(response, ctrl.signal)) {
            if (ctrl.signal.aborted || disposed || mySeq !== playbackSeq) break;
            if (event === 'delta' && typeof data?.text === 'string') {
              replyText += data.text;
              emitUpdateTranscript(replyLineId, replyText, activeAgent.name);
            } else if (event === 'sentence' && typeof data?.text === 'string') {
              enqueueTtsSentence(data.text, mySeq, myTtsAbort.signal);
            } else if (event === 'error') {
              emitState({ message: data?.message || '语音对话异常，请重试。' });
            }
          }
          if (!ctrl.signal.aborted && replyText.trim()) {
            history = [...history.slice(-10), { role: 'user', text: recognized }, { role: 'assistant', text: replyText.trim() }];
          }
        } catch (error) {
          if (!ctrl.signal.aborted && !disposed) {
            emitState({ message: error?.message || '对话流中断，请重试。' });
          }
        } finally {
          if (turnAbort === ctrl) turnAbort = null;
          if (!disposed && !playingQueue && playQueue.length === 0 && mySeq === playbackSeq) {
            setPhase(localFallback ? 'notes' : (mode === 'ptt' ? 'ptt' : 'listening'));
          }
        }
      };

      const onAudioFrame = samples => {
        if (disposed || localFallback || muted || !samples?.length) return;
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / samples.length);
        const frameMs = (samples.length / Math.max(8000, sampleRate)) * 1000;
        const now = mvVoiceNow();
        if (now - lastLevelEmit >= 80) {
          lastLevelEmit = now;
          emitState({ level: Math.min(1, rms * 6) });
        }
        const copy = new Float32Array(samples);
        if (mode === 'ptt') {
          if (pttRecording) {
            speechChunks.push(copy);
            speechMs += frameMs;
            if (speechMs >= 30_000) {
              pttRecording = false;
              const wav = mvEncodePcm16Wav(speechChunks, sampleRate);
              speechChunks = [];
              speechMs = 0;
              emitState({ pttActive: false });
              void processUtterance(wav);
            }
          }
          return;
        }
        // VAD mode + Barge-in
        const busyTalking = phase === 'speaking' || phase === 'thinking';
        const threshold = busyTalking ? 0.048 : 0.024;
        if (busyTalking) {
          if (rms >= threshold) {
            preRoll.push(copy);
            if (preRoll.length > PRE_ROLL_MAX) preRoll.shift();
            bargeMs += frameMs;
            if (bargeMs >= 260) {
              cancelTurn();
              inSpeech = true;
              speechChunks = preRoll.slice();
              preRoll = [];
              speechMs = bargeMs;
              silenceMs = 0;
              bargeMs = 0;
              setPhase('listening');
              emitState({ message: '已打断，正在聆听…' });
            }
          } else {
            bargeMs = Math.max(0, bargeMs - frameMs);
          }
          return;
        }
        if (phase === 'transcribing') return;
        if (rms >= threshold) {
          if (!inSpeech) {
            inSpeech = true;
            speechChunks = preRoll.slice();
            preRoll = [];
            speechMs = 0;
            silenceMs = 0;
          }
          speechChunks.push(copy);
          speechMs += frameMs;
          silenceMs = 0;
          if (speechMs >= 25_000) {
            const wav = mvEncodePcm16Wav(speechChunks, sampleRate);
            inSpeech = false; speechChunks = []; speechMs = 0; silenceMs = 0;
            void processUtterance(wav);
          }
        } else if (inSpeech) {
          speechChunks.push(copy);
          silenceMs += frameMs;
          if (silenceMs >= 700) {
            const wav = speechMs >= 240 ? mvEncodePcm16Wav(speechChunks, sampleRate) : null;
            inSpeech = false; speechChunks = []; speechMs = 0; silenceMs = 0;
            if (wav) void processUtterance(wav);
          }
        } else {
          preRoll.push(copy);
          if (preRoll.length > PRE_ROLL_MAX) preRoll.shift();
        }
      };

      const refreshCapabilities = async signal => {
        try {
          const caps = await liveFetchJson('marshal/voice/capabilities', undefined, signal);
          const stt = caps?.stt ?? {};
          const needsPrepare = Boolean(stt.available && !stt.ready);
          const providers = caps?.tts?.providers ?? [];
          const defaultTts = caps?.tts?.defaultProvider || 'edge';
          const defaultVoice = caps?.tts?.defaultVoice || '';
          if (!ttsVoice) ttsVoice = defaultVoice;
          emitState({
            capabilities: caps,
            sttNeedsPrepare: needsPrepare,
            preparingStt: stt.phase === 'preparing',
            ttsProvider: providers.some(p => p.id === ttsProvider) ? ttsProvider : defaultTts,
            ttsVoice,
          });
          return caps;
        } catch {
          return null;
        }
      };

      const schedulePrepareWatch = () => {
        if (disposed || localFallback) return;
        if (prepareTimer) clearTimeout(prepareTimer);
        prepareTimer = setTimeout(async () => {
          prepareTimer = null;
          if (disposed || localFallback) return;
          const caps = await refreshCapabilities(callAbort?.signal);
          if (disposed || localFallback) return;
          if (caps?.stt?.ready) {
            emitState({ sttNeedsPrepare: false, preparingStt: false, message: 'SenseVoice 语音模型已就绪，可以直接开口对话。' });
            return;
          }
          if (caps?.stt?.phase === 'preparing') schedulePrepareWatch();
          else emitState({ preparingStt: false });
        }, 1500);
      };

      return createVoiceCallProvider({
        local: false,
        async connect({ agent, targetTicketId, signal, onTranscript, onUpdateTranscript, onState }) {
          signal.throwIfAborted();
          disposed = false;
          callAbort?.abort();
          callAbort = new AbortController();
          activeAgent = agent;
          activeTicketId = targetTicketId;
          emitTranscript = onTranscript;
          emitUpdateTranscript = onUpdateTranscript;
          emitState = onState;
          muted = false;
          mode = 'vad';
          pttRecording = false;
          localFallback = false;
          history = [];
          const caps = await refreshCapabilities(signal);
          signal.throwIfAborted();
          if (!caps || caps.llmAvailable === false) {
            localFallback = true;
            emitState({ fallbackLocal: true, phase: 'notes', message: '后端语音服务暂不可用，已切换本地笔记模式。' });
            return;
          }
          const requestMic = getMedia();
          const AudioCtx = getAudioCtxCtor();
          if (!requestMic || !AudioCtx) {
            localFallback = true;
            emitState({ fallbackLocal: true, phase: 'notes', message: '当前环境不支持麦克风采集，已切换本地笔记模式。' });
            return;
          }
          try {
            stream = await requestMic({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            });
            if (signal.aborted) { releaseCapture(); signal.throwIfAborted(); }
            audioCtx = new AudioCtx();
            sampleRate = audioCtx.sampleRate || 16000;
            sourceNode = audioCtx.createMediaStreamSource(stream);
            processorNode = audioCtx.createScriptProcessor(2048, 1, 1);
            sinkGain = audioCtx.createGain();
            sinkGain.gain.value = 0;
            processorNode.onaudioprocess = event => {
              const data = event?.inputBuffer?.getChannelData?.(0);
              if (data) onAudioFrame(data);
            };
            sourceNode.connect(processorNode);
            processorNode.connect(sinkGain);
            sinkGain.connect(audioCtx.destination);
            if (typeof audioCtx.resume === 'function') { try { await audioCtx.resume(); } catch {} }
            setPhase('listening');
          } catch {
            releaseCapture();
            localFallback = true;
            emitState({ fallbackLocal: true, phase: 'notes', message: '麦克风未授权或不可用，已切换为本地笔记模式。' });
          }
        },
        setMuted(nextMuted) {
          muted = Boolean(nextMuted);
          if (muted) {
            inSpeech = false; speechChunks = []; pttRecording = false;
            emitState({ level: 0, pttActive: false });
          }
        },
        setMode(nextMode) {
          mode = nextMode;
          inSpeech = false; speechChunks = []; speechMs = 0; silenceMs = 0; pttRecording = false;
          if (phase !== 'speaking' && phase !== 'thinking' && phase !== 'transcribing') {
            setPhase(nextMode === 'ptt' ? 'ptt' : 'listening');
          }
        },
        setPttActive(active) {
          if (localFallback || muted || mode !== 'ptt') return;
          if (active) {
            cancelTurn();
            speechChunks = [];
            speechMs = 0;
            pttRecording = true;
            setPhase('listening');
          } else if (pttRecording) {
            pttRecording = false;
            const wav = speechMs >= 160 ? mvEncodePcm16Wav(speechChunks, sampleRate) : null;
            speechChunks = [];
            speechMs = 0;
            if (wav) void processUtterance(wav);
            else setPhase('ptt');
          }
        },
        setTts({ provider, voice }) {
          if (provider) ttsProvider = provider;
          if (voice !== undefined) ttsVoice = voice;
        },
        interrupt() {
          cancelTurn();
          inSpeech = false; speechChunks = []; bargeMs = 0;
          setPhase(localFallback ? 'notes' : (mode === 'ptt' ? 'ptt' : 'listening'));
          emitState({ message: '已打断回复。' });
        },
        async prepareStt() {
          emitState({ preparingStt: true, message: '正在后台准备 SenseVoice 语音模型…' });
          try {
            const res = await liveFetchJson('marshal/voice/prepare', {}, callAbort?.signal);
            if (disposed || localFallback) return;
            if (res?.stt?.ready) {
              emitState({ sttNeedsPrepare: false, preparingStt: false, message: 'SenseVoice 已就绪，可以直接说话。' });
            } else {
              schedulePrepareWatch();
            }
          } catch (error) {
            if (!disposed) emitState({ preparingStt: false, message: error?.message || '触发模型准备失败。' });
          }
        },
        switchToLocalNotes() {
          cancelTurn();
          releaseCapture();
          localFallback = true;
        },
        async end({ signal, agent, targetTicketId, transcript, notes }) {
          callAbort?.abort();
          callAbort = null;
          cancelTurn();
          releaseCapture();
          if (localFallback || (!transcript?.length && !notes?.trim())) return {};
          try {
            const res = await liveFetchJson('marshal/voice/summarize', {
              agentKey: agent.agentKey,
              ...(targetTicketId ? { targetTicketId } : {}),
              transcript,
              notes,
            }, signal);
            const summary = typeof res?.summary === 'string' ? res.summary : '';
            return { summary, includesNotes: Boolean(summary.trim()) };
          } catch {
            return {};
          }
        },
        dispose() {
          disposed = true;
          callAbort?.abort();
          callAbort = null;
          cancelTurn();
          releaseCapture();
          history = [];
        },
      });
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
        lines.length ? lines.map((line, index) => h('div', { key: line.id || index }, h('strong', null, line.speaker + '：'), line.text))
          : h('span', { className: 'mv-muted' }, '暂无对话记录'));
    }
    function mvVoiceGuidanceAction({ voice, call, runtime }) {
      const state = mvUseAgentTasks(runtime, call.agent.agentKey);
      const { items } = useMvSnapshot(runtime.tickets);
      const { tasks: selected, ticket } = mvSelection(state, items);
      // Keep a saved, unlinked summary usable for direct sync, but never add
      // an unselected ticket-bound summary or reuse the call's initial target.
      const saved = state.rows.find(task => task.id === call.savedId) ?? call.savedTask;
      const tasks = selected.length ? selected : saved && !saved.linkedTicketId ? [saved] : [];
      return h(MvButton, { icon: 'send', className: 'mv-guidance-action', label: call.synced ? '已同步' : mvGuidanceLabel(ticket),
        disabled: Boolean(call.busy || call.synced || !call.summary.trim()),
        onClick: () => runtime.showModal({ agent: call.agent, tasks, ticket,
          guidanceText: call.summary, onSuccess: () => voice.confirmGuidance(call) }) });
    }
    function MarshalVoiceSummaryCard({ voice, call, guidanceRuntime }) {
      const canSync = Boolean(call.targetTicketId || call.savedId);
      return h('section', { id: 'marshal-voice-detail', className: 'mv-summary-card mv-stack', role: 'region', 'aria-label': '语音纪要' },
        h('div', { className: 'mv-line' }, h(MvAvatar, { agent: call.agent }),
          h('div', { className: 'mv-copy' }, h('h2', { className: 'mv-voice-title' }, '语音纪要 · ' + call.agent.name),
            h(MvVoiceTimer, { call }))),
        h('label', { className: 'mv-stack' }, '纪要摘要',
          h('textarea', { className: 'mv-field', rows: 4, maxLength: 3000, value: call.summary,
            readOnly: Boolean(call.busy || (call.savedId && call.synced)), onChange: event => voice.editSummary(event.target.value) })),
        call.transcript.length > 0 && h('details', null, h('summary', null, '对话记录'), h(MvVoiceTranscript, { lines: call.transcript })),
        !guidanceRuntime && h('div', { className: 'mv-muted' }, call.targetTicketId ? '同步目标：关联工单群' :
          canSync ? '同步目标：智能体 1:1 直连会话' : '先保存为任务，再同步至智能体的 1:1 会话。'),
        h('div', { className: 'mv-actions' },
          h(MvButton, { icon: 'save', label: call.savedId ? '已保存' : '保存为 1:1 任务',
            disabled: Boolean(call.busy || call.savedId || !call.summary.trim()), onClick: () => void voice.saveSummary() }),
          guidanceRuntime ? h(mvVoiceGuidanceAction, { voice, call, runtime: guidanceRuntime }) :
            h(MvButton, { icon: 'send', label: call.synced ? '已同步' : '汇总同步指导',
            disabled: Boolean(call.busy || call.synced || !canSync || !call.summary.trim()), onClick: () => void voice.syncGuidance() }),
          h(MvButton, { icon: 'close', label: '关闭', disabled: Boolean(call.busy), onClick: () => voice.close() })),
        h('div', { className: 'mv-muted', role: 'status' }, call.busy ? '正在提交…' : call.message));
    }
    function MarshalVoiceCallOverlay({ voice, guidanceRuntime }) {
      const call = useMvSnapshot(voice);
      if (call.status === 'idle') return call.message ? h('div', { className: 'mv-scope mv-voice-dock' },
        h('section', { className: 'mv-voice-panel mv-line' },
          h('span', { className: 'mv-copy', role: 'status' }, call.message),
          h(MvButton, { icon: 'close', label: '关闭', iconOnly: true, onClick: () => voice.reset() }))) : null;
      const summary = call.status === 'summary';
      const connecting = call.status === 'connecting';
      const isLocal = voice.local || call.fallbackLocal;
      const phaseLabel = !isLocal && call.status === 'active' && !call.muted && mvVoicePhaseLabels[call.phase]
        ? mvVoicePhaseLabels[call.phase] : null;
      const label = call.status === 'active' && call.muted ? '已静音' : mvVoiceLabels[call.status];
      const ttsProviders = call.capabilities?.tts?.providers ?? [];
      const canInterrupt = !isLocal && call.status === 'active' && (call.phase === 'speaking' || call.phase === 'thinking');
      return h('div', { className: 'mv-scope mv-voice-dock' },
        h(MvButton, { icon: call.expanded ? 'down' : 'phone', label: label, className: 'mv-capsule',
          'aria-expanded': call.expanded, 'aria-controls': call.expanded ? 'marshal-voice-detail' : undefined,
          onClick: () => voice.setExpanded(!call.expanded) },
          (phaseLabel || label) + ' · ' + call.agent.name, h(MvVoiceTimer, { call })),
        call.expanded && (summary ? h(MarshalVoiceSummaryCard, { voice, call, guidanceRuntime })
          : h('section', { id: 'marshal-voice-detail', className: 'mv-voice-panel mv-stack', role: 'region', 'aria-label': '语音小会话' },
            h('div', { className: 'mv-line' },
              h(MvAvatar, { agent: call.agent, breathing: call.status === 'active' && !call.muted }),
              h('div', { className: 'mv-copy' }, h('h2', { className: 'mv-voice-title' }, '语音小会话 · ' + call.agent.name),
                h('div', { className: 'mv-muted', role: 'status' }, phaseLabel ? label + ' · ' + phaseLabel : label))),
            !isLocal && call.status === 'active' && h('div', { className: 'mv-voice-meter', 'aria-hidden': true },
              h('div', { className: 'mv-voice-meter-fill', style: { width: Math.round((call.level || 0) * 100) + '%' } })),
            !isLocal && call.sttNeedsPrepare && h('div', { className: 'mv-voice-banner' },
              h('span', null, call.preparingStt ? '正在下载 SenseVoice 语音识别模型…' : '首次通话需准备本机 SenseVoice 模型'),
              h(MvButton, { label: call.preparingStt ? '准备中…' : '准备模型', disabled: Boolean(call.preparingStt),
                onClick: () => voice.prepareStt() })),
            !isLocal && call.status === 'active' && h('div', { className: 'mv-voice-controls', role: 'group', 'aria-label': '通话设置' },
              h(MvButton, { className: 'mv-chip', label: '免提自动', 'aria-pressed': call.mode === 'vad',
                onClick: () => voice.setMode('vad') }),
              h(MvButton, { className: 'mv-chip', label: '按住说话', 'aria-pressed': call.mode === 'ptt',
                onClick: () => voice.setMode('ptt') }),
              ttsProviders.filter(item => item.id === 'edge' || item.id === 'local' || item.id === 'system').map(item =>
                h(MvButton, {
                  key: item.id, className: 'mv-chip',
                  label: item.id === 'edge' ? 'T1 神经语音' : item.id === 'local' ? 'T2 本地离线' : '系统离线',
                  title: item.ready ? item.label : (item.installHint || item.reason || '未就绪'),
                  disabled: !item.ready,
                  'aria-pressed': call.ttsProvider === item.id,
                  onClick: () => voice.setTts(item.id),
                }))),
            !isLocal && call.status === 'active' && call.mode === 'ptt' && h(MvButton, {
              icon: 'mic', className: 'mv-voice-ptt',
              label: call.pttActive ? '松开发送' : '按住说话（或按住空格）',
              disabled: Boolean(call.muted),
              'aria-pressed': Boolean(call.pttActive),
              onPointerDown: () => voice.setPttActive(true),
              onPointerUp: () => voice.setPttActive(false),
              onPointerCancel: () => voice.setPttActive(false),
              onKeyDown: event => { if (event.code === 'Space' && !event.repeat) { event.preventDefault(); voice.setPttActive(true); } },
              onKeyUp: event => { if (event.code === 'Space') { event.preventDefault(); voice.setPttActive(false); } },
            }),
            h('div', { className: 'mv-muted' }, isLocal ? '本地笔记模式，不录音。' : '实时语音通话中，可随时开口打断。', 'SenseVoice 听写仍可在原输入框使用。'),
            h(MvVoiceTranscript, { lines: call.transcript }),
            h('label', { className: 'mv-stack' }, '通话笔记', h('textarea', { className: 'mv-field', rows: 2,
              maxLength: 3000, value: call.notes, readOnly: call.status === 'ending', onChange: event => voice.setNotes(event.target.value) })),
            h('div', { className: 'mv-actions' },
              h(MvButton, { icon: call.muted ? 'mute' : 'mic', label: '静音', disabled: call.status !== 'active',
                'aria-pressed': call.muted, onClick: () => void voice.toggleMuted() }),
              canInterrupt && h(MvButton, { icon: 'close', label: '打断', onClick: () => voice.interrupt() }),
              !isLocal && call.status === 'active' && h(MvButton, { label: '切笔记模式', onClick: () => voice.switchToLocalNotes() }),
              h(MvButton, { icon: 'hangup', label: connecting ? '取消连接' : '挂断并生成纪要',
                className: 'mv-danger', disabled: call.status === 'ending',
                onClick: () => { if (connecting) voice.cancel(); else void voice.end(); } })),
            call.message && h('div', { className: 'mv-muted', role: 'status' }, call.message))));
    }
