import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../hub/state-file.js';

/** Per-workspace default agent roster (Leader / Coder / Reviewer / resident members). */
export function createWorkspaceRosters(file) {
    const load = () => {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            if (parsed?.version === 1 && parsed.rosters && typeof parsed.rosters === 'object') return parsed.rosters;
        }
        catch { /* first run */ }
        return {};
    };
    let rosters = load();
    const save = (next) => {
        atomicWriteFile(file, JSON.stringify({ version: 1, rosters: next }, null, 2) + '\n');
        rosters = next;
    };
    const cleanId = value => typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 256) : undefined;
    return {
        list() {
            return { ...rosters };
        },
        get(workspaceId) {
            return typeof workspaceId === 'string' && Object.hasOwn(rosters, workspaceId) ? rosters[workspaceId] : undefined;
        },
        set(workspaceId, input = {}) {
            const id = cleanId(workspaceId);
            if (!id) throw new Error('invalid workspaceId');
            const members = Array.isArray(input.members)
                ? [...new Set(input.members.map(cleanId).filter(Boolean))].slice(0, 24)
                : [];
            const entry = {
                workspaceId: id,
                ...(cleanId(input.leaderId) ? { leaderId: cleanId(input.leaderId) } : {}),
                ...(cleanId(input.coderId) ? { coderId: cleanId(input.coderId) } : {}),
                ...(cleanId(input.reviewerId) ? { reviewerId: cleanId(input.reviewerId) } : {}),
                members,
                updatedAt: Date.now(),
            };
            save({ ...rosters, [id]: entry });
            return entry;
        },
        remove(workspaceId) {
            if (!Object.hasOwn(rosters, workspaceId)) return false;
            const next = { ...rosters };
            delete next[workspaceId];
            save(next);
            return true;
        },
    };
}
