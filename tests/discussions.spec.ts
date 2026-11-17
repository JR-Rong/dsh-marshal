import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createDiscussions } from '../src/hub/discussions/coordinator.ts'
import { parseAssignments } from '../src/hub/discussions/moderator.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { ensureInstall } from '../src/hub/identity.ts'
import { openJournal } from '../src/node/journal.ts'
import type { CommandFrame } from '../src/wire/frames.ts'
import { registerMarshalRoutes, SESSION_COOKIE, CSRF_COOKIE } from '../src/hub/api.ts'
import { createMemoryWeb } from './support/memory.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-discussion-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const install = ensureInstall(join(dir, 'devices.json'))
  const registry = new DeviceRegistry(); let now = 1000
  const sent: CommandFrame[] = []
  const relay = new HubRelay({ registry, now: () => now, operatorId: install.operatorId, timeoutMs: 20 })
  cleanup.push(() => relay.dispose())
  for (const deviceId of ['a', 'b']) {
    install.store.add(deviceId, 'Mac ' + deviceId); install.store.setPolicy(deviceId, { allowDiscussion: true })
    registry.attach({ id: deviceId, name: 'Mac ' + deviceId, agents: ['dsh', 'codex'] }, { send(raw) {
      const frame = JSON.parse(raw) as CommandFrame; sent.push(frame)
      if (frame.type === 'command') queueMicrotask(() => relay.settle({ v: 2, type: 'ack', commandId: frame.commandId,
        connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId, status: 'accepted', result: { accepted: true } },
      { deviceId, connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId }))
    } }, now, { connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId })
  }
  const journal = openJournal({ file: join(dir, 'journal.json'), keyFile: join(dir, 'journal.key'), initFile: join(dir, 'journal.init') })
  cleanup.push(() => journal.close())
  const options = { registry, relay, sync: { isSynced: () => true }, store: install.store, journal, file: join(dir, 'rooms.json'), operatorId: install.operatorId, now: () => now }
  let groups = createDiscussions(options); cleanup.push(() => groups.dispose())
  const models = ['dsh', 'codex'].map(agent => ({ id: agent + ':provider:model', agent: agent as 'dsh' | 'codex', provider: 'provider', model: 'model', work: agent === 'codex', reasoningEfforts: ['low', 'high'] }))
  for (const deviceId of ['a', 'b']) groups.acceptCatalog({ deviceId, connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId },
    { v: 2, type: 'discussion.catalog', connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId, models })
  const input = { title: 'PRIVATE TITLE', text: 'SECRET QUESTION', moderator: 1, members: [
    { deviceId: 'a', modelId: models[0]!.id }, { deviceId: 'b', modelId: models[1]!.id }, { deviceId: 'b', modelId: models[0]!.id },
  ] }
  function reply(index: number, text: string, overrides: Record<string, unknown> = {}) {
    const command = sent[index]!; const args = command.args as any; const deviceId = command.target.deviceId
    groups.acceptResult({ deviceId, connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId },
      { v: 2, type: 'discussion.result', connectionId: 'conn-' + deviceId, nodeEpoch: 'epoch-' + deviceId,
        roomId: args.roomId, memberId: args.memberId, turnId: args.turnId, state: 'completed', text,
        checksum: createHash('sha256').update(text).digest('hex'), ...overrides })
  }
  return { get groups() { return groups }, input, sent, reply, registry, relay, dir, options,
    create: () => { const p = groups.preview(input); return groups.create(p.digest, 'create') },
    restart: () => { groups.dispose(); groups = createDiscussions(options) },
    setNow: (value: number) => { now = value },
  }
}

