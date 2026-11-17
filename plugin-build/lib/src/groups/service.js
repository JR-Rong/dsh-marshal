import { randomUUID } from 'node:crypto';
import { createGroupStore, groupMemberKey } from './store.js';

const MENTION_PATTERN = /@([^\s@,，。；;]+)/g;
const CONCURRENCY = 4;

/** @name 提及：支持中文名；@all 与 @全体 等价。 */
export function parseMentions(text) {
    const names = [];
    const seen = new Set();
    for (const match of String(text).matchAll(MENTION_PATTERN)) {
        const raw = match[1].replace(/[：:]+$/, '');
        const name = raw === 'all' || raw === '全体' ? 'all' : raw;
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

function memberDraft(input, deviceId) {
    if (input === null || typeof input !== 'object') {
        throw new Error('marshal: groups invalid-member: a member draft must be an object');
    }
    const squadId = typeof input.squadId === 'string' ? input.squadId : '';
    const memberId = typeof input.memberId === 'string' ? input.memberId : '';
    const name = typeof input.name === 'string' ? input.name : '';
    if (squadId === '' || memberId === '' || name.trim() === '') {
        throw new Error('marshal: groups invalid-member: squadId, memberId and name are required');
    }
    return {
        deviceId: typeof input.deviceId === 'string' && input.deviceId !== '' ? input.deviceId : deviceId,
        squadId,
        memberId,
        name: name.trim(),
        ...(typeof input.preset === 'string' && input.preset !== '' ? { preset: input.preset } : {}),
        ...(typeof input.permission === 'string' && input.permission !== '' ? { permission: input.permission } : {}),
        ...(typeof input.model === 'string' && input.model !== '' ? { model: input.model } : {}),
        ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort !== '' ? { reasoningEffort: input.reasoningEffort } : {}),
    };
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function errorCode(error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code;
    return 'internal-error';
}

export function createGroupService({ root, deviceId, store, inventory, prompt, reader, available, now = Date.now, idFactory, replyPollMs = 2500 } = {}) {
    if (store === undefined && root === undefined) {
        throw new Error('marshal: groups need a store or a root');
    }
    const groupStore = store ?? createGroupStore({ root, now, idFactory });
    const promptSession = prompt ?? (async () => { throw new Error('marshal: groups no-session-controller'); });
    const isAvailable = typeof available === 'function' ? available : () => true;
    const replyReader = reader;
    const watchReplies = (groupId, member, baseline) => {
        if (replyReader === undefined || member.sessionId === undefined) return;
        const sessionId = member.sessionId;
        let last = baseline;
        let attempts = 0;
        const tick = () => {
            attempts += 1;
            if (attempts > 24) return;
            void (async () => {
                try {
                    const replies = await replyReader.since(sessionId, last);
                    for (const reply of replies) {
                        if (!Number.isSafeInteger(reply.seq) || reply.seq <= last) continue;
                        last = reply.seq;
                        if (typeof reply.text === 'string' && reply.text.trim() !== '') {
                            groupStore.appendMessage(groupId, {
                                author: 'member',
                                authorMemberId: member.memberId,
                                authorDeviceId: member.deviceId,
                                text: reply.text.slice(0, 4000),
                            });
                        }
                    }
                }
                catch { /* a reply poll must never fail the send */ }
                if (attempts < 24) setTimeout(tick, replyPollMs).unref?.();
            })();
        };
        setTimeout(tick, Math.min(replyPollMs, 1500)).unref?.();
    };
    const summary = (group) => ({
        id: group.id,
        name: group.name,
        mode: group.mode,
        leader: group.leader,
        memberCount: group.members.length,
        messageCount: group.messages.length,
        updatedAt: group.updatedAt,
    });
    const leaderOf = (group) => group.members.find((member) => groupMemberKey(member)
        === group.leader.deviceId + '/' + group.leader.squadId + '/' + group.leader.memberId);
    const inventoryView = () => {
        if (inventory === undefined) return null;
        try {
            return inventory();
        }
        catch (error) {
            return { available: false, code: errorCode(error) };
        }
    };
    return {
        store: groupStore,
        state() {
            return {
                deviceId,
                groups: groupStore.list().map(summary),
                inventory: inventoryView(),
            };
        },
        get(id) {
            return groupStore.get(id);
        },
        create(input) {
            if (input === null || typeof input !== 'object') {
                throw new Error('marshal: groups invalid-group: a draft must be an object');
            }
            const members = (Array.isArray(input.members) ? input.members : []).map((member) => memberDraft(member, deviceId));
            if (input.leaderKey !== undefined) {
                const leader = members.find((member) => groupMemberKey(member) === input.leaderKey);
                if (leader === undefined) {
                    throw new Error('marshal: groups leader-not-member: the leader key is not one of the members');
                }
                return groupStore.create({ name: input.name, mode: input.mode, members, leader });
            }
            if (input.leader !== undefined && input.leader !== null && typeof input.leader === 'object') {
                const wanted = groupMemberKey({
                    deviceId: String(input.leader.deviceId ?? ''),
                    squadId: String(input.leader.squadId ?? ''),
                    memberId: String(input.leader.memberId ?? ''),
                });
                const leader = members.find((member) => groupMemberKey(member) === wanted);
                if (leader === undefined) {
                    throw new Error('marshal: groups leader-not-member: the leader is not one of the members');
                }
                return groupStore.create({ name: input.name, mode: input.mode, members, leader });
            }
            return groupStore.create({ name: input.name, mode: input.mode, members });
        },
        update(id, patch) {
            const group = groupStore.get(id);
            const next = {};
            if (patch !== null && typeof patch === 'object') {
                if (patch.name !== undefined) next.name = patch.name;
                if (patch.mode !== undefined) next.mode = patch.mode;
                if (patch.leaderKey !== undefined) {
                    const member = group.members.find((candidate) => groupMemberKey(candidate) === patch.leaderKey);
                    if (member === undefined) {
                        throw new Error('marshal: groups leader-not-member: the leader key is not one of the members');
                    }
                    next.leader = { deviceId: member.deviceId, squadId: member.squadId, memberId: member.memberId };
                }
            }
            return groupStore.update(id, next);
        },
        remove(id) {
            return groupStore.remove(id);
        },
        addMember(id, input) {
            return groupStore.addMember(id, memberDraft(input, deviceId));
        },
        removeMember(id, key) {
            return groupStore.removeMember(id, key);
        },
        bind(id, key, sessionId) {
            return groupStore.setSession(id, key, sessionId);
        },
        setMessageTask(id, messageId, task) {
            return groupStore.setMessageTask(id, messageId, task);
        },
        async send(id, input) {
            if (input === null || typeof input !== 'object') {
                throw new Error('marshal: groups invalid-message: a send request must be an object');
            }
            const text = typeof input.text === 'string' ? input.text : '';
            const mentions = parseMentions(text);
            const message = groupStore.appendMessage(id, { text, mentions, author: 'user' });
            const group = groupStore.get(id);
            const leader = leaderOf(group);
            // leader 所在设备离线时，整个群暂时不可用。
            if (leader !== undefined && isAvailable(leader.deviceId) === false) {
                return { message, deliveries: [], error: 'leader-unavailable' };
            }
            let targets;
            if (mentions.includes('all')) targets = group.members;
            else if (mentions.length > 0) targets = group.members.filter((member) => mentions.includes(member.name));
            else targets = leader === undefined ? [] : [leader];
            const unknown = mentions.filter((name) => name !== 'all'
                && !group.members.some((member) => member.name === name));
            const offline = targets.filter((member) => isAvailable(member.deviceId) === false);
            const outcomes = await mapLimit(targets, CONCURRENCY, async (member) => {
                const key = groupMemberKey(member);
                if (isAvailable(member.deviceId) === false) {
                    groupStore.markDelivery(id, message.id, key, { state: 'failed', code: 'unavailable' });
                    return { memberKey: key, state: 'failed', code: 'unavailable' };
                }
                if (member.sessionId === undefined) {
                    groupStore.markDelivery(id, message.id, key, { state: 'failed', code: 'no-session' });
                    return { memberKey: key, state: 'failed', code: 'no-session' };
                }
                try {
                    const baseline = replyReader === undefined
                        ? 0
                        : await replyReader.latest(member.sessionId).catch(() => 0);
                    await promptSession({
                        sessionId: member.sessionId,
                        text,
                        requestId: randomUUID(),
                    });
                    groupStore.markDelivery(id, message.id, key, { state: 'accepted' });
                    watchReplies(id, member, baseline);
                    return { memberKey: key, state: 'accepted' };
                }
                catch (error) {
                    const code = errorCode(error);
                    groupStore.markDelivery(id, message.id, key, { state: 'failed', code });
                    return { memberKey: key, state: 'failed', code };
                }
            });
            // 工作成员离线时，让 leader 决定：新建临时智能体，或改派给其他人。
            let fallback = false;
            if (offline.length > 0 && leader !== undefined && !offline.includes(leader) && leader.sessionId !== undefined) {
                try {
                    await promptSession({
                        sessionId: leader.sessionId,
                        requestId: randomUUID(),
                        text: '以下成员所在设备离线：' + offline.map((member) => '「' + member.name + '」').join('、')
                            + '。请创建一个临时智能体接替，或把任务指派给其他成员。原消息：' + text,
                    });
                    fallback = true;
                }
                catch { /* fallback delivery is best effort */ }
            }
            return {
                message: groupStore.get(id).messages.find((candidate) => candidate.id === message.id),
                deliveries: outcomes,
                ...(unknown.length === 0 ? {} : { unknown }),
                ...(offline.length === 0 ? {} : { offline: offline.map((member) => member.name), fallback }),
                ...(targets.length === 0 ? { warning: 'no-target' } : {}),
            };
        },
    };
}
