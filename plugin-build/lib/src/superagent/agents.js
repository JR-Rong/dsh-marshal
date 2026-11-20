/**
 * Read-only view of the dsh-agents ledger.
 *
 * The bridge never writes the agent library: it only resolves who a card names.
 * The ledger path follows @linxin666/dsh-agents (DSH_HOME first, then ~/.dsh),
 * and a missing or unreadable ledger degrades the bridge instead of failing the
 * plugin.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function viewMember(member) {
    if (member === null || typeof member !== 'object') return undefined;
    const id = typeof member.id === 'string' ? member.id : '';
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    if (id === '' || name === '') return undefined;
    return {
        id,
        name,
        ...(typeof member.preset === 'string' && member.preset !== '' ? { preset: member.preset } : {}),
        ...(typeof member.permission === 'string' && member.permission !== '' ? { permission: member.permission } : {}),
        ...(typeof member.model === 'string' && member.model !== '' ? { model: member.model } : {}),
        ...(typeof member.reasoningEffort === 'string' && member.reasoningEffort !== '' ? { reasoningEffort: member.reasoningEffort } : {}),
        ...(typeof member.brief === 'string' && member.brief.trim() !== '' ? { brief: member.brief.trim() } : {}),
    };
}

/**
 * Flatten the ledger into members. A member in a marshal-agent: team is the
 * current shape; the legacy 智能体库 team is kept as a fallback so older
 * installs keep working.
 */
export function readAgents(env = process.env, home = homedir()) {
    const file = agentsLedgerPath(env, home);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (cause) {
        return {
            available: false,
            file,
            code: cause?.code === 'ENOENT' ? 'no-ledger' : 'ledger-unreadable',
            members: [],
            teams: [],
        };
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.teams)) {
        return { available: false, file, code: 'ledger-invalid', members: [], teams: [] };
    }
    const teams = [];
    const members = [];
    for (const team of parsed.teams) {
        if (team === null || typeof team !== 'object') continue;
        const teamId = typeof team.id === 'string' ? team.id : '';
        const teamName = typeof team.name === 'string' ? team.name : '';
        if (teamId === '' || teamName === '') continue;
        const marshalAgent = teamName.startsWith('marshal-agent:');
        const legacy = teamName === '智能体库';
        if (!marshalAgent && !legacy) continue;
        const teamView = {
            id: teamId,
            name: teamName,
            marshalAgent,
            legacy,
            ...(typeof team.workspaceId === 'string' && team.workspaceId !== '' ? { workspaceId: team.workspaceId } : {}),
        };
        teams.push(teamView);
        for (const rawMember of Array.isArray(team.members) ? team.members : []) {
            const member = viewMember(rawMember);
            if (member === undefined) continue;
            members.push({ ...member, teamId, teamName, teamWorkspaceId: teamView.workspaceId, legacy });
        }
    }
    members.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { available: true, file, code: undefined, members, teams };
}

function preferMember(candidates, workspaceId) {
    if (candidates.length <= 1) return candidates[0];
    const current = candidates.filter(candidate => !candidate.legacy);
    const pool = current.length > 0 ? current : candidates;
    if (pool.length === 1) return pool[0];
    if (typeof workspaceId === 'string' && workspaceId !== '') {
        const scoped = pool.filter(candidate => candidate.teamWorkspaceId === workspaceId);
        if (scoped.length === 1) return scoped[0];
    }
    return undefined;
}

/** Resolve exactly one member by id or display name. */
export function findMember(members, query, workspaceId) {
    if (typeof query !== 'string') return undefined;
    const value = query.trim();
    if (value === '') return undefined;
    const byId = members.filter(member => member.id === value);
    if (byId.length === 1) return byId[0];
    const exact = members.filter(member => member.name === value);
    if (exact.length > 0) return preferMember(exact, workspaceId);
    const folded = value.toLocaleLowerCase();
    const loose = members.filter(member => member.name.toLocaleLowerCase() === folded);
    if (loose.length > 0) return preferMember(loose, workspaceId);
    return undefined;
}

function stripTagPrefix(name, prefix) {
    let value = name.trim();
    if (value === '') return '';
    for (const marker of [prefix + ':', prefix, '@', '智能体:', '派给:']) {
        if (value.startsWith(marker) && value.length > marker.length) {
            value = value.slice(marker.length).trim();
            break;
        }
    }
    return value;
}

/**
 * A card can name its executor with a tag. Tags are display strings on the
 * board, so this resolver is intentionally conservative: a tag only wins when
 * it maps to exactly one known member (by name, id, or a configured alias).
 */
export function resolveTaggedAgent(task, settings, members) {
    const prefix = settings.tagPrefix || '@';
    const tags = Array.isArray(task.tags) ? task.tags : [];
    for (const tag of tags) {
        const raw = typeof tag?.name === 'string' ? tag.name.trim() : '';
        if (raw === '') continue;
        const stripped = stripTagPrefix(raw, prefix);
        if (stripped === '') continue;
        const alias = settings.aliases?.[stripped] ?? settings.aliases?.[stripped.toLocaleLowerCase()];
        const member = findMember(members, alias ?? stripped, task?.workspaceId);
        if (member !== undefined) return { member, via: 'tag', tag: raw };
    }
    return undefined;
}

export function resolveAgentForTask(task, settings, members) {
    const tagged = resolveTaggedAgent(task, settings, members);
    if (tagged !== undefined) return tagged;
    if (typeof settings.defaultAgent === 'string' && settings.defaultAgent.trim() !== '') {
        const member = findMember(members, settings.defaultAgent, task?.workspaceId);
        if (member !== undefined) return { member, via: 'default', tag: null };
        return { member: undefined, via: 'default', error: 'default-agent-not-found: ' + settings.defaultAgent };
    }
    return { member: undefined, via: 'none', error: 'no-agent: set defaultAgent or add a @agent tag' };
}
