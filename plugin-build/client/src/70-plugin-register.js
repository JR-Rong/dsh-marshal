    return {
      inject: ['slots', 'sessions', 'uiSession', 'uiConversation'],
      apply(ctx) {
        const disposers = [];
        const track = handle => {
          if (typeof handle === 'function') disposers.push(handle);
          else if (handle && typeof handle.dispose === 'function') disposers.push(() => handle.dispose());
        };
        try {
          const existingStyle = document.getElementById('marshal-consolidated-rows');
          const style = existingStyle || document.createElement('style');
          style.id = 'marshal-consolidated-rows';
          style.textContent = 'button:has([data-dsh-panel-entry="agents"]),[role="button"]:has([data-dsh-panel-entry="agents"]),li:has([data-dsh-panel-entry="agents"]),button:has([data-dsh-panel-entry="task-board"]),[role="button"]:has([data-dsh-panel-entry="task-board"]),li:has([data-dsh-panel-entry="task-board"]){display:none!important}[data-dsh-taskboard-view]{padding-top:44px!important;box-sizing:border-box!important;position:relative}';
          if (!existingStyle) document.head.appendChild(style);
        } catch (error) { /* a DOM-less host keeps its own panel list */ }
        installSidebarWorkspaceSwitch();
        const openSessionRef = { current: undefined };
        const layoutRef = { current: undefined };
        const workspacesRef = { current: undefined };
        try {
          track(ctx.inject(['uiWorkspace'], inner => {
            const workspace = inner.get('uiWorkspace');
            openSessionRef.current = sessionId => { if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId); };
            return () => { openSessionRef.current = undefined; };
          }));
        } catch {}
        try {
          track(ctx.inject(['layout'], inner => {
            layoutRef.current = inner.get('layout');
            return () => { layoutRef.current = undefined; };
          }));
        } catch {}
        try {
          track(ctx.inject(['workspaces'], inner => {
            workspacesRef.current = inner.get('workspaces');
            return () => { workspacesRef.current = undefined; };
          }));
        } catch {}
        const openPanel = id => {
          try {
            const layout = layoutRef.current ?? (ctx.get && ctx.get('layout'));
            if (layout && typeof layout.selectPanel === 'function') { layout.selectPanel(id); return true; }
          } catch (error) { /* layout unavailable */ }
          return false;
        };
        const goTab = tab => {
          pendingTab = tab;
          openPanel(PANEL);
          try { window.dispatchEvent(new CustomEvent('marshal:tab', { detail: tab })); } catch (error) { /* host without window */ }
          setTimeout(() => {
            try { window.dispatchEvent(new CustomEvent('marshal:tab', { detail: tab })); } catch (error) { /* host without window */ }
          }, 60);
        };
        try {
          track(ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'marshal-quick-nav',
            order: 40,
          }, () => h(MarshalNav, { active: 'chats', onTab: goTab, compact: true }))));
        } catch (error) { /* older host without the conversation header action slot */ }
        const ensureTaskboardHeader = () => {
          if (typeof document === 'undefined') return;
          const root = document.querySelector('[data-dsh-taskboard-view]');
          if (root === null || root.querySelector('#marshal-taskboard-head') !== null) return;
          const bar = document.createElement('div');
          bar.id = 'marshal-taskboard-head';
          bar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);z-index:6;color:inherit;font-family:inherit';
          const title = document.createElement('div');
          title.textContent = '任务看板';
          title.style.cssText = 'font-size:14px;font-weight:600;white-space:nowrap';
          const nav = document.createElement('div');
          nav.style.cssText = 'display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;border:1px solid color-mix(in srgb, currentColor 14%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);overflow-x:auto;max-width:100%';
          const add = (label, key) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.setAttribute('aria-pressed', key === 'tasks' ? 'true' : 'false');
            button.style.cssText = 'border:0;border-radius:999px;cursor:pointer;white-space:nowrap;font:11px/1 inherit;padding:6px 9px;color:inherit;background:' + (key === 'tasks' ? 'color-mix(in srgb, currentColor 16%, transparent)' : 'transparent') + ';font-weight:' + (key === 'tasks' ? '600' : '400');
            button.onclick = () => {
              goTab(key);
            };
            nav.appendChild(button);
          };
          add('任务看板', 'tasks');
          add('会话', 'chats');
          add('智能体', 'agents');
          add('记忆', 'memory');
          bar.append(title, nav);
          root.prepend(bar);
        };
        ensureTaskboardHeader();
        const headerTimer = setInterval(ensureTaskboardHeader, 1000);
        disposers.push(() => clearInterval(headerTimer));
        track(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 25, label: () => '调度官' }, MarshalIcon)));
        track(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
          children: { 'marshal.native.body': { kind: 'single', scope: 'session' } },
          inject: () => ({
            marshalContext: ctx,
            openSession: sessionId => openSessionRef.current?.(sessionId),
            openPanel,
            workspaceService: () => {
              if (workspacesRef.current) return workspacesRef.current;
              try { return ctx.get?.('workspaces'); } catch { return undefined; }
            },
          }),
        }, SafeMarshalPanel)));
        track(ctx.slots.inject('marshal.native.body', () => ctx.slots.register({ name: 'marshal.native.body' }, NativeBody)));
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            for (const dispose of disposers.splice(0).reverse()) {
              try { dispose(); } catch {}
            }
          }, 'marshal: client lifecycle');
        }
      },
    };
