import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalAttachmentName, mountGroups, normalizeAttachmentsPayload } from '../lib/src/groups/mount.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'marshal-ticket-att-'));
const sha = text => createHash('sha256').update(text).digest('hex');

const sampleFileAtt = {
    kind: 'file',
    attachmentId: 'obj-file-001',
    name: 'spec-notes.md',
    bytes: 42,
    mediaType: 'TEXT/MARKDOWN',
    sha256: sha('hello-spec').toUpperCase(),
    width: 999, // extra field on file must be stripped so strict wire validation passes
};

const sampleImageAtt = {
    kind: 'image',
    attachmentId: 'obj-img-002',
    name: 'ui/screenshot.png',
    bytes: 128,
    mediaType: 'IMAGE/PNG',
    sha256: sha('png-bytes'),
    width: 640,
    height: 360,
};

test('normalizeAttachmentsPayload enforces strict task-board wire contract', () => {
    assert.equal(canonicalAttachmentName('foo/bar\\baz.png'), 'foo_bar_baz.png');
    assert.equal(canonicalAttachmentName('..'), 'attachment');

    const normalized = normalizeAttachmentsPayload([
        sampleFileAtt,
        sampleImageAtt,
        { ...sampleFileAtt }, // duplicate attachmentId must be dropped
        { kind: 'image', attachmentId: 'bad-img', name: 'bad.png', bytes: 10, mediaType: 'image/png', sha256: sha('x') }, // missing width/height
        { kind: 'file', attachmentId: '../escape', name: 'evil.txt', bytes: 10, mediaType: 'text/plain', sha256: sha('y') },
    ]);

    assert.equal(normalized?.length, 2);
    assert.deepEqual(normalized[0], {
        kind: 'file',
        attachmentId: 'obj-file-001',
        name: 'spec-notes.md',
        bytes: 42,
        mediaType: 'text/markdown',
        sha256: sha('hello-spec'),
    });
    assert.equal('width' in normalized[0], false);
    assert.deepEqual(normalized[1], {
        kind: 'image',
        attachmentId: 'obj-img-002',
        name: 'ui_screenshot.png',
        bytes: 128,
        mediaType: 'image/png',
        sha256: sha('png-bytes'),
        width: 640,
        height: 360,
    });
});

test('client/index.js snapshots FileList before clearing input.value and uses octet-stream upload URL', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('api/task-board/attachments/upload'), 'retains upload endpoint path');
    assert.ok(source.includes("'content-type': 'application/octet-stream'"), 'uploads raw bytes as application/octet-stream');

    // Every file input must copy Array.from(*.target.files || []) BEFORE clearing .target.value = ''
    const badPattern = /const\s+\w+\s*=\s*\w+\.target\.files\s*;\s*\w+\.target\.value\s*=\s*['"]{2}/;
    assert.equal(badPattern.test(source), false, 'must never assign live FileList and clear input.value before Array.from()');

    const safeMatches = source.match(/Array\.from\(\w+\.target\.files\s*\|\|\s*\[\]\);\s*\n\s*\w+\.target\.value\s*=\s*''/g) ?? [];
    assert.ok(safeMatches.length >= 3, 'create form, detail drawer, and task room file inputs snapshot files before clearing value');

    // Guard against black-screen regressions: no ensureBoardStyles typo, root & taskRoom ErrorBoundaries, and proper layout inject
    assert.equal(source.includes('ensureBoardStyles('), false, 'must call ensureTaskBoardStyles(), never undefined ensureBoardStyles()');
    assert.ok(source.includes("resetKey: 'taskRooms-'"), 'TaskRoomsPage must be wrapped in MarshalErrorBoundary');
    assert.ok(source.includes('SafeMarshalPanel'), 'MarshalPanel must be wrapped in SafeMarshalPanel root ErrorBoundary');
    assert.ok(source.includes("ctx.inject(['layout']"), 'must inject layout service via Cordis ctx.inject');
    assert.ok(source.includes("'marshal: client lifecycle'"), 'must dispose slots and intervals on client-hmr reload');
});