describe('moderated group chat', () => {
  it('copies reusable presets into preview/member snapshots and keeps them independent of later edits/deletions', () => {
    const h=setup(),library=h.groups.presets()!,preset=library.items[0]!
    const p=h.groups.preview({...h.input,members:h.input.members.map(m=>({...m,profile:preset.profile}))})
    h.groups.savePreset({action:'save',id:preset.id,key:'preset-edit',revision:library.revision,name:'renamed',profile:{...preset.profile,persona:'NEW persona'}})
    const room=h.groups.create(p.digest,'from-preset')
    h.groups.savePreset({action:'delete',id:preset.id,key:'preset-delete',revision:library.revision+1})
    expect(h.groups.read(room.id).members.every(m=>m.profile?.persona===preset.profile.persona)).toBe(true)
    expect((h.sent[0]!.args as any).text).toContain(preset.profile.persona)
    expect((h.sent[0]!.args as any).text).not.toContain('NEW persona')
    h.restart();expect(h.groups.presets()!.items.some(p=>p.id===preset.id)).toBe(false)
    expect(h.groups.read(room.id).members[0]!.profile).toEqual(preset.profile)
  })
  it('streams snapshots with identity/sequence checks and reconciles final usage without duplicates', () => {
    const h=setup(),room=h.create(),args=h.sent[0]!.args as any,deviceId=h.sent[0]!.target.deviceId
    const identity={deviceId,connectionId:'conn-'+deviceId,nodeEpoch:'epoch-'+deviceId}
    const progress={v:2 as const,type:'discussion.progress' as const,connectionId:identity.connectionId,nodeEpoch:identity.nodeEpoch,roomId:room.id,memberId:args.memberId,turnId:args.turnId,seq:1,text:'partial',durationMs:100,usage:{inputTokens:10,outputTokens:2,totalTokens:12,durationMs:100}}
    h.groups.acceptProgress({...identity,deviceId:'wrong'},progress)
    expect(h.groups.read(room.id).messages).toHaveLength(1)
    h.groups.acceptProgress(identity,progress)
    h.groups.acceptProgress(identity,{...progress,seq:2,text:'more partial'})
    h.groups.acceptProgress(identity,progress)
    let live=h.groups.read(room.id)
    expect(live.messages.at(-1)).toMatchObject({state:'streaming',text:'more partial'})
    expect(live.usage).toMatchObject({totalTokens:12,pendingCalls:1,partialCalls:0})
    expect(readFileSync(join(h.dir,'rooms.json'),'utf8')).not.toContain('partial')
    const final=JSON.stringify({assignments:[{memberId:room.members[0]!.id,task:'Analyze'}]})
    h.reply(0,final,{usage:{...progress.usage,outputTokens:5,totalTokens:15}})
    h.groups.acceptProgress(identity,{...progress,seq:3,text:'late'})
    live=h.groups.read(room.id)
    expect(live.messages.filter(m=>m.id===args.turnId)).toHaveLength(1)
    expect(live.messages.find(m=>m.id===args.turnId)?.text).toBe(final)
    expect(live.usage.totalTokens).toBe(15)
  })

  it('keeps partial Markdown when a worker fails, but excludes transient text on restart', () => {
    const h=setup(),room=h.create()
    h.reply(0,JSON.stringify({assignments:[{memberId:room.members[0]!.id,task:'Analyze'}]}))
    const args=h.sent[1]!.args as any,deviceId=h.sent[1]!.target.deviceId
    h.groups.acceptProgress({deviceId,connectionId:'conn-'+deviceId,nodeEpoch:'epoch-'+deviceId},{v:2,type:'discussion.progress',connectionId:'conn-'+deviceId,nodeEpoch:'epoch-'+deviceId,roomId:room.id,memberId:args.memberId,turnId:args.turnId,seq:1,text:'## Partial result',durationMs:100})
    h.reply(1,'',{state:'failed',code:'response-incomplete'})
    expect(h.groups.read(room.id).messages.find(m=>m.id===args.turnId)).toMatchObject({text:'## Partial result',state:'failed',error:'response-incomplete',markdown:[{tag:'h2'}]})
    h.restart();expect(h.groups.read(room.id).messages).toEqual([])
  })

  it('binds profiles in previews and prompts and only changes them while idle', () => {
    const h=setup(),profile={persona:'A rigorous engineer',expertise:'expert',stance:'challenge'}
    const p=h.groups.preview({...h.input,members:h.input.members.map(m=>({...m,profile}))}),room=h.groups.create(p.digest,'profiles')
    expect(room.members.every(m=>m.profile?.stance==='challenge')).toBe(true)
    expect((h.sent[0]!.args as any).text).toContain('A rigorous engineer')
    expect((h.sent[0]!.args as any).text).toContain('planning response must remain ONLY')
    expect(()=>h.groups.configure(room.id,room.revision,[])).toThrow('writer-busy')
    h.reply(0,JSON.stringify({assignments:room.members.filter(m=>m.id!==room.moderatorId).map(m=>({memberId:m.id,task:'Analyze'}))}))
    expect((h.sent[1]!.args as any).text).toContain('Challenge: actively test assumptions')
    h.reply(1,'done');h.reply(2,'done');h.reply(3,'summary')
    const idle=h.groups.read(room.id),profiles=idle.members.map(m=>({memberId:m.id,profile:{...profile,stance:'review'}}))
    expect(()=>h.groups.configure(room.id,idle.revision-1,profiles)).toThrow('revision-conflict')
    const saved=h.groups.configure(room.id,idle.revision,profiles)
    h.groups.send(room.id,'next','moderator','next-profile-round')
    expect((h.sent[4]!.args as any).text).toContain('Independently review')
    h.restart();expect(h.groups.read(room.id).members.map(m=>m.profile)).toEqual(saved.members.map(m=>m.profile))
  })
  it('persists exact call totals including moderator stages and never double-counts a replay', () => {
    const h = setup(), room = h.create()
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, durationMs: 2000 }
    const plan = JSON.stringify({ assignments: room.members.filter(m => m.id !== room.moderatorId).map(m => ({ memberId: m.id, task: 'Analyze' })) })
    h.reply(0, plan, { usage }); h.reply(0, plan, { usage })
    h.reply(1, 'partial failure', { state: 'failed', usage })
    h.reply(2, 'legacy peer without usage')
    h.reply(3, 'summary', { usage })
    const result = h.groups.read(room.id)
    expect(result.usage).toMatchObject({ calls: 4, reportedCalls: 3, missingCalls: 1, partialCalls: 1, totalTokens: 360, outputTokens: 60, durationMs: 6000 })
    expect(result.members.find(m => m.id === room.moderatorId)?.usage).toMatchObject({ calls: 2, totalTokens: 240 })
    expect(result.members.reduce((sum,m) => sum + m.usage.totalTokens, 0)).toBe(result.usage.totalTokens)
    h.restart()
    expect(h.groups.read(room.id).usage).toEqual(result.usage)
  })

  it('does not accept usage from a mismatched connection or an invalid sample', () => {
    const h = setup(), room = h.create(), usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, durationMs: 2000 }
    h.reply(0, '{}', { connectionId: 'wrong', usage })
    expect(h.groups.read(room.id).usage.reportedCalls).toBe(0)
    h.reply(0, '{}', { usage: { ...usage, totalTokens: -1 } })
    expect(h.groups.read(room.id).usage).toMatchObject({ reportedCalls: 0, missingCalls: 1 })
  })

  it('binds each reasoning choice and forwards it through planning, work and summary', () => {
    const h = setup()
    const input = { ...h.input, members: h.input.members.map((member, i) => ({ ...member, reasoning: i === 1 ? 'high' : 'low' })) }
    expect(() => h.groups.preview({ ...input, members: input.members.map(m => ({ ...m, reasoning: 'invalid' })) })).toThrow('invalid-args')
    const preview = h.groups.preview(input)
    expect(preview.digest).not.toBe(h.groups.preview(h.input).digest)
    const room = h.groups.create(preview.digest, 'reasoning')
    expect((h.sent[0]!.args as any).reasoning).toBe('high')
    h.reply(0, JSON.stringify({ assignments: room.members.filter(m => m.id !== room.moderatorId).map(m => ({ memberId: m.id, task: 'Analyze' })) }))
    expect(h.sent.slice(1).map(c => (c.args as any).reasoning)).toEqual(['low', 'low'])
    h.reply(1, 'done'); h.reply(2, 'done')
    expect((h.sent[3]!.args as any).reasoning).toBe('high')
  })
  it('binds execution scopes in preview and sends work authority only to the worker stage', () => {
    const h = setup()
    const input = { ...h.input, mode: 'work', moderator: 0, members: [h.input.members[0],
      { deviceId: 'a', modelId: 'codex:provider:model', workspace: '/projects/one' },
      { deviceId: 'b', modelId: 'codex:provider:model', workspace: '/projects/two' }] }
    const preview = h.groups.preview(input)
    expect(preview.mode).toBe('work'); expect(h.sent).toHaveLength(0)
    const room = h.groups.create(preview.digest, 'work-create')
    expect((h.sent[0]!.args as any).work).toBeUndefined()
    h.reply(0, JSON.stringify({ assignments: room.members.slice(1).map(m => ({ memberId: m.id, task: 'Implement and verify' })) }))
    expect((h.sent[1]!.args as any).work).toEqual({ workspace: '/projects/one' })
    expect((h.sent[2]!.args as any).work).toEqual({ workspace: '/projects/two' })
    h.reply(1, 'done one'); h.reply(2, 'done two')
    expect((h.sent[3]!.args as any).work).toBeUndefined()
    expect(h.groups.create(preview.digest, 'work-create').id).toBe(room.id)
    expect(h.sent).toHaveLength(4)
  })
  it('rejects implicit workspaces and non-executing models without making a call', () => {
    const h = setup()
    expect(() => h.groups.preview({ ...h.input, mode: 'work' })).toThrow('invalid-workspace')
    expect(() => h.groups.preview({ ...h.input, mode: 'discussion', members: h.input.members.map(m => ({ ...m, workspace: '/projects/one' })) })).toThrow('invalid-args')
    expect(h.sent).toHaveLength(0)
  })
  it('previews without calls, binds the chosen moderator, then plans → participants → automatic summary', async () => {
    const h = setup(); const preview = h.groups.preview(h.input)
    expect(h.sent).toHaveLength(0); expect(preview.maxCalls).toBe(12)
    const room = h.groups.create(preview.digest, 'create')
    expect(room.moderatorId).toBe(room.members[1]!.id)
    expect(room.phase).toBe('planning'); expect(h.sent[0]!.target.deviceId).toBe('b')
    const assignments = room.members.filter(m => m.id !== room.moderatorId).map(m => ({ memberId: m.id, task: 'Analyze a separate aspect' }))
    h.reply(0, JSON.stringify({ assignments }))
    expect(h.groups.read(room.id).phase).toBe('working'); expect(h.sent).toHaveLength(3)
    h.reply(1, 'FIRST MEMBER RESULT'); expect(h.sent).toHaveLength(3)
    h.reply(2, 'SECOND MEMBER RESULT'); expect(h.sent).toHaveLength(4)
    const summary = h.sent[3]!.args as any
    expect(summary.text).toContain('FIRST MEMBER RESULT'); expect(summary.text).toContain('SECOND MEMBER RESULT')
    expect(h.groups.read(room.id).phase).toBe('summarizing')
    h.reply(3, 'FINAL CONCLUSION')
    expect(h.groups.read(room.id)).toMatchObject({ state: 'idle', phase: null, rounds: 1 })
    expect(h.groups.read(room.id).messages.at(-1)?.text).toBe('FINAL CONCLUSION')
    const disk = readFileSync(join(h.dir, 'rooms.json'), 'utf8') + readFileSync(join(h.dir, 'journal.json'), 'utf8')
    for (const value of ['SECRET QUESTION', 'PRIVATE TITLE', 'FIRST MEMBER RESULT', 'FINAL CONCLUSION']) expect(disk).not.toContain(value)
    expect(h.relay.historyRead(h.relay.historyCursor()).events).toEqual([])
  })
  it('duplicates never launch extra calls; changed payload conflicts; restart never resumes', () => {
    const h = setup(); const preview = h.groups.preview(h.input); const room = h.groups.create(preview.digest, 'create')
    expect(h.groups.create(preview.digest, 'create').id).toBe(room.id); expect(h.sent).toHaveLength(1)
    expect(() => h.groups.create('different', 'create')).toThrow('idempotency-conflict')
    h.restart()
    expect(h.groups.create(preview.digest, 'create')).toMatchObject({ id: room.id, state: 'unknown', cleared: true, messages: [] })
    expect(h.sent).toHaveLength(1)
  })
  it('rejects stale preview policies and unapproved member identities before inference', () => {
    const h = setup(); const p = h.groups.preview(h.input)
    h.options.store.setPolicy('a', { allowDiscussion: false })
    expect(() => h.groups.create(p.digest, 'create')).toThrow('revision-conflict')
    expect(h.sent).toHaveLength(0)
    expect(() => h.groups.preview({ ...h.input, moderator: 3 })).toThrow('invalid-args')
  })
  it('rejects forged, duplicate and oversized plans without invoking members', () => {
    const h = setup(); const room = h.create()
    h.reply(0, JSON.stringify({ assignments: [{ memberId: 'foreign', task: 'run something' }] }))
    expect(h.sent).toHaveLength(1); expect(h.groups.read(room.id).messages.at(-1)?.text).toBe('invalid-plan')
    expect(() => parseAssignments('{"assignments":[{"memberId":"a","task":"x"},{"memberId":"a","task":"y"}]}', ['a'])).toThrow('invalid-plan')
  })
  it('bad result checksum pauses, and results from an old epoch are ignored', () => {
    const h = setup(); const room = h.create()
    h.reply(0, '{}', { nodeEpoch: 'old' }); expect(h.groups.read(room.id).state).toBe('running')
    h.reply(0, '{}', { checksum: '0'.repeat(64) }); expect(h.groups.read(room.id).state).toBe('unknown')
    expect(h.sent).toHaveLength(1)
  })
  it('stopping planning prevents subsequent assignment even if a late result completes', async () => {
    const h = setup(); const room = h.create(); await h.groups.stop(room.id)
    expect(h.sent[1]!.op).toBe('discussion.stop')
    h.reply(0, JSON.stringify({ assignments: [{ memberId: room.members[0]!.id, task: 'analysis' }] }))
    expect(h.groups.read(room.id).state).toBe('closed'); expect(h.sent).toHaveLength(2)
  })
  it('expiration clears body and sends stop; policy invalidation clears every shared copy', () => {
    const h = setup(); const room = h.create(); h.setNow(room.expiresAt)
    expect(h.groups.read(room.id)).toMatchObject({ cleared: true, messages: [] })
    expect(h.sent[1]!.op).toBe('discussion.stop')
    h.reply(0, 'LATE BODY'); expect(h.groups.read(room.id).messages).toEqual([])
    h.groups.invalidate('a'); expect(h.groups.read(room.id).state).toBe('unknown')
  })
  it('bounds follow-up rounds and keeps send retries idempotent', () => {
    const h = setup(); const room = h.create()
    for (let round = 1; round <= 3; round++) {
      const offset = h.sent.length - 1
      h.reply(offset, JSON.stringify({ assignments: [{ memberId: room.members[0]!.id, task: 'Analyze' }] }))
      h.reply(offset + 1, 'analysis'); h.reply(offset + 2, 'summary')
      if (round < 3) {
        h.groups.send(room.id, 'follow up ' + round, 'moderator', 'follow-' + round)
        const count = h.sent.length
        h.groups.send(room.id, 'follow up ' + round, 'moderator', 'follow-' + round)
        expect(h.sent).toHaveLength(count)
        expect(() => h.groups.send(room.id, 'different', 'moderator', 'follow-' + round)).toThrow('idempotency-conflict')
      }
    }
    expect(() => h.groups.send(room.id, 'fourth', 'moderator', 'fourth')).toThrow('size-limit')
    expect(h.sent).toHaveLength(9)
  })
  it('requires browser authentication and CSRF for the dedicated group API', async () => {
    const h = setup(); const web = createMemoryWeb(); const token = '0123456789abcdef0123456789abcdef'; const origin = 'https://marshal.example'
    const routes = registerMarshalRoutes({ webServer: web.webServer, registry: h.registry, relay: h.relay,
      discussions: h.groups, requireToken: token, publicOrigin: origin, operatorId: h.options.operatorId, loginFailureDelayMs: 0 })
    cleanup.push(routes.dispose)
    expect((await web.request('/marshal/api/discussions', { headers: { 'x-marshal-token': token } })).statusCode).toBe(401)
    const login = await web.request('/marshal/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    const csrf = login.cookie(CSRF_COOKIE)!; const cookie = `${SESSION_COOKIE}=${login.cookie(SESSION_COOKIE)}; ${CSRF_COOKIE}=${csrf}`
    const body = JSON.stringify({ action: 'preview', input: h.input })
    expect((await web.request('/marshal/api/discussions', { method: 'POST', headers: { cookie, origin }, body })).statusCode).toBe(403)
    const response = await web.request('/marshal/api/discussions', { method: 'POST', headers: { cookie, origin, 'x-marshal-csrf': csrf, 'content-type': 'application/json' }, body })
    expect(response.statusCode).toBe(200); expect(h.sent).toHaveLength(0)
    const preset=h.groups.presets()!.items[0]!
    const presetBody=JSON.stringify({action:'preset',input:{action:'save',id:preset.id,key:'rename-preset',revision:0,name:'Shared reviewer',profile:preset.profile}})
    expect((await web.request('/marshal/api/discussions',{method:'POST',headers:{'x-marshal-token':token,'content-type':'application/json'},body:presetBody})).statusCode).toBe(401)
    expect((await web.request('/marshal/api/discussions',{method:'POST',headers:{cookie,origin},body:presetBody})).statusCode).toBe(403)
    expect((await web.request('/marshal/api/discussions',{method:'POST',headers:{cookie,origin,'x-marshal-csrf':csrf,'content-type':'application/json'},body:presetBody})).statusCode).toBe(200)
    expect(h.groups.presets()!.items[0]!.name).toBe('Shared reviewer')
    const bypass = await web.request('/marshal/api/command', { method: 'POST', headers: { 'x-marshal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'discussion.turn', target: { deviceId: 'a', agent: 'dsh', sessionId: 'fake' }, args: {}, idempotencyKey: 'bypass' }) })
    expect(bypass.statusCode).toBe(400); expect(h.sent).toHaveLength(0)
  })
})
