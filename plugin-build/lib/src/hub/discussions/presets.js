import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicWriteFile } from "../state-file.js";
import { DiscussionError, DiscussionProfileSchema } from "../../discussions/types.js";
// Accept the UI's secure UUID and its existing opaque-key fallback on HTTP hosts.
const id = z.string().min(12).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const name = z.string().trim().min(1).max(60).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const PresetSchema = z.object({ id, name, profile: DiscussionProfileSchema, updatedAt: z.number().int().nonnegative() }).strict();
const MutationSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('save'), id, key: z.string().min(1).max(128), revision, name, profile: DiscussionProfileSchema }).strict(),
    z.object({ action: z.literal('delete'), id, key: z.string().min(1).max(128), revision }).strict(),
]);
const StoreSchema = z.object({ version: z.literal(1), operatorId: z.string().min(1), revision,
    items: z.array(PresetSchema).max(64), lastMutation: z.object({ key: z.string(), digest: z.string() }).strict().optional(),
}).strict().refine(data => new Set(data.items.map(item => item.id)).size === data.items.length
    && new Set(data.items.map(item => item.name.toLowerCase())).size === data.items.length);
/** One instance is owned by the Hub's exclusive discussion-journal lifetime.
 * All writes are synchronous CAS + atomic rename; no draft or device-local copy. */
export function createProfilePresets(file, operatorId, now = Date.now) {
    let state;
    if (existsSync(file)) {
        state = StoreSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        if (state.operatorId !== operatorId)
            throw new DiscussionError('recovery-required');
    }
    else {
        const templates = [
            { name: '协作工程师', profile: { persona: '务实、清晰的工程师，结合同伴观点提出可执行的改进，先验证再下结论。', expertise: 'professional', stance: 'collaborate' } },
            { name: '反驳审查员', profile: { persona: '严谨的审查者，主动寻找反例、隐藏假设与失败条件，用证据质疑，不为反对而反对。', expertise: 'expert', stance: 'challenge' } },
            { name: '技术主持人', profile: { persona: '条理清楚、客观的技术主持人，按成员专长分工，汇总证据、分歧和未解决问题。', expertise: 'professional', stance: 'review' } },
        ];
        state = { version: 1, operatorId, revision: 0, items: templates.map(item => ({ ...item, id: randomUUID(), updatedAt: now() })) };
        atomicWriteFile(file, JSON.stringify(state) + '\n');
    }
    const view = () => structuredClone({ revision: state.revision, items: state.items });
    return {
        list: view,
        mutate(raw) {
            const input = MutationSchema.parse(raw);
            const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            if (state.lastMutation?.key === input.key) {
                if (state.lastMutation.digest !== digest)
                    throw new DiscussionError('idempotency-conflict');
                return view();
            }
            if (input.revision !== state.revision)
                throw new DiscussionError('revision-conflict');
            const prior = state.items.find(item => item.id === input.id);
            let items = state.items.filter(item => item.id !== input.id);
            if (input.action === 'save') {
                if (items.some(item => item.name.toLowerCase() === input.name.toLowerCase()))
                    throw new DiscussionError('preset-name-conflict');
                if (!prior && items.length >= 64)
                    throw new DiscussionError('size-limit');
                const saved = { id: input.id, name: input.name, profile: input.profile, updatedAt: now() };
                items = prior ? state.items.map(item => item.id === input.id ? saved : item) : [...items, saved];
            }
            else if (!prior)
                throw new DiscussionError('preset-unknown');
            const next = { ...state, revision: state.revision + 1, items, lastMutation: { key: input.key, digest } };
            // Do not expose a successful write in memory if disk persistence failed.
            try {
                atomicWriteFile(file, JSON.stringify(next) + '\n');
            }
            catch {
                throw new DiscussionError('recovery-required');
            }
            state = next;
            return view();
        },
    };
}
