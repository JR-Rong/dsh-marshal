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
          style.textContent = 'button:has([data-dsh-panel-entry="agents"]),[role="button"]:has([data-dsh-panel-entry="agents"]),li:has([data-dsh-panel-entry="agents"]),button:has([data-dsh-panel-entry="task-board"]),[role="button"]:has([data-dsh-panel-entry="task-board"]),li:has([data-dsh-panel-entry="task-board"]){display:none!important}';
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
            disposeAllMarshalSse();
            for (const dispose of disposers.splice(0).reverse()) {
              try { dispose(); } catch {}
            }
          }, 'marshal: client lifecycle');
        }
      },
    };
