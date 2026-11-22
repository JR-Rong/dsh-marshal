    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        const track = (handle, list = disposers) => {
          if (typeof handle === 'function') list.push(handle);
          else if (handle && typeof handle.dispose === 'function') list.push(() => handle.dispose());
        };
        const clean = list => {
          for (const dispose of list.splice(0).reverse()) {
            try { void Promise.resolve(dispose()).catch(() => {}); } catch {}
          }
        };
        const service = (owner, name) => {
          let value;
          try { value = owner?.get?.(name); } catch {}
          try { return value ?? owner?.[name]; } catch { return undefined; }
        };
        const register = (options, Comp, list) => {
          const slots = service(ctx, 'slots');
          try { track(slots?.inject?.(options.name, () => slots.register(options, Comp)), list); }
          catch {} // Optional slots are not declared in all host versions.
        };
        const routes = createMvStore(null);
        const routeLifetime = new AbortController();
        const openSessionRef = { current: undefined };
        const layoutRef = { current: undefined };
        let desktopContext, nativeContext, tabTimer;
        const workspacesRef = { current: undefined };
        try {
          track(ctx.inject(['uiWorkspace'], inner => {
            const workspace = service(inner, 'uiWorkspace');
            if (typeof workspace?.openSession === 'function') openSessionRef.current = sessionId => workspace.openSession(sessionId);
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
            const layout = service(desktopContext, 'layout') ?? layoutRef.current ?? service(ctx, 'layout');
            if (layout && typeof layout.selectPanel === 'function') return layout.selectPanel(id) !== false;
          } catch (error) { /* layout unavailable */ }
          return false;
        };
        const goTab = tab => {
          pendingTab = tab;
          routes.set(null);
          openPanel(PANEL);
          try { window.dispatchEvent(new CustomEvent('marshal:tab', { detail: tab })); } catch (error) { /* host without window */ }
          clearTimeout(tabTimer);
          tabTimer = setTimeout(() => {
            try { window.dispatchEvent(new CustomEvent('marshal:tab', { detail: tab })); } catch (error) { /* host without window */ }
          }, 60);
        };
        const openRoom = (kind, item) => {
          clearTimeout(tabTimer);
          pendingTab = null;
          const route = { kind, item };
          routes.set(route);
          openPanel(PANEL);
          try { window.dispatchEvent(new CustomEvent('marshal:room', { detail: route })); } catch {}
        };
        const onOpenAgentDirect = async (agent, preferNative = false) => {
          if (!preferNative) {
            openRoom('direct', agent);
            return;
          }
          const { signal } = routeLifetime;
          try {
            // Only the direct-session endpoint excludes ticket and other non-direct runs.
            const result = await fetchJson('marshal/agent-direct-sessions?' + new URLSearchParams({ agentKey: agent.agentKey }),
              undefined, true, signal);
            if (signal.aborted) return;
            let id = result?.mainSession?.sessionId ?? result?.mainSession?.id;
            const open = openSessionRef.current;
            if (result?.mainSession === null && agent.teamId && agent.agentId) {
              if (!open) return '宿主无法打开 1:1 直连会话。';
              // Ordinary member runs are not eligible for direct sessions or guidance sync.
              const created = await fetchJson('dsh-agents/api/run', {
                teamId: agent.teamId, memberId: agent.agentId, purpose: 'direct',
              }, false, signal);
              if (signal.aborted) return;
              id = created?.run?.sessionId;
              if (typeof id !== 'string' || !id.trim()) return '未能创建 1:1 直连会话。';
            }
            if (typeof id !== 'string' || !id.trim()) return '暂无 1:1 直连会话。';
            if (!open || await open(id) === false) return '宿主无法打开 1:1 直连会话。';
          } catch {
            if (!signal.aborted) return '无法打开 1:1 直连会话，请稍后重试。';
          }
        };
        const MarshalDesktopPanel = props => {
          // The default panel still works on hosts without the vNext sidebar slots.
          const route = typeof React.useSyncExternalStore === 'function' ? useMvSnapshot(routes) : null;
          if (!route) return h(SafeMarshalPanel, props);
          const { kind, item } = route;
          const key = kind + ':' + (item.agentKey ?? item.id);
          return h('div', { className: 'mv-scope mv-stack mv-routed' },
            h('header', { className: 'mv-line' }, h(MvButton, { icon: 'back', label: '返回调度官', onClick: () => routes.set(null) })),
            h(MarshalErrorBoundary, { resetKey: key },
              h('div', { className: 'mv-room-fill' },
                kind === 'taskRooms' ? h(TaskRoomsPage, { key, task: { id: item.taskId, title: item.title, taskRoom: item }, openBoard: () => goTab('tasks') })
                  : kind === 'direct' ? h(AgentDirectChatsView, { key, initialAgentId: item.agentId, openSession: props.openSession, onOpenAgents: () => goTab('agents') })
                    : h(MarshalSidebarGroupRoom, { key, route, ownerSignal: routeLifetime.signal }))));
        };
        register({
            name: 'conversation.session.header.actions',
            id: 'marshal-quick-nav',
            order: 40,
          }, () => h(MarshalNav, { active: 'chats', onTab: goTab, compact: true }));
        register({ name: 'main', key: PANEL,
          children: { 'marshal.native.body': { kind: 'single', scope: 'session' } },
          inject: () => ({
            marshalContext: desktopContext ?? nativeContext ?? ctx,
            openSession: sessionId => openSessionRef.current?.(sessionId),
            openPanel,
            workspaceService: () => {
              if (workspacesRef.current) return workspacesRef.current;
              try { return ctx.get?.('workspaces'); } catch { return undefined; }
            },
          }),
        }, MarshalDesktopPanel);
        register({ name: 'marshal.native.body' }, NativeBody);
        try {
          track(ctx.inject(['sessions', 'uiSession', 'uiConversation'], inner => {
            nativeContext = inner;
            return () => { nativeContext = undefined; };
          }));
        } catch {}
        try {
          track(ctx.inject(['layout', 'slots', 'sessions', 'uiSession', 'uiConversation'], inner => {
            desktopContext = inner;
            return () => { desktopContext = undefined; };
          }));
        } catch {}
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const lifetime = [];
            track(ensureMarshalVnextStyles(), lifetime);
            try {
              // The legacy board and room renderers still lazily install these sheets.
              const lazySheets = ['marshal-taskboard-styles', 'marshal-taskroom-styles']
                .filter(id => !document.getElementById(id));
              track(() => lazySheets.forEach(id => document.getElementById(id)?.remove()), lifetime);
              if (!document.getElementById('marshal-consolidated-rows')) {
                const style = document.createElement('style');
                style.id = 'marshal-consolidated-rows';
                style.textContent = 'button:has([data-dsh-panel-entry=\"agents\"]),[role=\"button\"]:has([data-dsh-panel-entry=\"agents\"]),li:has([data-dsh-panel-entry=\"agents\"]),button:has([data-dsh-panel-entry=\"task-board\"]),[role=\"button\"]:has([data-dsh-panel-entry=\"task-board\"]),li:has([data-dsh-panel-entry=\"task-board\"]){display:none!important}';
                document.head.appendChild(style);
                track(() => style.remove(), lifetime);
              }
            } catch {}
            const sidebar = createMarshalSidebarData();
            const target = mountSidebarSectionsPortal();
            track(sidebar, lifetime);
            track(target, lifetime);
            const voiceLayer = createMvStore(null);
            const idleVoice = createMvStore(mvVoiceIdle);
            let closed = false;
            track(() => {
              closed = true;
              voiceLayer.getSnapshot()?.dispose();
              voiceLayer.set(null);
              voiceLayer.clear();
            }, lifetime);
            const PanelItem = props => h(MarshalSidebarPanelItem, { ...props, sidebar, openPanel });
            const MountedVoiceLayer = () => {
              const voice = useMvSnapshot(voiceLayer);
              React.useEffect(() => {
                if (closed) return;
                const provider = createLocalVoiceSessionProvider();
                voiceLayer.set(provider);
                return () => {
                  provider.dispose();
                  if (voiceLayer.getSnapshot() === provider) voiceLayer.set(null);
                };
              }, []);
              return h(React.Fragment, null, voice && h(MarshalVoiceCallOverlay, { voice }),
                h(MarshalSidebarPortal, { target, sidebar, openRoom, onOpenAgentDirect }));
            };
            const SessionAction = props => {
              const voice = useMvSnapshot(voiceLayer);
              return h(MarshalSessionActionHoc, { ...props, sidebar, voice: voice ?? idleVoice, onOpenAgentDirect,
                voiceAvailable: Boolean(voice) });
            };
            register({ name: 'sidebar.panellist', id: PANEL, order: 25, label: () => '调度官' }, PanelItem, lifetime);
            register({ name: 'sidebar.session.action', id: 'marshal-primary-agent' }, SessionAction, lifetime);
            register({ name: 'shell.overlay', id: 'marshal-voice-call' }, MountedVoiceLayer, lifetime);
            return () => {
              clearTimeout(tabTimer);
              pendingTab = null;
              routeLifetime.abort();
              clean(lifetime);
              clean(disposers);
              routes.set(null);
              routes.clear();
            };
          }, 'marshal: client lifecycle');
          ctx.effect(() => () => {
            disposeAllMarshalSse();
          }, 'marshal: SSE lifecycle');
        } else {
          register({ name: 'sidebar.panellist', id: PANEL, order: 25, label: () => '调度官' }, MarshalIcon);
        }
      },
    };
