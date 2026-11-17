import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { agentsLedgerPath } from './inventory.js';

function readLedger(env = process.env) {
    try {
        const parsed = JSON.parse(readFileSync(agentsLedgerPath(env), 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

function memberBrief(ledger, name) {
    for (const team of Array.isArray(ledger.teams) ? ledger.teams : []) {
        for (const member of Array.isArray(team?.members) ? team.members : []) {
            if (member?.name === name && typeof member.brief === 'string' && member.brief.trim() !== '') return member.brief.trim();
        }
    }
    return '';
}

function isMemberRun(ledger, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    return (Array.isArray(ledger.runs) ? ledger.runs : []).some(run => run !== null && typeof run === 'object' && run.sessionId === sessionId);
}

/**
 * Identity for an ordinary session created inside an agent workspace.
 * Member runs already receive the dsh-agents member-brief section; this seam
 * covers the other case (a new session opened in "Agent · 名字"), where the
 * deployment persona would otherwise keep calling itself "lead".
 */
export function workspaceIdentityText(context, options = {}) {
    const agent = context !== null && typeof context === 'object' ? context.agent : undefined;
    const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
    const header = session !== null && typeof session === 'object' ? session.header : undefined;
    const cwd = header !== null && typeof header === 'object' && typeof header.cwd === 'string' ? header.cwd : '';
    if (cwd === '') return '';
    const root = resolve(options.root ?? join(homedir(), '.dsh-marshal', 'agents'));
    const absolute = resolve(cwd);
    if (absolute !== root && !absolute.startsWith(root + sep)) return '';
    const relative = absolute.slice(root.length).replace(/^[/\\]+/, '');
    const folder = relative.split(/[/\\]/)[0];
    if (!folder.startsWith('Agent · ')) return '';
    const name = folder.slice('Agent · '.length).trim();
    if (name === '') return '';
    const ledger = options.ledger ?? readLedger(options.env ?? process.env);
    if (isMemberRun(ledger, session?.id ?? session?.sessionId)) return '';
    const brief = memberBrief(ledger, name);
    const identity = '【身份】你的名字是「' + name + '」。以下是你的人设、职责与长期记忆，始终以此为准；不要自称 lead 或其他默认身份。';
    return brief === '' ? identity : identity + '\n\n' + brief;
}

export function mountWorkspaceIdentity(ctx, options = {}) {
    ctx.inject(['systemPrompt'], (scoped) => {
        scoped.effect(() => {
            const order = typeof scoped.systemPrompt.getSectionOrder === 'function'
                ? scoped.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 2
                : 2;
            return scoped.systemPrompt.section({
                name: 'marshal:agent-workspace-identity',
                order,
                text: context => workspaceIdentityText(context, options),
            });
        }, 'marshal: agent workspace identity');
    });
}