test('host taskBoard routes non-empty attachments through verified /api/task-board/action while null clears directly', async (t) => {
    const dir = tempRoot();
    const storedFileOnDisk = join(dir, 'stored-spec.md');
    writeFileSync(storedFileOnDisk, 'spec-body-for-agent', 'utf8');
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const tasks = [];
    const directCalls = [];
    const verifiedEnvelopes = [];

    const hostBoard = {
        snapshot: () => ({ tasks: tasks.map(item => ({ ...item })), sessionDefaultPermission: 'workspace-write' }),
        async apply(_requestId, action) {
            // Mirror real @linxin666/dsh-client-ui-task-board service.apply:
            // non-empty attachments are rejected on unverified board.apply!
            const carriesAtt = (action.kind === 'create' && action.input?.attachments !== undefined)
                || (action.kind === 'update' && action.patch?.attachments !== undefined && action.patch.attachments !== null);
            if (carriesAtt) {
                throw new Error('attachments must be applied through the verified attachment action route');
            }
            directCalls.push(action);
            if (action.kind === 'update' && action.patch?.attachments === null) {
                const hit = tasks.find(item => item.id === action.taskId);
                if (hit) delete hit.attachments;
            }
            return hostBoard.snapshot();
        },
    };

    const routes = [];
    const server = createServer(async (req, res) => {
        if (req.url === '/api/task-board/action' && req.method === 'POST') {
            // Enforce browserSameOriginMarker + cookie forwarding like real task-board guard
            if (req.headers['sec-fetch-site'] !== 'same-origin' || !String(req.headers.cookie || '').includes('dsh-auth=test-ok')) {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
                return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            verifiedEnvelopes.push(envelope);
            if (envelope.action.kind === 'create') {
                tasks.unshift({
                    id: envelope.action.id,
                    ...envelope.action.input,
                    status: 'todo',
                    executions: [],
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });
            }
            else if (envelope.action.kind === 'update') {
                const hit = tasks.find(item => item.id === envelope.action.taskId);
                if (hit) Object.assign(hit, envelope.action.patch);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(hostBoard.snapshot()));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const disposers = [];
    t.after(async () => {
        for (const dispose of disposers.reverse()) {
            if (typeof dispose === 'function') {
                try { dispose(); } catch {}
            }
        }
        server.closeAllConnections?.();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = 'http://127.0.0.1:' + port;

    const attachmentStore = {
        saveImage: async () => ({}),
        fileHostPath: ref => (ref.attachmentId === 'obj-file-001' ? storedFileOnDisk : undefined),
        readImage: async ref => ({
            ref: { ...ref, mediaType: 'image/png', bytes: pngBytes.byteLength, width: 640, height: 360 },
            data: pngBytes,
        }),
        async *readFileStream() {
            yield Buffer.from('spec-body-for-agent', 'utf8');
        },
    };

    const ctx = {
        sessionController: { prompt: async () => {}, history: async () => ({ events: [] }) },
        get(name) {
            if (name === 'attachments') return attachmentStore;
            return undefined;
        },
        effect(fn) { disposers.push(fn()); },
        inject(deps, cb) {
            const scoped = {
                effect(fn) { disposers.push(fn()); },
                ...(deps.includes('tools') ? { tools: { register: () => () => {} } } : {}),
                ...(deps.includes('taskBoard') ? { taskBoard: hostBoard } : {}),
                ...(deps.includes('webServer') ? {
                    webServer: {
                        port,
                        getOrigin: () => origin,
                        register(route) { routes.push(route); return () => {}; },
                    },
                } : {}),
                ...(deps.includes('connection') ? {
                    connection: { requestRejection: req => String(req.headers?.cookie || '').includes('dsh-auth=test-ok') ? undefined : 401 },
                } : {}),
            };
            cb(scoped);
        },
    };

    mountGroups(ctx, { deviceId: 'dev-local', agents: ['dsh'], groupsRoot: dir, memoryRoot: join(dir, 'mem') });

    const invokeJson = async (method, path, bodyObj) => {
        const pathname = path.split('?')[0];
        const route = routes.find(r => r.path === pathname);
        assert.ok(route, 'missing route ' + pathname);
        let status = 200;
        const chunks = [];
        const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
        const req = {
            method,
            url: path,
            headers: {
                host: '127.0.0.1:' + port,
                cookie: 'dsh-auth=test-ok',
                ...(bodyObj === undefined ? {} : { 'content-type': 'application/json' }),
            },
            socket: { remoteAddress: '127.0.0.1' },
            async *[Symbol.asyncIterator]() {
                if (rawBody) yield Buffer.from(rawBody);
            },
        };
        const headersOut = {};
        const res = {
            writeHead(code, hdrs = {}) { status = code; Object.assign(headersOut, hdrs); },
            write(chunk) { chunks.push(Buffer.from(chunk)); },
            end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
        };
        await route.handler(req, res);
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        return { status, headers: headersOut, json, buf };
    };

    // 1. Create ticket with file attachment -> goes through verified /api/task-board/action
    const createRes = await invokeJson('POST', '/marshal/tasks/create', {
        title: '修复工单附件上传无响应',
        description: '上传规范文档和截图后应落盘并可预览',
        attachments: [sampleFileAtt],
    });
    assert.equal(createRes.status, 200);
    assert.equal(verifiedEnvelopes.length, 1);
    assert.equal(verifiedEnvelopes[0].action.kind, 'create');
    const createdCard = createRes.json.tasks[0];
    assert.equal(createdCard.attachments.length, 1);
    assert.equal(createdCard.attachments[0].attachmentId, 'obj-file-001');

    // 2. Update ticket in drawer adding an image attachment + model + freeze -> verified route
    const updateRes = await invokeJson('POST', '/marshal/tasks/update', {
        taskId: createdCard.id,
        model: 'deepseek/deepseek-reasoner',
        reasoningEffort: 'high',
        reuseSession: true,
        freeze: { goal: '等待设计确认' },
        attachments: [sampleFileAtt, sampleImageAtt],
    });
    assert.equal(updateRes.status, 200);
    assert.equal(verifiedEnvelopes.length, 2);
    assert.equal(verifiedEnvelopes[1].action.kind, 'update');
    assert.equal(updateRes.json.tasks[0].attachments.length, 2);
    assert.equal(updateRes.json.tasks[0].model, 'deepseek/deepseek-reasoner');
    assert.equal(updateRes.json.tasks[0].reuseSession, true);

    // 3. Download/preview attachment via GET /marshal/tasks/attachment
    const fileDl = await invokeJson('GET', `/marshal/tasks/attachment?taskId=${encodeURIComponent(createdCard.id)}&id=obj-file-001`);
    assert.equal(fileDl.status, 200);
    assert.equal(fileDl.buf.toString('utf8'), 'spec-body-for-agent');
    const imgDl = await invokeJson('GET', `/marshal/tasks/attachment?taskId=${encodeURIComponent(createdCard.id)}&id=obj-img-002`);
    assert.equal(imgDl.status, 200);
    assert.equal(imgDl.headers['content-type'], 'image/png');

    // 4. Clearing all attachments ([] or null) maps to patch.attachments = null and succeeds via direct board.apply
    const clearRes = await invokeJson('POST', '/marshal/tasks/update', {
        taskId: createdCard.id,
        attachments: [],
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json.tasks[0].attachments, undefined);
    assert.equal(directCalls.some(a => a.kind === 'update' && a.patch.attachments === null), true);
});
