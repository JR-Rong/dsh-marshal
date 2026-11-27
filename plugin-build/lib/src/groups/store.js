import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile, readTextIfExists, withFileLock } from '../hub/state-file.js';

/**
 * 常驻群聊的本地账本：群、成员（带 deviceId）、leader、会话绑定、消息。
 * 单文件 JSON + 原子写 + 进程间锁；与派单台账同源，不引入新依赖。
 *
 * 所有实体都带 deviceId：本机先落盘，跨设备时同一份形状搬到 hub，不返工。
 */
export const GROUP_STORE_VERSION = 1;
export const GROUP_NAME_MAX = 60;
export const GROUP_MEMBERS_MIN = 2;
export const GROUP_MEMBERS_MAX = 12;
export const GROUP_MESSAGES_KEEP = 500;
export const GROUP_MESSAGE_BYTES = 16 * 1024;
export const GROUP_MODES = ['chat', 'discussion'];
export const GROUP_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];

export class GroupStoreError extends Error {
    constructor(code, detail) {
        super('marshal: groups ' + code + ': ' + detail);
        this.name = 'GroupStoreError';
        this.code = code;
    }
}

const clean = (value) => typeof value === 'string' && value.trim() !== '';
const control = /[\x00-\x1f\x7f]/;

export function groupMemberKey(member) {
    return member.deviceId + '/' + member.squadId + '/' + member.memberId;
}

function validateMember(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new GroupStoreError('invalid-member', 'a member must be an object');
    }
    for (const field of ['deviceId', 'squadId', 'memberId', 'name']) {
        if (!clean(value[field])) {
            throw new GroupStoreError('invalid-member', 'member.' + field + ' must be a non-empty string');
        }
    }
    if (control.test(value.name)) {
        throw new GroupStoreError('invalid-member', 'member.name must not contain control characters');
    }
    if (value.permission !== undefined && !GROUP_PERMISSIONS.includes(value.permission)) {
        throw new GroupStoreError('invalid-member', 'member.permission is not a known preset');
    }
    for (const field of ['preset', 'model', 'reasoningEffort', 'sessionId']) {
        if (value[field] !== undefined && !clean(value[field])) {
            throw new GroupStoreError('invalid-member', 'member.' + field + ' must be a non-empty string when present');
        }
    }
    return {
        deviceId: value.deviceId,
        squadId: value.squadId,
        memberId: value.memberId,
        name: value.name.trim().slice(0, GROUP_NAME_MAX),
        ...(value.preset === undefined ? {} : { preset: value.preset }),
        ...(value.permission === undefined ? {} : { permission: value.permission }),
        ...(value.model === undefined ? {} : { model: value.model }),
        ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
        ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    };
}

function leaderRef(member) {
    return { deviceId: member.deviceId, squadId: member.squadId, memberId: member.memberId };
}

function sameLeader(leader, member) {
    return leader !== undefined && leader.deviceId === member.deviceId
        && leader.squadId === member.squadId && leader.memberId === member.memberId;
}

function clone(value) {
    return structuredClone(value);
}

function validateMessage(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new GroupStoreError('invalid-message', 'a message must be an object');
    }
    if (!clean(value.text)) {
        throw new GroupStoreError('invalid-message', 'message.text must be a non-empty string');
    }
    if (Buffer.byteLength(value.text) > GROUP_MESSAGE_BYTES) {
        throw new GroupStoreError('message-too-large', 'message.text exceeds ' + GROUP_MESSAGE_BYTES + ' bytes');
    }
    const author = value.author ?? 'user';
    if (author !== 'user' && author !== 'member') {
        throw new GroupStoreError('invalid-message', 'message.author must be user or member');
    }
    const mentions = value.mentions ?? [];
    if (!Array.isArray(mentions) || mentions.length > 12 || mentions.some((name) => !clean(name))) {
        throw new GroupStoreError('invalid-message', 'message.mentions must be at most 12 non-empty names');
    }
    const source = value.source;
    if (source !== undefined && (author !== 'member' || !clean(source?.sessionId)
        || !Number.isSafeInteger(source?.seq) || source.seq < 0)) {
        throw new GroupStoreError('invalid-source', 'member reply source needs a session id and event sequence');
    }
    return {
        author,
        text: value.text,
        ...(source === undefined ? {} : { source: { sessionId: source.sessionId, seq: source.seq } }),
        mentions: mentions.map((name) => name.trim().slice(0, GROUP_NAME_MAX)),
        ...(value.authorDeviceId === undefined ? {} : { authorDeviceId: String(value.authorDeviceId) }),
        ...(value.authorMemberId === undefined ? {} : { authorMemberId: String(value.authorMemberId) }),
    };
}

