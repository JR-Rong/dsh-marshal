import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFile } from './state-file.js';

const MAX_MEMBERS = 12;
const MAX_MESSAGES = 500;

function memberKey(member) {
    return member.deviceId + '/' + member.agent + '/' + member.sessionId;
}

function textOf(event) {
    const payload = event !== null && typeof event === 'object' ? event.payload : undefined;
    if (payload !== null && typeof payload === 'object' && typeof payload.text === 'string') return payload.text;
    return '';
}

/**
 * Cross-device group ledger. The hub owns membership and messages; each
 * message is delivered to the member's resident session with the existing
 * relay `prompt` command, and the member's reply is rebuilt from that
 * session's event stream. No model calls happen on the hub.
 */
export function createCrossGroups({ relay, now = Date.now, maxMessages = MAX_MESSAGES, file } = {}) {
    if (!relay || typeof relay.command !== 'function' || typeof relay.subscribe !== 'function') {
        throw new Error('marshal: cross-groups requires relay');
    }
    const groups = new Map();
    const active = new Map();
    const save = () => {
        if (typeof file !== 'string' || file === '') return;
        try { atomicWriteFile(file, JSON.stringify({ version: 1, groups: [...groups.values()] }, null, 2) + '\n'); }
        catch { /* a failed save must not break live delivery */ }
    };
    if (typeof file === 'string' && file !== '' && existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            for (const group of Array.isArray(parsed?.groups) ? parsed.groups : []) {
                if (group !== null && typeof group === 'object' && typeof group.id === 'string'
                    && Array.isArray(group.members) && Array.isArray(group.messages)) groups.set(group.id, group);
            }
        }
        catch { /* an unreadable ledger starts empty; the hub stays available */ }
    }
    const subscribers = new Set();

    const broadcast = (groupId) => {
        for (const subscriber of [...subscribers]) {
            try { subscriber({ type: 'cross-groups.changed', groupId }); }
            catch { /* a broken subscriber must not affect delivery */ }
        }
    };
    const findMember = (event) => {
        for (const group of groups.values()) {
            const member = group.members.find(item => item.sessionId === event.sessionId);
            if (member !== undefined) return { group, member };
        }
        return undefined;
    };
    const onEvent = (event) => {
        if (event === null || typeof event !== 'object' || typeof event.sessionId !== 'string') return;
        const found = findMember(event);
        if (found === undefined) return;
        const key = memberKey(found.member);
        const pending = active.get(key);
        if (pending === undefined) return;
        if (event.kind === 'message.delta') {
            const text = textOf(event);
            if (text === '') return;
            pending.text += text;
            if (pending.messageId === undefined) {
                pending.messageId = randomUUID();
                found.group.messages.push({
                    id: pending.messageId, role: 'member', author: found.member.name,
                    memberId: found.member.id, text: '', at: now(), requestId: pending.requestId, streaming: true,
                });
                if (found.group.messages.length > maxMessages) found.group.messages.splice(0, found.group.messages.length - maxMessages);
            }
            const message = found.group.messages.find(item => item.id === pending.messageId);
            if (message !== undefined) message.text = pending.text;
            broadcast(found.group.id);
            return;
        }
        if (event.kind === 'message.completed') {
            const text = textOf(event);
            if (text !== '' && pending.text === '') pending.text = text;
            return;
        }
        if (event.kind !== 'turn.completed') return;
        active.delete(key);
        const text = pending.text.trim();
        if (text !== '') {
            appendReply(found.group, found.member, text, pending.requestId, pending.messageId);
            return;
        }
        void readHistory(found.group, found.member, pending);
    };
    const unsubscribe = relay.subscribe(onEvent);

    const appendReply = (group, member, text, requestId, messageId) => {
        if (messageId !== undefined) {
            const message = group.messages.find(item => item.id === messageId);
            if (message !== undefined) {
                message.text = text === '' ? '（没有返回内容）' : text;
                message.streaming = false;
                save();
                broadcast(group.id);
                return;
            }
        }
        group.messages.push({
            id: randomUUID(), role: 'member', author: member.name,
            memberId: member.id, text: text === '' ? '（没有返回内容）' : text, at: now(), requestId,
        });
        if (group.messages.length > maxMessages) group.messages.splice(0, group.messages.length - maxMessages);
        save();
        broadcast(group.id);
    };
    const readHistory = async (group, member, pending) => {
        try {
            const outcome = await relay.command({
                op: 'observe',
                target: { deviceId: member.deviceId, agent: member.agent, sessionId: member.sessionId },
                args: { kind: 'history', limit: 40 },
                idempotencyKey: 'cross-history:' + group.id + ':' + pending.requestId,
            });
            const items = outcome?.history?.items ?? outcome?.result?.items ?? outcome?.items ?? [];
            let text = '';
            for (const item of items) {
                if (item?.kind === 'message.delta') text += textOf(item);
                else if (item?.kind === 'message.completed' && textOf(item) !== '') text = textOf(item);
            }
            appendReply(group, member, text, pending.requestId, pending.messageId);
        }
        catch {
            appendReply(group, member, '', pending.requestId, pending.messageId);
        }
    };

    const create = (input) => {
        if (input === null || typeof input !== 'object') throw new Error('invalid-args');
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name === '' || name.length > 60) throw new Error('invalid-name');
        const members = Array.isArray(input.members) ? input.members : [];
        if (members.length < 2 || members.length > MAX_MEMBERS) throw new Error('invalid-members');
        const seen = new Set();
        const normalized = members.map((member, index) => {
            if (member === null || typeof member !== 'object') throw new Error('invalid-member');
            const deviceId = String(member.deviceId ?? '');
            const agent = String(member.agent ?? 'dsh');
            const sessionId = String(member.sessionId ?? '');
            const memberName = String(member.name ?? ('成员' + (index + 1))).trim().slice(0, 40);
            if (deviceId === '' || sessionId === '' || memberName === '') throw new Error('invalid-member');
            if (seen.has(deviceId + '/' + agent + '/' + sessionId)) throw new Error('duplicate-member');
            seen.add(deviceId + '/' + agent + '/' + sessionId);
            return { id: randomUUID(), deviceId, agent, sessionId, name: memberName };
        });
        const leaderId = input.leaderId === undefined ? normalized[0].id : String(input.leaderId);
        const leader = normalized.find(member => member.id === leaderId);
        if (leader === undefined) throw new Error('leader-not-member');
        const group = { id: randomUUID(), name, members: normalized, leaderId: leader.id, messages: [], createdAt: now() };
        groups.set(group.id, group);
        save();
        broadcast(group.id);
        return group;
    };

    const view = (group) => ({
        ...group,
        members: group.members.map(member => ({ ...member })),
        messages: group.messages.slice(),
    });
    const list = () => [...groups.values()].map(view);
    const get = (id) => {
        const group = groups.get(id);
        if (group === undefined) throw new Error('group-not-found');
        return view(group);
    };

    const observe = async (group, member) => {
        try {
            return await relay.command({
                op: 'observe',
                target: { deviceId: member.deviceId, agent: member.agent, sessionId: member.sessionId },
                args: { kind: 'follow', action: 'subscribe', subscriptionId: randomUUID() },
                idempotencyKey: 'cross-observe:' + group.id + ':' + member.id,
            });
        }
        catch { /* prompt still works; the reply may be missed if follow is unavailable */ }
    };

    const send = async (id, input) => {
        const group = groups.get(id);
        if (group === undefined) throw new Error('group-not-found');
        const text = typeof input?.text === 'string' ? input.text.trim() : '';
        if (text === '' || text.length > 16384) throw new Error('invalid-text');
        const mentions = Array.isArray(input?.mentions) ? input.mentions : [];
        let targets;
        if (mentions.length === 0) {
            const leader = group.members.find(member => member.id === group.leaderId);
            targets = leader === undefined ? [] : [leader];
        }
        else {
            targets = group.members.filter(member => mentions.includes(member.name));
        }
        const unknown = mentions.filter(name => !group.members.some(member => member.name === name));
        const message = { id: randomUUID(), role: 'user', author: '我', text, at: now(), mentions };
        group.messages.push(message);
        if (group.messages.length > maxMessages) group.messages.shift();
        save();
        const deliveries = [];
        for (const member of targets) {
            const key = memberKey(member);
            if (active.has(key)) {
                deliveries.push({ memberId: member.id, name: member.name, state: 'busy' });
                continue;
            }
            await observe(group, member);
            const requestId = randomUUID();
            active.set(key, { groupId: group.id, memberId: member.id, requestId, text: '' });
            try {
                const outcome = await relay.command({
                    op: 'prompt',
                    target: { deviceId: member.deviceId, agent: member.agent, sessionId: member.sessionId },
                    args: { text },
                    idempotencyKey: 'cross-group:' + group.id + ':' + message.id + ':' + member.id,
                });
                if (outcome !== null && typeof outcome === 'object' && outcome.ok === false) {
                    active.delete(key);
                    deliveries.push({ memberId: member.id, name: member.name, state: 'failed', code: outcome.code ?? 'command-failed' });
                }
                else {
                    deliveries.push({ memberId: member.id, name: member.name, state: 'sent' });
                }
            }
            catch (error) {
                active.delete(key);
                deliveries.push({ memberId: member.id, name: member.name, state: 'failed', code: error instanceof Error ? error.message : 'command-failed' });
            }
        }
        broadcast(group.id);
        return { group: view(group), message, deliveries, ...(unknown.length === 0 ? {} : { unknown }) };
    };

    return {
        create, list, get, send,
        subscribe(consumer) { subscribers.add(consumer); return () => subscribers.delete(consumer); },
        dispose() { unsubscribe(); subscribers.clear(); active.clear(); },
        state() {
            const activeMembers = [...active.values()].map(item => ({ groupId: item.groupId, memberId: item.memberId }));
            return { groups: list().map(group => ({ ...group, active: activeMembers.filter(item => item.groupId === group.id).map(item => item.memberId) })) };
        },
    };
}
