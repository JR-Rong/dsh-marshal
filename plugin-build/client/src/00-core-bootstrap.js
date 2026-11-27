    let pendingTab = null;
    function isPseudoAgentWorkspace(ws) {
      if (!ws) return false;
      const title = String(ws.title || ws.name || '').trim();
      const path = String(ws.path || '').trim();
      if (title.startsWith('Agent · ')) return true;
      if (path.includes('/.dsh-marshal/agents/Agent · ') || /\/Agent · [^/]+$/.test(path)) return true;
      return false;
    }
    function resolveNavTarget(raw) {
      if (raw === 'tasks') return { tab: 'tasks' };
      if (raw === 'monitor') return { tab: 'monitor' };
      if (raw === 'chats') return { tab: 'agents', chatSection: 'groups' };
      if (raw === 'groups') return { tab: 'agents', chatSection: 'groups', groupSub: 'local' };
      if (raw === 'cross') return { tab: 'agents', chatSection: 'groups', groupSub: 'cross' };
      if (raw === 'taskRooms') return { tab: 'tasks', chatSection: 'taskRooms' };
      if (raw === 'direct') return { tab: 'agents', chatSection: 'direct' };
      if (raw === 'session' || raw === 'remote') return { tab: 'agents', chatSection: 'remote' };
      if (raw === 'agents') return { tab: 'agents' };
      if (raw === 'rosters') return { tab: 'agents', agentSub: 'rosters' };
      if (raw === 'memory') return { tab: 'memory' };
      return { tab: 'tasks' };
    }
    function formatSessionTime(ts) {
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    }
    const PANEL = 'dsh-marshal';
    const buttonStyle = { border: '1px solid #8885', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, padding: '6px 12px', cursor: 'pointer' };
    function Statistics({ value, agent }) {
      if (!value) return null;
      const number = key => Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : undefined;
      const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      const codex = agent === 'codex';
      const turns = number('turns'), steps = number('steps'), ms = number(codex ? 'turnMs' : 'decodeMs'), decoded = number(codex ? 'turnOutputTokens' : 'decodeTokens');
      const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(number);
      const all = buckets.every(n => n !== undefined), input = all ? buckets[0] + buckets[2] + buckets[3] : 0;
      const context = number('contextTokens'), limit = number('contextWindow');
      const parts = [
        [turns === undefined ? '' : turns + ' 轮', steps === undefined ? '' : steps + ' 步', ms > 0 && decoded !== undefined ? (codex ? '平均 ' : '') + Math.round(decoded * 1000 / ms) + ' tok/s' : ''].filter(Boolean).join(' · '),
        all ? compact(number('totalTokens') ?? buckets.reduce((sum, n) => sum + n, 0)) + ' tok' + (input > 0 ? ' · 缓存命中 ' + Math.round(buckets[2] * 100 / input) + '%' : '') : '',
        context !== undefined && limit > 0 ? '上下文 ' + Math.min(100, Math.round(context * 100 / limit)) + '%' : '',
      ].filter(Boolean);
      return parts.length ? h('div', { 'aria-label': codex ? 'Codex 会话统计' : 'DSH 会话统计', title: codex ? '来自 Codex 原生用量；累计 token 包含缓存和思考。平均速度为最近可统计完整回合的输出 token / 总耗时，包含思考、工具和网络等待；不是纯解码速度。' : '来自源端 DSH 的会话累计统计；速度为输出解码速度', style: { display: 'flex', flexWrap: 'wrap', gap: '6px 22px', padding: '8px 22px 14px', fontSize: 12, opacity: .65, fontVariantNumeric: 'tabular-nums' } }, ...parts.map((text, i) => h('span', { key: i }, text))) : null;
    }
    function MarshalIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('rect', { x: 7, y: 2, width: 10, height: 7, rx: 1.5 }), h('path', { d: 'M12 9v5M5 14h14M5 14v3M19 14v3' }),
        h('rect', { x: 2, y: 17, width: 6, height: 5, rx: 1 }), h('rect', { x: 16, y: 17, width: 6, height: 5, rx: 1 }));
    }
    function readAddress(role, signal) {
      // Without an entry role, use the same local base as fetchJson, not an HTTPS dashboard.
      if (role === undefined) return new URL('.', document.baseURI).href.replace(/\/$/, '');
      return readDashboardAddress(role, signal);
    }
    async function readDashboardAddress(role, signal) {
      const response = await fetch(new URL(`marshal/entry/${role}`, document.baseURI), { signal });
      if (!response.ok) return null;
      const data = await response.json(); const url = new URL(data.dashboardUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
      url.pathname += '/desktop'; return { url: url.href, accountLogin: data.accountLogin === true };
    }
    function NativeBody({ renderFactorySlot }) {
      return h('div', { className: 'marshal-native-conversation', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' } },
        h('style', null, '.marshal-native-conversation button[aria-haspopup],.marshal-native-conversation button[aria-label^="访问模式"],.marshal-native-conversation button[aria-label^="计划模式"],.marshal-native-conversation button[aria-label*="分支"],.marshal-native-conversation button[aria-label="好的回答"],.marshal-native-conversation button[aria-label="有问题的回答"] { display:none }'),
        renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }));
    }

