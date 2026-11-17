import { specToJsonSchema } from '../tools/schema.js';

const AGENT_ACTIONS = ['list', 'create', 'update', 'delete', 'chat'];
const GROUP_ACTIONS = ['list', 'get', 'create', 'send'];

function textOutput(value) {
    return { type: 'string' };
}

function render(args, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text }];
}

export function createAgentsHttpClient({ baseUrl, fetchImpl = fetch } = {}) {
    const base = () => {
        const value = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
        if (typeof value !== 'string' || value === '') throw new Error('marshal: agents no-web-server');
        return value.replace(/\/+$/, '');
    };
    const request = async (path, body) => {
        const root = base();
        const response = await fetchImpl(root + path, body === undefined ? {
            headers: { origin: root, 'sec-fetch-site': 'same-origin' },
        } : {
            method: 'POST',
            headers: { origin: root, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (!response.ok) throw new Error((data && (data.code || data.message)) || ('HTTP ' + response.status));
        return data;
    };
    const isAgentTeam = (team) => team.name === '智能体库' || team.name.startsWith('marshal-agent:');
    const collect = (state) => {
        const agents = [];
        for (const team of state.teams || []) {
            if (!isAgentTeam(team)) continue;
            for (const member of team.members || []) {
                agents.push({ ...member, squadId: team.id, teamName: team.name, workspaceId: team.workspaceId, legacy: team.name === '智能体库' });
            }
        }
        return agents;
    };
    const findAgent = async (memberId) => {
        const state = await request('/dsh-agents/api/state');
        const agent = collect(state).find(item => item.id === memberId);
        if (agent === undefined) throw new Error('agent-not-found');
        return agent;
    };
    return {
        async list() {
            return collect(await request('/dsh-agents/api/state'));
        },
        async create(member) {
            const suffix = Math.random().toString(36).slice(2, 8);
            const teamName = 'marshal-agent:' + String(member.name || 'agent').replace(/\s+/g, '-').slice(0, 40) + '-' + suffix;
            const created = await request('/dsh-agents/api/team', {
                team: { name: teamName, ...(member.workspaceId ? { workspaceId: member.workspaceId } : {}) },
            });
            const draft = { ...member };
            delete draft.workspaceId;
            const data = await request('/dsh-agents/api/member', { teamId: created.team.id, member: draft });
            return data.team;
        },
        async update(member) {
            const agent = await findAgent(member.id);
            if (!agent.legacy && member.workspaceId !== undefined) {
                await request('/dsh-agents/api/team', {
                    team: { id: agent.squadId, name: agent.teamName, ...(member.workspaceId ? { workspaceId: member.workspaceId } : {}) },
                });
            }
            const draft = { ...member };
            delete draft.workspaceId;
            const data = await request('/dsh-agents/api/member', { teamId: agent.squadId, member: draft });
            return data.team;
        },
        async remove(memberId) {
            const agent = await findAgent(memberId);
            const data = agent.legacy
                ? await request('/dsh-agents/api/member/delete', { teamId: agent.squadId, memberId })
                : await request('/dsh-agents/api/team/delete', { teamId: agent.squadId });
            return data?.team ?? { members: [] };
        },
        async chat(memberId) {
            const agent = await findAgent(memberId);
            return (await request('/dsh-agents/api/run', { teamId: agent.squadId, memberId })).run;
        },
    };
}

export function agentToolDefinitions({ agents, service } = {}) {
    const agentTool = {
        name: 'marshal_agent',
        description: '管理调度官里的智能体（不是小队）：list 列出；create 创建；update 修改；delete 删除；chat 打开/创建该智能体的常驻会话，返回 sessionId。修改会整条替换定义，清空的字段恢复默认。',
        parameters: {
            action: { type: 'string', required: true, enum: AGENT_ACTIONS },
            agentId: { type: 'string', description: 'update/delete/chat 的智能体 id。' },
            name: { type: 'string', description: 'create/update 的名称。' },
            preset: { type: 'string', description: 'create/update 的预设 id，留空为默认。' },
            permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'create/update 的权限。' },
            model: { type: 'string', description: 'create/update 的模型路由，如 deepseek-account/deepseek-flash。' },
            brief: { type: 'string', description: 'create/update 的简报，进入该系统提示。' },
            workspaceId: { type: 'string', description: 'create/update 的工作区 id；不传则保持/使用 Host 默认。' },
        },
        output: { schema: textOutput(), render },
        async execute(args) {
            if (args.action === 'list') return JSON.stringify(await agents.list());
            if (args.action === 'chat') {
                if (typeof args.agentId !== 'string' || args.agentId === '') throw new Error('agentId is required');
                return JSON.stringify(await agents.chat(args.agentId));
            }
            if (args.action === 'delete') {
                if (typeof args.agentId !== 'string' || args.agentId === '') throw new Error('agentId is required');
                return JSON.stringify(await agents.remove(args.agentId));
            }
            const member = {};
            if (typeof args.name === 'string' && args.name.trim() !== '') member.name = args.name.trim();
            if (typeof args.preset === 'string' && args.preset !== '') member.preset = args.preset;
            if (typeof args.permission === 'string' && args.permission !== '') member.permission = args.permission;
            if (typeof args.model === 'string' && args.model !== '') member.model = args.model;
            if (typeof args.brief === 'string' && args.brief.trim() !== '') member.brief = args.brief.trim();
            if (typeof args.workspaceId === 'string' && args.workspaceId !== '') member.workspaceId = args.workspaceId;
            if (args.action === 'create') {
                if (member.name === undefined) throw new Error('name is required');
                return JSON.stringify(await agents.create(member));
            }
            if (args.action === 'update') {
                if (typeof args.agentId !== 'string' || args.agentId === '') throw new Error('agentId is required');
                if (member.name === undefined) throw new Error('name is required');
                member.id = args.agentId;
                return JSON.stringify(await agents.update(member));
            }
            throw new Error('unknown agent action');
        },
    };
    const groupTool = {
        name: 'marshal_group',
        description: '调度官群聊：list 列出群；get 读群与消息；create 建群（members 里每位带 squadId/memberId/name，leaderKey 可选）；send 发消息（@名字 / @all，不 @ 由 leader 回）。成员必须先在智能体库里存在。',
        parameters: {
            action: { type: 'string', required: true, enum: GROUP_ACTIONS },
            groupId: { type: 'string', description: 'get/send 的群 id。' },
            name: { type: 'string', description: 'create 的群名。' },
            text: { type: 'string', description: 'send 的消息正文。' },
            leaderKey: { type: 'string', description: 'create 的 leader，格式 deviceId/squadId/memberId；留空用第一位成员。' },
            members: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        deviceId: { type: 'string' },
                        squadId: { type: 'string', required: true },
                        memberId: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        preset: { type: 'string' },
                        permission: { type: 'string' },
                        model: { type: 'string' },
                    },
                },
                description: 'create 的成员列表。',
            },
        },
        output: { schema: textOutput(), render },
        async execute(args) {
            if (args.action === 'list') return JSON.stringify(service.state());
            if (args.action === 'get') {
                if (typeof args.groupId !== 'string' || args.groupId === '') throw new Error('groupId is required');
                return JSON.stringify(service.get(args.groupId));
            }
            if (args.action === 'create') {
                if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('name is required');
                const group = service.create({
                    name: args.name.trim(),
                    mode: 'chat',
                    members: Array.isArray(args.members) ? args.members : [],
                    ...(typeof args.leaderKey === 'string' && args.leaderKey !== '' ? { leaderKey: args.leaderKey } : {}),
                });
                return JSON.stringify(group);
            }
            if (args.action === 'send') {
                if (typeof args.groupId !== 'string' || args.groupId === '') throw new Error('groupId is required');
                if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required');
                return JSON.stringify(await service.send(args.groupId, { text: args.text }));
            }
            throw new Error('unknown group action');
        },
    };
    for (const tool of [agentTool, groupTool]) tool.parameters = specToJsonSchema(tool.parameters);
    return [agentTool, groupTool];
}
