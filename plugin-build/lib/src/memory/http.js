const BODY_LIMIT = 64 * 1024;

function write(res, status, value, cookies) {
    if (cookies !== undefined) res.setHeader('set-cookie', cookies);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > BODY_LIMIT) {
            const error = new Error('body-too-large');
            error.code = 'body-too-large';
            throw error;
        }
        chunks.push(buffer);
    }
    if (size === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch {
        const error = new Error('invalid-json');
        error.code = 'invalid-json';
        throw error;
    }
}

function queryOf(req) {
    return new URL(req.url ?? '/', 'http://marshal.local').searchParams;
}

function unavailable(res) {
    write(res, 503, { ok: false, code: 'no-agent-memory' });
}

/**
 * Local /marshal/memory/* routes.
 * Every read and write is bound to the session created for the desktop owner.
 * Global approval and direct global edits are owner-only. Browser writes check
 * the CSRF cookie and header. The native DSH proxy uses proof headers instead.
 */
export function createMemoryRoutes({ memory, auth, allowedOrigins, eventBus } = {}) {
    const origins = () => typeof allowedOrigins === 'function' ? allowedOrigins() : allowedOrigins;
    const writeChanged = (res, value, changed = true) => {
        write(res, 200, value);
        if (changed) {
            eventBus?.emit('memory.changed');
            eventBus?.emit('incidents.changed');
        }
    };
    const guard = (writeNeeded, handler, { owner = false, target = false } = {}) => async (req, res) => {
        if (memory === undefined || auth === undefined) { unavailable(res); return; }
        const authn = auth.authenticate(req, { write: writeNeeded, origins: origins() });
        if (!authn.ok) { write(res, authn.status, { ok: false, code: authn.code }); return; }
        if (owner && authn.session.owner !== true) {
            write(res, 403, { ok: false, code: 'sign-in-to-approve', message: '请先登录机主账号后再审批全局记忆' });
            return;
        }
        let body;
        if (writeNeeded) {
            try { body = await readBody(req); }
            catch (error) { write(res, 400, { ok: false, code: error.code ?? 'invalid-json' }); return; }
        }
        const url = writeNeeded ? undefined : queryOf(req);
        const requested = {
            agentId: writeNeeded ? (typeof body.agentId === 'string' ? body.agentId : undefined) : (url.get('agentId') ?? undefined),
            workspaceId: writeNeeded ? (typeof body.workspaceId === 'string' ? body.workspaceId : undefined) : (url.get('workspaceId') ?? undefined),
            scope: writeNeeded ? body.scope : (url.get('scope') ?? undefined),
        };
        if (target && !auth.allows(authn.session, requested)) { write(res, 403, { ok: false, code: 'owner-mismatch' }); return; }
        await handler(req, res, { session: authn.session, body, url, requested });
    };
    return [
        {
            method: 'POST', path: '/marshal/memory/session',
            async handler(req, res) {
                if (auth === undefined) { unavailable(res); return; }
                const opened = await auth.open(req, origins());
                if (!opened.ok) { write(res, opened.status, { ok: false, code: opened.code }); return; }
                const session = opened.session;
                write(res, 200, { ok: true, owner: session.owner === true,
                    ...(session.desktop ? { sessionToken: session.id, csrf: session.csrf } : {}),
                }, opened.cookies);
            },
        },
        {
            method: 'GET', path: '/marshal/memory/settings/get',
            handler: guard(false, (_req, res, { session }) => {
                if (session.owner !== true) { write(res, 403, { ok: false, code: 'owner-only' }); return; }
                write(res, 200, { ok: true, settings: memory.settings });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/settings',
            handler: guard(true, (_req, res, { body }) => {
                write(res, 200, { ok: true, settings: memory.saveSettings(body) });
            }, { owner: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/proposals',
            handler: guard(false, (_req, res) => {
                write(res, 200, { ok: true, proposals: memory.listProposals() });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/proposals/approve',
            handler: guard(true, (_req, res, { body }) => {
                if (typeof body.id !== 'string' || body.id === '') { write(res, 400, { ok: false, code: 'invalid-args' }); return; }
                const result = memory.approveProposal(body.id, {
                    ...(typeof body.title === 'string' ? { title: body.title } : {}),
                    ...(typeof body.text === 'string' ? { text: body.text } : {}),
                    ...(typeof body.visibility === 'string' ? { visibility: body.visibility } : {}),
                });
                if (result === undefined) { write(res, 404, { ok: false, code: 'not-found' }); return; }
                writeChanged(res, { ok: true, ...result });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/proposals/reject',
            handler: guard(true, (_req, res, { body }) => {
                if (typeof body.id !== 'string' || body.id === '') { write(res, 400, { ok: false, code: 'invalid-args' }); return; }
                const proposal = memory.rejectProposal(body.id);
                if (proposal === undefined) { write(res, 404, { ok: false, code: 'not-found' }); return; }
                writeChanged(res, { ok: true, proposal });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/global',
            handler: guard(true, (_req, res, { body }) => {
                const item = memory.rememberFor({
                    scope: 'global',
                    title: typeof body.title === 'string' ? body.title : '',
                    text: typeof body.text === 'string' ? body.text : '',
                    kind: typeof body.kind === 'string' ? body.kind : 'fact',
                    importance: Number(body.importance) || 0.5,
                    tags: Array.isArray(body.tags) ? body.tags : [],
                    visibility: body.visibility,
                    ...(typeof body.cue === 'string' && body.cue.trim() ? { cue: body.cue.trim() } : {}),
                });
                writeChanged(res, { ok: true, item });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/global/update',
            handler: guard(true, (_req, res, { body }) => {
                if (typeof body.id !== 'string' || body.id === '') { write(res, 400, { ok: false, code: 'invalid-args' }); return; }
                const item = memory.updateGlobal({
                    id: body.id,
                    ...(typeof body.title === 'string' ? { title: body.title } : {}),
                    ...(typeof body.text === 'string' ? { text: body.text } : {}),
                    ...(typeof body.visibility === 'string' ? { visibility: body.visibility } : {}),
                    ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
                });
                if (item === undefined) { write(res, 404, { ok: false, code: 'not-found' }); return; }
                writeChanged(res, { ok: true, item });
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/global/forget',
            handler: guard(true, (_req, res, { body }) => {
                if (typeof body.id !== 'string' || body.id === '') { write(res, 400, { ok: false, code: 'invalid-args' }); return; }
                const removed = memory.forgetGlobal(body.id) === true;
                writeChanged(res, { ok: true, removed }, removed);
            }, { owner: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/health',
            handler: guard(false, (_req, res, { session, requested }) => {
                const scopes = [];
                if (requested.agentId) scopes.push({ scope: 'agent', ownerId: requested.agentId });
                if (requested.workspaceId) scopes.push({ scope: 'workspace', ownerId: requested.workspaceId });
                if (session.owner === true && requested.scope !== 'agent' && requested.scope !== 'workspace') scopes.push({ scope: 'global', ownerId: 'global' });
                write(res, 200, { ok: true, health: memory.store.health(scopes) });
            }, { target: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/migrate-legacy',
            handler: guard(true, async (_req, res) => {
                try {
                    const result = await memory.migrateLegacy();
                    write(res, 200, { ok: true, migrated: Number(result?.migrated ?? 0) });
                }
                catch (error) {
                    const code = error?.code === 'owner-mismatch' ? 'owner-mismatch'
                        : error?.code === 'unauthorized' ? 'unauthorized'
                            : 'memory-sync-unavailable';
                    write(res, code === 'owner-mismatch' || code === 'unauthorized' ? 403 : 503, { ok: false, code, message: error instanceof Error ? error.message : String(error) });
                }
            }, { owner: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/sync',
            handler: guard(true, async (_req, res, { requested }) => {
                try {
                    const result = await memory.syncFor({ agentId: requested.agentId, workspaceId: requested.workspaceId });
                    write(res, 200, { ok: true, ...result });
                }
                catch (error) {
                    write(res, 503, { ok: false, code: error?.code === 'weak-passphrase' ? 'weak-passphrase' : 'memory-sync-unavailable', message: error instanceof Error ? error.message : String(error) });
                }
            }, { owner: true, target: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/graph',
            handler: guard(false, async (_req, res, { session, requested, url }) => {
                const graph = await memory.graphFor({
                    agentId: requested.agentId,
                    workspaceId: requested.workspaceId,
                    includeGlobal: session.owner === true,
                    limit: Math.max(1, Math.min(600, Number(url.get('limit')) || 400)),
                });
                write(res, 200, { ok: true, graph, ...(memory.usesMnemon?.(requested.agentId, requested.workspaceId) ? { privateBackend: 'mnemon' } : {}) });
            }, { target: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/list',
            handler: guard(false, async (_req, res, { session, requested, url }) => {
                const items = await memory.listFor({
                    agentId: requested.agentId,
                    workspaceId: requested.workspaceId,
                    scope: requested.scope ?? 'all',
                    includeGlobal: session.owner === true,
                    query: url.get('query') ?? undefined,
                    limit: Math.max(1, Math.min(300, Number(url.get('limit')) || 100)),
                });
                write(res, 200, { ok: true, items });
            }, { target: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/get',
            handler: guard(false, async (_req, res, { requested, url }) => {
                const scope = requested.scope === 'workspace' ? 'workspace' : requested.scope === 'global' ? 'global' : 'agent';
                const ownerId = scope === 'workspace' ? requested.workspaceId : scope === 'global' ? 'global' : requested.agentId;
                if (ownerId === undefined) { write(res, 400, { ok: false, code: 'invalid-owner' }); return; }
                const item = await memory.getFor(scope, ownerId, url.get('id') ?? '');
                if (item === undefined) { write(res, 404, { ok: false, code: 'not-found' }); return; }
                write(res, 200, { ok: true, item });
            }, { target: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/remember',
            handler: guard(true, async (_req, res, { body, requested }) => {
                if (body.scope === 'global') { write(res, 403, { ok: false, code: 'owner-only' }); return; }
                const item = await memory.rememberFor({
                    agentId: requested.agentId,
                    workspaceId: requested.workspaceId,
                    scope: body.scope === 'workspace' ? 'workspace' : 'agent',
                    title: typeof body.title === 'string' ? body.title : undefined,
                    text: typeof body.text === 'string' ? body.text : '',
                    kind: typeof body.kind === 'string' ? body.kind : 'fact',
                    importance: Number(body.importance) || 0.5,
                    tags: Array.isArray(body.tags) ? body.tags : [],
                    visibility: body.visibility,
                    ...(typeof body.cue === 'string' && body.cue.trim() ? { cue: body.cue.trim() } : {}),
                });
                writeChanged(res, { ok: true, item });
            }, { target: true }),
        },
        {
            method: 'POST', path: '/marshal/memory/forget',
            handler: guard(true, async (_req, res, { body, requested }) => {
                if (body.scope === 'global') { write(res, 403, { ok: false, code: 'owner-only' }); return; }
                const removed = await memory.forgetFor({
                    agentId: requested.agentId,
                    workspaceId: requested.workspaceId,
                    id: typeof body.id === 'string' ? body.id : '',
                });
                writeChanged(res, { ok: true, removed }, removed);
            }, { target: true }),
        },
        {
            method: 'GET', path: '/marshal/memory/status',
            handler: guard(false, async (_req, res, { session, requested }) => {
                const scopes = [];
                if (requested.agentId) scopes.push({ scope: 'agent', ownerId: requested.agentId });
                if (requested.workspaceId) scopes.push({ scope: 'workspace', ownerId: requested.workspaceId });
                if (session.owner === true) scopes.push({ scope: 'global', ownerId: 'global' });
                write(res, 200, { ok: true, stats: await memory.statsFor(scopes) });
            }, { target: true }),
        },
    ];
}
