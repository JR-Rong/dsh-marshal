import { createHash } from 'node:crypto';
import { PreCallRejection } from "../adapters/types.js";
import { encodeFrame } from "../wire/frames.js";
import { DISCUSSION_TURN_MS, WORK_TURN_MS, DISCUSSION_OUTPUT_BYTES, DiscussionTurnSchema, DiscussionStopSchema, DiscussionUsageSchema, DiscussionProgressSchema, discussionCode } from "./types.js";
export function createNodeDiscussions(options) {
    const now = options.now ?? Date.now;
    const jobs = new Map();
    let models = [];
    let disposed = false;
    const authorized = () => options.enabled && !disposed && options.link().binding?.policies.allowDiscussion === true;
    const key = (room, member) => room + ':' + member;
    const announce = async () => {
        const binding = options.link().binding;
        const handshake = options.link().handshake;
        if (binding === undefined || handshake === undefined)
            return;
        models = authorized() ? await options.port.catalog() : [];
        if (options.link().binding !== binding || disposed)
            return;
        options.link().sendControl(encodeFrame({ v: 2, type: 'discussion.catalog', connectionId: handshake.connectionId,
            nodeEpoch: handshake.nodeEpoch, models: [...models] }));
    };
    return {
        announce,
        async execute(frame, raw) {
            const jobKey = key(String(raw?.roomId), String(raw?.memberId));
            if (frame.op === 'discussion.stop') {
                const args = DiscussionStopSchema.parse(raw);
                if (frame.target.sessionId !== args.roomId)
                    throw new PreCallRejection('session-purpose-conflict');
                const job = jobs.get(jobKey);
                if (job !== undefined && job.request.turnId !== args.turnId)
                    throw new PreCallRejection('stale-connection');
                job?.abort.abort();
                return { accepted: true, turnId: args.turnId };
            }
            const args = DiscussionTurnSchema.parse(raw);
            const link = options.link();
            const binding = link.binding;
            const handshake = link.handshake;
            const workspaceAuthorized = () => args.taskWorkspaceId === undefined || options.allowsTaskWorkspace?.(args.taskWorkspaceId) === true;
            if (!authorized() || !link.online || binding === undefined || handshake === undefined)
                throw new PreCallRejection('unsupported');
            if (frame.target.sessionId !== args.roomId)
                throw new PreCallRejection('session-purpose-conflict');
            if (args.policyRevision !== binding.policyRevision)
                throw new PreCallRejection('revision-conflict');
            if (args.taskWorkspaceId !== undefined && (args.work !== undefined || !workspaceAuthorized()))
                throw new PreCallRejection('invalid-args');
            const remaining = args.expiresAt - (now() + handshake.serverTimeOffset);
            if (remaining <= 0 || remaining > (args.work ? WORK_TURN_MS : DISCUSSION_TURN_MS) + 1000)
                throw new PreCallRejection('expired');
            const model = models.find(m => m.id === args.modelId && m.agent === frame.target.agent);
            if (model === undefined)
                throw new PreCallRejection('unsupported');
            if (args.reasoning !== undefined && !model.reasoningEfforts?.includes(args.reasoning))
                throw new PreCallRejection('invalid-args');
            if (args.work && model.work !== true)
                throw new PreCallRejection('unsupported');
            if (jobs.has(jobKey) || jobs.size >= 4)
                throw new PreCallRejection('writer-busy');
            const abort = new AbortController();
            const job = { request: args, abort };
            jobs.set(jobKey, job);
            const domain = { operatorId: frame.operatorId, target: frame.target, idempotencyKey: frame.idempotencyKey };
            // Start after the runner has durably settled admission; completion must not
            // race its accepted ACK. Native calls have their own local deadline.
            setImmediate(() => {
                void (async () => {
                    const timer = setTimeout(() => abort.abort(), remaining);
                    timer.unref();
                    let result = { v: 2, type: 'discussion.result', connectionId: handshake.connectionId,
                        nodeEpoch: handshake.nodeEpoch, roomId: args.roomId, memberId: args.memberId, turnId: args.turnId, state: 'failed' };
                    let usage;
                    let progress, seq = 0, lastSent = 0;
                    let progressTimer;
                    const flush = () => {
                        if (progressTimer)
                            clearTimeout(progressTimer);
                        progressTimer = undefined;
                        const current = options.link().handshake;
                        if (!progress || abort.signal.aborted || !authorized() || !workspaceAuthorized() || !link.online || options.link().binding !== binding
                            || current?.connectionId !== handshake.connectionId || current.nodeEpoch !== handshake.nodeEpoch)
                            return;
                        // Full snapshots tolerate skipped intermediate frames without replaying text.
                        link.sendControl(encodeFrame({ v: 2, type: 'discussion.progress', connectionId: handshake.connectionId,
                            nodeEpoch: handshake.nodeEpoch, roomId: args.roomId, memberId: args.memberId, turnId: args.turnId,
                            seq: ++seq, ...progress }));
                        lastSent = performance.now();
                        progress = undefined;
                    };
                    try {
                        if (!authorized() || !workspaceAuthorized() || options.link().binding !== binding)
                            abort.abort();
                        const text = await options.port.run(model, args.text, abort.signal, args.work, args.reasoning, value => {
                            const parsed = DiscussionUsageSchema.safeParse(value);
                            if (parsed.success)
                                usage = parsed.data;
                        }, value => {
                            const parsed = DiscussionProgressSchema.safeParse(value);
                            if (!parsed.success)
                                return;
                            progress = parsed.data;
                            if (progress.usage)
                                usage = progress.usage;
                            if (!seq || performance.now() - lastSent >= 200)
                                flush();
                            else if (!progressTimer) {
                                progressTimer = setTimeout(flush, 200);
                                progressTimer.unref();
                            }
                        });
                        if (Buffer.byteLength(text) > DISCUSSION_OUTPUT_BYTES)
                            throw new Error('oversize');
                        if (!workspaceAuthorized()) throw new Error('workspace-revoked');
                        result = { ...result, state: 'completed', text, checksum: createHash('sha256').update(text).digest('hex') };
                    }
                    catch (error) {
                        result = { ...result, state: abort.signal.aborted ? 'cancelled' : 'failed', code: discussionCode(error) };
                    }
                    finally {
                        flush();
                        if (progressTimer)
                            clearTimeout(progressTimer);
                        clearTimeout(timer);
                        if (jobs.get(jobKey) === job)
                            jobs.delete(jobKey);
                    }
                    if (usage)
                        result.usage = usage;
                    try {
                        options.journal.settle(domain, 'confirmed', undefined, { turnId: args.turnId, accepted: result.state === 'completed' });
                    }
                    catch {
                        result = { ...result, state: 'failed', code: 'recovery-required' };
                        delete result.text;
                        delete result.checksum;
                    }
                    // Never buffer discussion content for offline replay or ordinary history.
                    if (authorized() && options.link().binding === binding)
                        options.link().sendControl(encodeFrame(result));
                })();
            });
            return { accepted: true, turnId: args.turnId };
        },
        invalidate() { models = []; for (const job of jobs.values())
            job.abort.abort(); },
        dispose() { disposed = true; models = []; for (const job of jobs.values())
            job.abort.abort(); options.port.dispose(); },
    };
}