export function createGroupStore({ root, now = Date.now, idFactory = randomUUID } = {}) {
    if (!clean(root)) {
        throw new GroupStoreError('invalid-root', 'root must be a non-empty path');
    }
    const file = join(root, 'groups.json');
    let state = load();

    function load() {
        const text = readTextIfExists(file);
        if (text === undefined) {
            return { version: GROUP_STORE_VERSION, groups: [] };
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new GroupStoreError('corrupt', 'groups.json is not valid JSON');
        }
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== GROUP_STORE_VERSION
            || !Array.isArray(parsed.groups)) {
            throw new GroupStoreError('corrupt', 'groups.json has an unsupported shape');
        }
        return parsed;
    }

    function persist() {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const text = JSON.stringify(state, null, 2) + '\n';
        withFileLock(file, () => atomicWriteFile(file, text));
    }

    function requireGroup(id) {
        const group = state.groups.find((candidate) => candidate.id === id);
        if (group === undefined) {
            throw new GroupStoreError('group-not-found', 'no group has the id "' + String(id) + '"');
        }
        return group;
    }

    function requireMember(group, key) {
        const member = group.members.find((candidate) => groupMemberKey(candidate) === key);
        if (member === undefined) {
            throw new GroupStoreError('member-not-found', 'group "' + group.id + '" has no member "' + key + '"');
        }
        return member;
    }

    function requireMessage(group, messageId) {
        const message = group.messages.find((candidate) => candidate.id === messageId);
        if (message === undefined) {
            throw new GroupStoreError('message-not-found', 'group "' + group.id + '" has no message "' + messageId + '"');
        }
        return message;
    }

    return {
        file,
        list() {
            return clone(state.groups);
        },
        get(id) {
            return clone(requireGroup(id));
        },
        create(input) {
            if (input === null || typeof input !== 'object') {
                throw new GroupStoreError('invalid-group', 'a group draft must be an object');
            }
            const name = typeof input.name === 'string' ? input.name.trim() : '';
            if (name === '' || name.length > GROUP_NAME_MAX || control.test(name)) {
                throw new GroupStoreError('invalid-name', 'group.name must be 1-' + GROUP_NAME_MAX + ' visible characters');
            }
            const mode = input.mode ?? 'chat';
            if (!GROUP_MODES.includes(mode)) {
                throw new GroupStoreError('invalid-mode', 'group.mode must be chat or discussion');
            }
            if (!Array.isArray(input.members) || input.members.length < GROUP_MEMBERS_MIN
                || input.members.length > GROUP_MEMBERS_MAX) {
                throw new GroupStoreError('member-limit', 'a group needs ' + GROUP_MEMBERS_MIN + '-' + GROUP_MEMBERS_MAX + ' members');
            }
            const members = input.members.map(validateMember);
            const keys = new Set();
            for (const member of members) {
                const key = groupMemberKey(member);
                if (keys.has(key)) {
                    throw new GroupStoreError('duplicate-member', 'member "' + key + '" appears twice');
                }
                keys.add(key);
            }
            const leader = input.leader === undefined ? leaderRef(members[0]) : {
                deviceId: String(input.leader.deviceId ?? ''),
                squadId: String(input.leader.squadId ?? ''),
                memberId: String(input.leader.memberId ?? ''),
            };
            if (!members.some((member) => sameLeader(leader, member))) {
                throw new GroupStoreError('leader-not-member', 'the leader must be one of the group members');
            }
            const ts = now();
            const group = {
                id: String(idFactory()),
                name,
                mode,
                leader,
                members: members.map((member) => ({ ...member, createdAt: ts })),
                messages: [],
                createdAt: ts,
                updatedAt: ts,
            };
            state.groups.push(group);
            persist();
            return clone(group);
        },
        update(id, patch) {
            const group = requireGroup(id);
            if (patch === null || typeof patch !== 'object') {
                throw new GroupStoreError('invalid-group', 'a group patch must be an object');
            }
            if (patch.name !== undefined) {
                const name = String(patch.name).trim();
                if (name === '' || name.length > GROUP_NAME_MAX || control.test(name)) {
                    throw new GroupStoreError('invalid-name', 'group.name must be 1-' + GROUP_NAME_MAX + ' visible characters');
                }
                group.name = name;
            }
            if (patch.mode !== undefined) {
                if (!GROUP_MODES.includes(patch.mode)) {
                    throw new GroupStoreError('invalid-mode', 'group.mode must be chat or discussion');
                }
                group.mode = patch.mode;
            }
            if (patch.leader !== undefined) {
                const leader = {
                    deviceId: String(patch.leader.deviceId ?? ''),
                    squadId: String(patch.leader.squadId ?? ''),
                    memberId: String(patch.leader.memberId ?? ''),
                };
                if (!group.members.some((member) => sameLeader(leader, member))) {
                    throw new GroupStoreError('leader-not-member', 'the leader must be one of the group members');
                }
                group.leader = leader;
            }
            group.updatedAt = now();
            persist();
            return clone(group);
        },
        remove(id) {
            const group = requireGroup(id);
            state.groups = state.groups.filter((candidate) => candidate.id !== group.id);
            persist();
            return { id: group.id, name: group.name };
        },
        addMember(id, value) {
            const group = requireGroup(id);
            if (group.members.length >= GROUP_MEMBERS_MAX) {
                throw new GroupStoreError('member-limit', 'a group holds at most ' + GROUP_MEMBERS_MAX + ' members');
            }
            const member = { ...validateMember(value), createdAt: now() };
            const key = groupMemberKey(member);
            if (group.members.some((candidate) => groupMemberKey(candidate) === key)) {
                throw new GroupStoreError('duplicate-member', 'member "' + key + '" is already in the group');
            }
            group.members.push(member);
            group.updatedAt = now();
            persist();
            return clone(group);
        },
        removeMember(id, key) {
            const group = requireGroup(id);
            const member = requireMember(group, key);
            if (sameLeader(group.leader, member)) {
                throw new GroupStoreError('leader-in-use', 'change the leader before removing it');
            }
            if (group.members.length <= GROUP_MEMBERS_MIN) {
                throw new GroupStoreError('member-limit', 'a group keeps at least ' + GROUP_MEMBERS_MIN + ' members');
            }
            group.members = group.members.filter((candidate) => groupMemberKey(candidate) !== key);
            group.updatedAt = now();
            persist();
            return clone(group);
        },
        setSession(id, key, sessionId) {
            const group = requireGroup(id);
            if (!clean(sessionId)) {
                throw new GroupStoreError('invalid-session', 'sessionId must be a non-empty string');
            }
            const member = requireMember(group, key);
            member.sessionId = sessionId;
            group.updatedAt = now();
            persist();
            return clone(member);
        },
        appendMessage(id, value, onInserted) {
            const group = requireGroup(id);
            const input = validateMessage(value);
            if (input.source !== undefined) {
                const existing = group.messages.find(candidate => candidate.authorDeviceId === input.authorDeviceId
                    && candidate.source?.sessionId === input.source.sessionId && candidate.source.seq === input.source.seq);
                if (existing !== undefined) return clone(existing);
            }
            const message = { id: String(idFactory()), ts: now(), ...input, deliveries: [] };
            const { messages, updatedAt } = group;
            group.messages = [...messages, message].slice(-GROUP_MESSAGES_KEEP);
            group.updatedAt = message.ts;
            try { persist(); }
            catch (error) {
                group.messages = messages;
                group.updatedAt = updatedAt;
                throw error;
            }
            onInserted?.();
            return clone(message);
        },
        markDelivery(id, messageId, key, delivery) {
            const group = requireGroup(id);
            const message = requireMessage(group, messageId);
            const state = delivery?.state;
            if (state !== 'accepted' && state !== 'failed' && state !== 'pending') {
                throw new GroupStoreError('invalid-delivery', 'delivery.state must be pending, accepted or failed');
            }
            const entry = {
                memberKey: key,
                state,
                ...(delivery.code === undefined ? {} : { code: String(delivery.code) }),
                at: now(),
            };
            message.deliveries = [...(message.deliveries ?? []).filter((candidate) => candidate.memberKey !== key), entry];
            group.updatedAt = entry.at;
            persist();
            return clone(message);
        },
        setMessageTask(id, messageId, task) {
            const group = requireGroup(id);
            const message = requireMessage(group, messageId);
            message.taskId = String(task.taskId);
            if (task.deviceId !== undefined) message.taskDeviceId = String(task.deviceId);
            group.updatedAt = now();
            persist();
            return clone(message);
        },
    };
}
