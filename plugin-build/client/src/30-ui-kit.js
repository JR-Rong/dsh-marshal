    const AGENT_TEAM_NAME = '智能体库';
    const dswTheme = {
      bg: 'transparent',
      layer: 'color-mix(in srgb, currentColor 5%, transparent)',
      layer3: 'color-mix(in srgb, currentColor 9%, transparent)',
      border: 'color-mix(in srgb, currentColor 12%, transparent)',
      border2: 'color-mix(in srgb, currentColor 18%, transparent)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      brand: 'var(--dsw-alias-brand-primary)',
      primary: 'var(--dsw-alias-button-primary-fill)',
      primaryText: 'var(--dsw-alias-label-primary-foreground)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      danger: 'var(--dsw-alias-state-error-primary)',
    };
    function tabStyle(active) {
      return {
        border: '1px solid ' + (active ? dswTheme.border2 : 'transparent'),
        background: active ? dswTheme.layer : 'transparent',
        color: active ? dswTheme.text : dswTheme.dim,
        borderRadius: 8,
        padding: '6px 11px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      };
    }
    const uiButton = (primary) => ({
      border: '1px solid ' + (primary ? 'transparent' : dswTheme.border2),
      background: primary ? dswTheme.primary : 'transparent',
      color: primary ? dswTheme.primaryText : dswTheme.text,
      borderRadius: 8,
      padding: '7px 12px',
      fontSize: 12,
      cursor: 'pointer',
      fontFamily: 'inherit',
    });
    const uiInput = {
      width: '100%',
      boxSizing: 'border-box',
      border: '1px solid ' + dswTheme.border2,
      background: dswTheme.layer,
      color: dswTheme.text,
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 12,
      fontFamily: 'inherit',
      outline: 'none',
    };
    const uiMuted = { color: dswTheme.faint, fontSize: 12 };

    function friendlyError(error, area) {
      const message = String(error && error.message ? error.message : error);
      if (error?.code === 'memory-account-unavailable') return area + '需要在 DSH 中登录后重新打开。';
      if (error?.code === 'no-agent-memory') return area + '服务尚未启用。';
      if (error?.code === 'memory-session-invalid' || error?.code === 'unauthorized') return area + '会话已失效，请重新打开页面。';
      if (area.startsWith('记忆') && (error?.code === 'HTTP 404' || error?.code === 'HTTP 405')) return '记忆接口未加载，请检查 Marshal 安装包版本并重启 DSH。';
      if (message.includes('404')) return area + '后端未挂载：智能体需要 @linxin666/dsh-agents，任务看板需要 task-board；安装后重启 DSH';
      if (message.includes('no-task-board') || message.includes('503')) return area + '后端未挂载：请安装 task-board 插件，或升级到带内置看板的构建';
      if (message.includes('no-ledger') || message.includes('no-web-server')) return area + '后端未就绪：请先打开一次智能体并确认 @linxin666/dsh-agents 已启用';
      return area + '失败：' + message;
    }

    const MEMORY_CSRF_COOKIE = 'marshal-memory-csrf';
    const nativeMemory = window.location.protocol === 'dsh-app:' && window.location.hostname === 'app';
    let desktopMemorySession;
    let memorySessionPromise;
    function readBrowserCookie(name) {
      const parts = String(document.cookie || '').split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(name + '=')) return trimmed.slice(name.length + 1);
      }
      return '';
    }
    async function readJson(response) {
      try { return await response.json(); } catch { return null; }
    }
    function requestError(response, data, explain) {
      const code = data?.code ?? 'HTTP ' + response.status;
      return Object.assign(new Error(String(explain ? data?.message || code : code)), { code });
    }
    function memoryProof() {
      return nativeMemory ? desktopMemorySession : (readBrowserCookie(MEMORY_CSRF_COOKIE) || undefined);
    }
    async function ensureMemorySession(rejected) {
      const current = memoryProof();
      if (current && current !== rejected) return current;
      memorySessionPromise ??= fetch(new URL('marshal/memory/session', document.baseURI), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-marshal-memory': '1', ...(nativeMemory ? { 'x-marshal-desktop': '1' } : {}) },
      }).then(async response => {
        const data = await readJson(response);
        if (!response.ok || data?.ok !== true) throw requestError(response, data, true);
        if (nativeMemory) {
          if (typeof data.sessionToken === 'string' && typeof data.csrf === 'string') {
            desktopMemorySession = { 'x-marshal-desktop': '1', 'x-marshal-session': data.sessionToken, 'x-marshal-csrf': data.csrf };
          } else {
            desktopMemorySession = undefined;
          }
        }
        const proof = memoryProof();
        if (!proof) throw Object.assign(new Error('记忆会话凭证不可用。'), { code: 'memory-session-invalid' });
        return proof;
      }).finally(() => { memorySessionPromise = undefined; });
      return memorySessionPromise;
    }
    async function fetchJson(path, body, workspaceAuth = false) {
      const memory = String(path).startsWith('marshal/memory') && !String(path).startsWith('marshal/memory/session');
      const authenticated = memory || workspaceAuth;
      const url = new URL(path, document.baseURI);
      const send = proof => fetch(url, {
        credentials: 'same-origin',
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(typeof proof === 'string' ? { 'x-marshal-csrf': proof } : proof),
        },
      });
      const proof = authenticated ? await ensureMemorySession() : undefined;
      let response = await send(proof);
      let data = await readJson(response);
      if (authenticated && (response.status === 401 || data?.code === 'memory-csrf-mismatch')) {
        response = await send(await ensureMemorySession(proof));
        data = await readJson(response);
      }
      if (!response.ok || data?.ok === false) throw requestError(response, data, authenticated);
      return data;
    }

    const AGENT_TEAM_PREFIX = 'marshal-agent:';
    function isAgentTeam(team) {
      return team.name === AGENT_TEAM_NAME || team.name.startsWith(AGENT_TEAM_PREFIX);
    }

    async function loadAgentLibrary() {
      const state = await fetchJson('dsh-agents/api/state');
      const workspaces = state.workspaces || [];
      const agents = [];
      for (const team of state.teams || []) {
        if (!isAgentTeam(team)) continue;
        for (const member of team.members || []) {
          agents.push({
            ...member,
            squadId: team.id,
            teamName: team.name,
            workspaceId: team.workspaceId,
            workspace: workspaces.find(workspace => workspace.id === team.workspaceId),
            legacy: team.name === AGENT_TEAM_NAME,
          });
        }
      }
      return { agents, workspaces, presets: state.presets || [], models: state.models || [], runs: state.runs || [] };
    }

    async function createAgentTeam(name, workspaceId) {
      const suffix = Math.random().toString(36).slice(2, 8);
      const teamName = AGENT_TEAM_PREFIX + name.replace(/\s+/g, '-').slice(0, 40) + '-' + suffix;
      const created = await fetchJson('dsh-agents/api/team', {
        team: { name: teamName, ...(workspaceId ? { workspaceId } : {}) },
      });
      return created.team;
    }

    async function createTaskTeam(name, workspaceId) {
      const suffix = Math.random().toString(36).slice(2, 8);
      const teamName = 'marshal-agent-task:' + name.replace(/\s+/g, '-').slice(0, 40) + '-' + suffix;
      const created = await fetchJson('dsh-agents/api/team', {
        team: { name: teamName, ...(workspaceId ? { workspaceId } : {}) },
      });
      return created.team;
    }

    async function prepareAgentWorkspace(name, path) {
      try {
        const data = await fetchJson('marshal/workspaces/agent', {
          name,
          ...(path ? { path } : {}),
        });
        return data.path;
      }
      catch (error) {
        const message = String(error && error.message || error);
        if (message.includes('405') || message.includes('404')) {
          throw new Error('服务端还没重启（' + message + '），重启 DSH 后再试');
        }
        throw error;
      }
    }

    async function ensureAgentWorkspace(name, path, service) {
      if (!service || typeof service.create !== 'function') throw new Error('当前 DSH 不支持创建 Agent 工作区');
      const prepared = await prepareAgentWorkspace(name, path);
      const snapshot = service.list && typeof service.list.getSnapshot === 'function' ? service.list.getSnapshot() : undefined;
      const existing = snapshot && Array.isArray(snapshot.items)
        ? snapshot.items.find(item => item.path === prepared)
        : undefined;
      if (existing !== undefined && existing.workspaceId) return existing.workspaceId;
      const created = await service.create({ path: prepared });
      return created.workspaceId;
    }

    async function updateAgentTeam(agent, workspaceId) {
      if (!agent || !agent.squadId || agent.legacy) return;
      await fetchJson('dsh-agents/api/team', {
        team: { id: agent.squadId, name: agent.teamName, ...(workspaceId ? { workspaceId } : {}) },
      });
    }

    function agentInitial(name) {
      const text = String(name || '?').trim();
      return text === '' ? '?' : text.slice(0, 1).toUpperCase();
    }

    function Avatar({ name, size }) {
      const edge = size || 28;
      return h('span', {
        style: {
          width: edge, height: edge, borderRadius: '50%',
          background: 'color-mix(in srgb, ' + dswTheme.brand + ' 22%, transparent)',
          color: dswTheme.brand, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.max(11, Math.round(edge * 0.42)), fontWeight: 600, flexShrink: 0,
        },
      }, agentInitial(name));
    }


    function installSidebarWorkspaceSwitch() {
      if (typeof document === 'undefined' || window.__marshalSidebarSwitch === true) return;
      window.__marshalSidebarSwitch = true;
      if (!document.getElementById('marshal-scope-style')) {
        const style = document.createElement('style');
        style.id = 'marshal-scope-style';
        style.textContent = '[data-marshal-scope-hidden="1"]{display:none!important}';
        document.head.appendChild(style);
      }
      const groupFor = row => {
        let node = row;
        while (node.parentElement !== null && node.parentElement.getAttribute('role') !== 'tree') node = node.parentElement;
        return node.parentElement === null ? undefined : node;
      };
      const titleNode = row => row.querySelector('[class*="title"]');
      const isAgentRow = row => {
        if (row.dataset.marshalAgent === '1') return true;
        const title = titleNode(row)?.textContent?.trim() ?? row.textContent.trim();
        if (title.startsWith('Agent · ')) { row.dataset.marshalAgent = '1'; return true; }
        return false;
      };
      const apply = () => {
        const oldToggle = document.getElementById('marshal-scope-switch');
        if (oldToggle) oldToggle.remove();
        const wrapper = document.querySelector('[data-slot="sidebar.workspaces"]');
        if (wrapper === null) return;
        const rows = [...wrapper.querySelectorAll('[data-row-key^="workspace:"]')];
        const seen = new Set();
        for (const row of rows) {
          const group = groupFor(row);
          if (group === undefined || seen.has(group)) continue;
          seen.add(group);
          const agent = isAgentRow(row);
          group.setAttribute('data-marshal-scope-hidden', agent ? '1' : '0');
        }
        for (const group of wrapper.querySelectorAll('[class*="groupSection"]')) {
          if (seen.has(group)) continue;
          group.setAttribute('data-marshal-scope-hidden', '0');
        }
      };
      const schedule = () => { requestAnimationFrame(() => { apply(); }); };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      setInterval(apply, 1500);
      apply();
    }

    function MarshalNav({ active, onTab, compact = false }) {
      const normalized = resolveNavTarget(active).tab;
      const tabs = [
        ['tasks', '任务看板'],
        ['chats', '会话'],
        ['agents', '智能体'],
        ['memory', '记忆'],
      ];
      return h('div', {
        id: 'marshal-quick-nav',
        'data-active': normalized,
        role: 'navigation', 'aria-label': '调度官主导航',
        style: {
          display: 'flex', alignItems: 'center', gap: 2, padding: 3,
          borderRadius: 999, border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
          background: 'color-mix(in srgb, currentColor 5%, transparent)',
          flexShrink: 0, maxWidth: '100%', overflowX: 'auto',
        },
      },
        tabs.map(([key, label]) => h('button', {
          key, type: 'button', 'aria-pressed': normalized === key,
          style: {
            border: 0, borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
            font: (compact ? '11px/1' : '12px/1') + ' inherit',
            padding: compact ? '6px 11px' : '7px 13px',
            background: normalized === key ? 'color-mix(in srgb, currentColor 16%, transparent)' : 'transparent',
            color: 'inherit', fontWeight: normalized === key ? 600 : 400,
            transition: 'background .15s ease',
          },
          onClick: () => onTab(key),
        }, label)));
    }

    function Field({ label, children }) {
      return h('label', { style: { display: 'grid', gap: 6, fontSize: 12, color: dswTheme.dim } }, label, children);
    }

    function EmptyState({ title, hint, action, onAction }) {
      return h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 40, textAlign: 'center' } },
        h('div', { style: { width: 46, height: 46, borderRadius: 15, border: '1px solid ' + dswTheme.border2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: dswTheme.faint } },
          h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
            h('circle', { cx: 9, cy: 9, r: 3 }), h('circle', { cx: 16.5, cy: 10, r: 2.2 }),
            h('path', { d: 'M3 19c0-2.7 2.4-4.4 6-4.4s6 1.7 6 4.4' }),
            h('path', { d: 'M15 19c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6' }))),
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
        hint && h('div', { style: { fontSize: 12, color: dswTheme.faint, maxWidth: 320, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, hint),
        action && h('button', { type: 'button', style: uiButton(false), onClick: onAction }, action));
    }

