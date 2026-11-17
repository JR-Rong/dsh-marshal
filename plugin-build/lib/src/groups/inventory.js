import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 设备侧资产清单：只读智能体插件（dsh-agents）的账本，不改它。
 * 路径解析与 dsh-agents 保持一致：$DSH_HOME 优先，默认 ~/.dsh。
 */
export function resolveDshHome(env = process.env, home = homedir()) {
    const raw = env.DSH_HOME;
    if (raw !== undefined && raw.trim() !== '') {
        const value = raw.trim();
        if (value === '~') return home;
        if (value.startsWith('~/')) return join(home, value.slice(2));
        return value;
    }
    return join(home, '.dsh');
}

export function agentsLedgerPath(env = process.env, home = homedir()) {
    return join(resolveDshHome(env, home), 'dsh-agents', 'ledger.json');
}

function memberView(member, sessionId) {
    if (member === null || typeof member !== 'object') return undefined;
    const id = typeof member.id === 'string' ? member.id : '';
    const name = typeof member.name === 'string' ? member.name : '';
    if (id === '' || name === '') return undefined;
    return {
        id,
        name,
        ...(typeof member.preset === 'string' ? { preset: member.preset } : {}),
        ...(typeof member.permission === 'string' ? { permission: member.permission } : {}),
        ...(typeof member.model === 'string' ? { model: member.model } : {}),
        ...(typeof member.reasoningEffort === 'string' ? { reasoningEffort: member.reasoningEffort } : {}),
        ...(typeof member.brief === 'string' ? { brief: member.brief } : {}),
        ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    };
}

function teamView(team, latestSession) {
    if (team === null || typeof team !== 'object') return undefined;
    const id = typeof team.id === 'string' ? team.id : '';
    const name = typeof team.name === 'string' ? team.name : '';
    if (id === '' || name === '') return undefined;
    return {
        id,
        name,
        ...(typeof team.description === 'string' ? { description: team.description } : {}),
        ...(typeof team.workspaceId === 'string' ? { workspaceId: team.workspaceId } : {}),
        ...(typeof team.leadPreset === 'string' ? { leadPreset: team.leadPreset } : {}),
        members: (Array.isArray(team.members) ? team.members : [])
            .map(member => memberView(member, latestSession?.get(id + '/' + (member?.id ?? ''))))
            .filter(Boolean),
    };
}

export function readAgentsLedger({ env = process.env, home = homedir() } = {}) {
    const file = agentsLedgerPath(env, home);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        return {
            available: false,
            file,
            code: error.code === 'ENOENT' ? 'no-ledger' : 'ledger-unreadable',
            teams: [],
        };
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.teams)) {
        return { available: false, file, code: 'ledger-invalid', teams: [] };
    }
    const latestSession = new Map();
    for (const run of Array.isArray(parsed.runs) ? parsed.runs : []) {
        if (run === null || typeof run !== 'object') continue;
        if (typeof run.teamId !== 'string' || typeof run.memberId !== 'string' || typeof run.sessionId !== 'string') continue;
        const key = run.teamId + '/' + run.memberId;
        const at = typeof run.createdAt === 'number' ? run.createdAt : 0;
        const prior = latestSession.get(key);
        if (prior === undefined || at >= prior.at) latestSession.set(key, { at, sessionId: run.sessionId });
    }
    return {
        available: true,
        file,
        teams: parsed.teams.map(team => teamView(team, new Map([...latestSession].map(([key, value]) => [key, value.sessionId])))).filter(Boolean),
    };
}
