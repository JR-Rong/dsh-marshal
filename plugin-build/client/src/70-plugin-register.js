    return {
      inject: ['slots'],
      // Reusable UI exposed as components on the dsh-marshal/client module.
      components: Object.freeze({ ...mvCascadePicker, ...mvDagSidebar }),
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
        const service = mvService;
        const register = (options, Comp, list, slots = service(ctx, 'slots')) => {
          try {
            if (typeof slots?.register !== 'function') return;
            track(typeof slots.inject === 'function'
              ? slots.inject(options.name, () => slots.register(options, Comp)) : slots.register(options, Comp), list);
          }
          catch {} // Optional slots are not declared in all host versions.
        };
        const routes = createMvStore(null);
        const routeLifetime = new AbortController();
        const openSessionRef = { current: undefined };
        const layoutRef = { current: undefined };
        let desktopContext, nativeContext, tabTimer, mvCancelNative;
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
          mvCancelNative?.();
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
          mvCancelNative?.();
          clearTimeout(tabTimer);
          pendingTab = null;
          const route = { kind, item };
          routes.set(route);
          openPanel(PANEL);
          try { window.dispatchEvent(new CustomEvent('marshal:room', { detail: route })); } catch {}
        };
        const mvDirectLookups = new Map();
        const onOpenAgentDirect = (agent, canOpen) => {
          const key = agent.agentKey;
          if (mvDirectLookups.has(key)) return mvDirectLookups.get(key);
          const { signal } = routeLifetime;
          const resolve = async () => {
            // Overview may point at a ticket run; only the direct endpoint proves ownership.
            const result = await mvRead(mvAgentQuery('agent-direct-sessions', key), signal);
            if (result?.mainSession !== null || !agent.teamId || !agent.agentId || !canOpen()) return result?.mainSession &&
              { sessionId: mvSessionId(result.mainSession), agentKey: result.agentKey };
            const created = await fetchJson('dsh-agents/api/run', {
              teamId: agent.teamId, memberId: agent.agentId, purpose: 'direct',
            }, false, signal);
            return { sessionId: created?.run?.sessionId, agentKey: result.agentKey };
          };
          const request = resolve().finally(() => mvDirectLookups.delete(key));
          mvDirectLookups.set(key, request);
          return request;
        };
        let mvNativeDirect, mvStartVoice;
        const MarshalDesktopPanel = props => {
          // The default panel still works on hosts without the vNext sidebar slots.
          const route = typeof React.useSyncExternalStore === 'function' ? useMvSnapshot(routes) : null;
          if (!route) return h(SafeMarshalPanel, props);
          const { kind, item } = route;
          const key = kind + ':' + (item.agentKey ?? item.id);
          return h('div', { className: 'mv-scope mv-stack mv-routed' },
            h('header', { className: 'mv-line' }, h(MvButton, { icon: 'back', label: '返回调度官', onClick: () => routes.set(null) })),
            h(MarshalErrorBoundary, { resetKey: kind === 'taskRooms' ? 'taskRooms-' + (item.taskId || 'archive') : key },
              h('div', { className: 'mv-room-fill' },
                kind === 'taskRooms' ? h(MarshalTicketRoomView, { key, task: { id: item.taskId, title: item.title, taskRoom: item }, openBoard: () => goTab('tasks') })
                  : kind === 'direct' ? h(AgentDirectChatsView, { key, initialAgentId: item.agentId, openSession: props.openSession,
                    mvOpenDirect: props.mvOpenDirect, onOpenAgents: () => goTab('agents') })
                    : h(MarshalSidebarGroupRoom, { key, route, ownerSignal: routeLifetime.signal }))));
        };
        register({
            name: 'conversation.session.header.actions',
            id: 'marshal-quick-nav',
            order: 40,
          }, () => h(MarshalNav, { active: 'agents', onTab: goTab, compact: true }));
        register({ name: 'main', key: PANEL,
          children: { 'marshal.native.body': { kind: 'single', scope: 'session' } },
          inject: () => ({
            marshalContext: desktopContext ?? nativeContext ?? ctx,
            openSession: sessionId => openSessionRef.current?.(sessionId),
            mvOpenDirect: agent => mvNativeDirect?.(agent),
            closeMemorySidebar: () => {
              const sidebarRight = service(desktopContext, 'sidebarRight') ?? service(ctx, 'sidebarRight');
              if (typeof sidebarRight?.closeTab === 'function') return sidebarRight.closeTab();
              return sidebarRight?.close?.();
            },
            mvStartVoice: agent => mvStartVoice?.(agent),
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
            mvStartVoice = agent => voiceLayer.getSnapshot()?.start(agent);
            const idleVoice = createMvStore(mvVoiceIdle);
            const runtime = mvCreateAgentTasks();
            track(runtime, lifetime);
            const rightbar = () => service(ctx, 'sidebarRight') ?? service(desktopContext, 'sidebarRight');
            const navCtx = { layout: { selectPanel: openPanel }, get sidebarRight() { return rightbar(); } };
            let mvNavigationAttempt;
            let mvDockMounted = false;
            let mvTasksTabRegistered = false;
            mvCancelNative = () => {
              mvNavigationAttempt?.abort();
              runtime.drawer.set(null);
            };
            const canOpenNative = () => Boolean(openSessionRef.current || typeof service(ctx, 'uiWorkspace')?.openSession === 'function');
            const openNative = (agent, sessionId) => {
              if (routeLifetime.signal.aborted) return;
              mvCancelNative();
              mvNavigationAttempt = new AbortController();
              const { signal } = mvNavigationAttempt;
              return mvOpenAgentDirectSession({
                agent, sessionId, ctx: navCtx, onOpenAgentDirect: row => onOpenAgentDirect(row, canOpenNative),
                openSessionRef, uiWorkspace: service(ctx, 'uiWorkspace'),
                mvFocusedAgentStore: runtime.focus, signal,
                openDrawer: (owner, id, signal) => {
                  routes.set(null);
                  const service = rightbar();
                  if (!service && !mvTasksTabRegistered) return; // Slim host with no rightbar.
                  if (mvDockMounted && typeof service?.active === 'function' && typeof service?.screen !== 'function') {
                    runtime.drawer.set(id);
                    return;
                  }
                  return mvOpenTasksTab(owner, { sessionId: id, signal });
                },
              });
            };
            mvNativeDirect = agent => openNative({
              ...agent, agentKey: agent.agentKey ?? `${agent.teamId ?? agent.squadId}/${agent.agentId ?? agent.id}`,
              teamId: agent.teamId ?? agent.squadId, agentId: agent.agentId ?? agent.id,
            });
            const openSidebarAgent = (agent, fromPrimary) => {
              if (!canOpenNative() && !fromPrimary) { openRoom('direct', agent); return; }
              return mvNativeDirect(agent);
            };
            const navigation = {
              openAgent: agent => mvNativeDirect?.(agent),
              openDrawer: options => mvOpenTasksTab(navCtx, options),
              async openSubSession(agent, id, taskId) {
                const message = await openNative(agent, id);
                if (message) throw Error(message);
                if (!runtime.signal.aborted && runtime.focus.getSnapshot()?.navigationSessionId === id) {
                  runtime.setSelection(agent.agentKey, () => ({ focusedId: taskId, selected: [] }));
                }
              },
              async openTicket(id, card, agent, chosenWorkspaceId) {
                if (runtime.signal.aborted) return;
                const ticket = runtime.tickets.getSnapshot().items.find(row => row.id === id);
                let room = [card?.taskRoom, sidebar.getSnapshot().rooms.find(row => row.taskId === id && row.id),
                  ticket?.taskRoom].find(row => row?.id);
                if (!room) {
                  card ??= ticket;
                  let workspaceId = [card?.workflow?.workspaceId, card?.workspaceId, agent?.workspaceId, chosenWorkspaceId].find(mvValidWorkspaceId);
                  if (!workspaceId) {
                    const options = await mvReadTicketWorkspaces(runtime.signal);
                    if (runtime.signal.aborted) return;
                    if (options.length > 1) return options;
                    if (!options.length) throw Error('没有可用的工单工作区。');
                    workspaceId = options[0].id;
                  }
                  room = (await fetchJson('marshal/task-rooms/open', { taskId: id, workspaceId }, true, runtime.signal))?.room;
                  if (!runtime.signal.aborted && !room?.id) throw Error('未确认工单群已绑定。');
                }
                if (!runtime.signal.aborted && room?.id) openRoom('taskRooms', room);
              },
            };
            const agentSlots = { runtime, voiceLayer, idleVoice, navigation };
            const AgentTasksRightbarTab = props => h(mvAgentTasksRightbarTab, { ...props, ...agentSlots });
            const AgentComposerDockBar = props => h(mvAgentComposerDockBar, { ...props, ...agentSlots });
            const installTasksTab = registry => {
              const resources = [];
              try {
                const slots = service(ctx, 'slots');
                if (!slots?.register || !registry?.register) return;
                track(mvRegisterTasksTab(registry), resources);
                register({ name: 'sidebar.right.pane.tab', key: MV_TASK_TAB_ID }, AgentTasksRightbarTab, resources, slots);
                mvTasksTabRegistered = true;
              } catch { clean(resources); }
              return () => { mvTasksTabRegistered = false; clean(resources); };
            };
            try {
              const registry = service(ctx, 'sidebarRightTabs');
              if (registry) track(installTasksTab(registry), lifetime);
              else track(ctx.inject?.(['sidebarRightTabs'], inner => installTasksTab(service(inner, 'sidebarRightTabs'))), lifetime);
            } catch {}
            try {
              const slots = service(ctx, 'slots');
              const options = { name: 'conversation.input.dock', id: MV_TASK_TAB_ID, order: 30 };
              const mountDock = () => {
                const handle = slots.register(options, AgentComposerDockBar);
                mvDockMounted = true;
                return handle;
              };
              if (typeof slots?.register === 'function') track(typeof slots.inject === 'function'
                ? slots.inject(options.name, mountDock) : mountDock(), lifetime);
            } catch {}
            let closed = false;
            track(() => {
              closed = true;
              mvDockMounted = false;
              mvNativeDirect = undefined;
              mvStartVoice = undefined;
              mvCancelNative?.();
              mvCancelNative = undefined;
              voiceLayer.getSnapshot()?.dispose();
              voiceLayer.set(null);
              voiceLayer.clear();
            }, lifetime);
            const PanelItem = props => h(MarshalSidebarPanelItem, { ...props, sidebar, openPanel });
            const MountedVoiceLayer = () => {
              const voice = useMvSnapshot(voiceLayer);
              const guidance = useMvSnapshot(runtime.modal);
              React.useEffect(() => {
                if (closed) return;
                const provider = createLocalVoiceSessionProvider();
                voiceLayer.set(provider);
                return () => {
                  provider.dispose();
                  if (voiceLayer.getSnapshot() === provider) voiceLayer.set(null);
                };
              }, []);
              return h(React.Fragment, null, voice && h(MarshalVoiceCallOverlay, { voice,
                guidanceRuntime: mvTasksTabRegistered || guidance ? runtime : undefined }),
                guidance && h(mvSyncGuidanceModal, { runtime, data: guidance }),
                h(MarshalSidebarPortal, { target, sidebar, openRoom, onOpenAgentDirect: openSidebarAgent }));
            };
            const SessionAction = props => {
              const voice = useMvSnapshot(voiceLayer);
              return h(MarshalSessionActionHoc, { ...props, sidebar, voice: voice ?? idleVoice, onOpenAgentDirect: openSidebarAgent,
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
