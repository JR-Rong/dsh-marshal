import { z } from 'zod';
export const DISCUSSION_FEATURE = 'discussion-moderated-v1';
export const DISCUSSION_INPUT_BYTES = 64 * 1024;
export const DISCUSSION_OUTPUT_BYTES = 16 * 1024;
export const DISCUSSION_TURN_MS = 120_000;
export const WORK_TURN_MS = 20 * 60_000;
export const WORK_ROOM_MS = 90 * 60_000;
export const DISCUSSION_ROOM_MS = 15 * 60_000;
const id = z.string().min(1).max(128);
export const DiscussionModelSchema = z.object({
    id, agent: z.enum(['dsh', 'codex', 'claude']), model: id, provider: id, work: z.boolean().optional(),
    reasoningEfforts: z.array(z.string().min(1).max(32)).max(12).optional(),
}).strict();
export const WorkScopeSchema = z.object({
    workspace: z.string().min(2).max(2048).startsWith('/').refine(p => !/[\x00-\x1f]/.test(p)),
    readOnly: z.boolean().optional(),
}).strict();
export const DiscussionTurnSchema = z.object({
    roomId: id, memberId: id, turnId: id, modelId: id,
    text: z.string().min(1).refine(text => Buffer.byteLength(text) <= DISCUSSION_INPUT_BYTES),
    expiresAt: z.number().int().positive(), policyRevision: z.number().int().nonnegative(),
    work: WorkScopeSchema.optional(),
    taskWorkspaceId: z.string().min(1).max(256).optional(),
    reasoning: z.string().min(1).max(32).optional(),
}).strict();
export const DiscussionStopSchema = z.object({ roomId: id, memberId: id, turnId: id }).strict();
// A room has at most 15 calls; sums remain exact safe integers.
const usageNumber = z.number().int().min(0).max(Math.floor(Number.MAX_SAFE_INTEGER / 15));
export const DiscussionUsageSchema = z.object({
    inputTokens: usageNumber, outputTokens: usageNumber, totalTokens: usageNumber,
    durationMs: usageNumber,
}).strict().refine(value => value.totalTokens === value.inputTokens + value.outputTokens);
export const DiscussionProfileSchema = z.object({
    persona: z.string().trim().max(600).default(''),
    expertise: z.enum(['general', 'professional', 'expert']).default('professional'),
    stance: z.enum(['collaborate', 'challenge', 'review']).default('collaborate'),
}).strict();
export const DiscussionProgressSchema = z.object({
    text: z.string().refine(text => Buffer.byteLength(text) <= DISCUSSION_OUTPUT_BYTES),
    durationMs: z.number().int().nonnegative().max(WORK_TURN_MS + 5000),
    usage: DiscussionUsageSchema.optional(),
}).strict();
export class DiscussionError extends Error {
    code;
    constructor(code) {
        super(`marshal: discussion ${code}`);
        this.code = code;
    }
}
export function discussionCode(error) {
    return error instanceof DiscussionError ? error.code : 'agent-crashed';
}
