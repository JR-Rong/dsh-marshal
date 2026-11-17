import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscussionPort } from '../src/discussions/types.ts'
import { createDiscussionPort, type DiscussionLlm } from '../src/discussions/ports.ts'
import { createNodeDiscussions } from '../src/discussions/node.ts'
import { openJournal } from '../src/node/journal.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import type { NodeLink } from '../src/node/link.ts'
import type { Adapter } from '../src/adapters/types.ts'
import type { CommandFrame } from '../src/wire/frames.ts'

const clean: Array<() => void> = []
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn() })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const model = { id: 'dsh:provider:model', agent: 'dsh' as const, model: 'model', provider: 'provider' }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-discussion-node-')); clean.push(() => rmSync(dir, { recursive: true, force: true }))
  const journal = openJournal({ file: join(dir, 'journal.json'), keyFile: join(dir, 'journal.key') }); clean.push(() => journal.close())
  const binding = { operatorId: 'operator', policyRevision: 2, policies: { allowDiscussion: true, allowContent: false, allowInteractions: false } }
  const controls: any[] = []; const ordinary: any[] = []
  const link = { binding, handshake: { connectionId: 'conn', nodeEpoch: 'epoch', serverTimeOffset: 0 }, online: true,
    sendControl(text: string) { controls.push(JSON.parse(text)) }, sendRaw(text: string) { ordinary.push(JSON.parse(text)) } } as unknown as NodeLink
  const run = vi.fn<DiscussionPort['run']>(async () => 'PRIVATE REPLY')
  const node = createNodeDiscussions({ port: { catalog: async () => [model], run, dispose() {} }, journal, link: () => link, enabled: true, now: () => 1000 })
  clean.push(() => node.dispose())
  const adapter = { agent: 'dsh', execute: vi.fn() } as unknown as Adapter
  const follower = createFollower({ adapter, send() {}, logger: { warn() {} } }); clean.push(() => follower.stopAll())
  const frame: CommandFrame = { v: 2, type: 'command', commandId: 'cmd', idempotencyKey: 'key', operatorId: 'operator',
    target: { deviceId: 'mac', agent: 'dsh', sessionId: 'room' }, op: 'discussion.turn',
    args: { roomId: 'room', memberId: 'member', turnId: 'turn', modelId: model.id, text: 'PRIVATE QUESTION', expiresAt: 121000, policyRevision: 2 },
    issuedAt: 1000, deadline: 121000, connectionId: 'conn', nodeEpoch: 'epoch' }
  return { node, link, binding, run, controls, ordinary, frame, journal, dir, execute(f = frame) {
    runCommand(link, adapter, follower, f, 'mac', journal, () => 1000, { discussion: node.execute,
      projector: () => createPrivacyProjector({ privacy: 'metadata', allowContent: false, questionRelay: 'off', approvalRelay: 'off', allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'dsh' }) })
  } }
}

describe('discussion isolated node', () => {
  it('takes the last DSH usage snapshot and retains consumed tokens on incomplete output', async () => {
    const onUsage = vi.fn()
    const llm: DiscussionLlm = { listProviders: () => [{id:'provider'}], listModels: async () => [{id:'model'}],
      prepareCall: async config => ({ config, stream: async function* () {
        yield { type:'usage', usage:{inputTokens:1,outputTokens:1} }
        yield { type:'text-delta', text:'partial' }
        yield { type:'usage', usage:{inputTokens:100,cacheReadTokens:50,outputTokens:20} }
        yield { type:'finish', reason:{kind:'length'} }
      } }) }
    const port=createDiscussionPort({llm,codexExecutable:'/missing'}); clean.push(()=>port.dispose()); await port.catalog()
    await expect(port.run(model,'question',new AbortController().signal,undefined,undefined,onUsage)).rejects.toMatchObject({code:'response-incomplete'})
    expect(onUsage).toHaveBeenCalledOnce()
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({inputTokens:150,outputTokens:20,totalTokens:170})
  })

  it('emits DSH partial text and real usage before the stream finishes', async () => {
    const progress: any[] = []
    const llm: DiscussionLlm = { listProviders: () => [{id:'provider'}], listModels: async () => [{id:'model'}],
      prepareCall: async config => ({ config, stream: async function* () {
        yield {type:'text-delta',text:'## Title\n'}
        expect(progress.at(-1)?.text).toBe('## Title\n')
        yield {type:'usage',usage:{inputTokens:10,outputTokens:3}}
        expect(progress.at(-1)?.usage.totalTokens).toBe(13)
        yield {type:'text-delta',text:'**body**'}
        yield {type:'finish',reason:{kind:'stop'}}
      } }) }
    const port=createDiscussionPort({llm,codexExecutable:'/missing'}); clean.push(()=>port.dispose());await port.catalog()
    expect(await port.run(model,'q',new AbortController().signal,undefined,undefined,undefined,p=>progress.push(p))).toBe('## Title\n**body**')
    expect(progress).toHaveLength(3)
  })

  it('throttles full snapshots, finalizes once and never journals intermediate content', async () => {
    const h=setup(); let finish!:()=>void
    Object.defineProperty(h.link,'handshake',{get:()=>({connectionId:'conn',nodeEpoch:'epoch',serverTimeOffset:0})})
    h.run.mockImplementation(async (_m,_t,_s,_w,_r,_u,progress)=>{
      progress?.({text:'PRIVATE partial',durationMs:1})
      progress?.({text:'PRIVATE complete',durationMs:2})
      await new Promise<void>(resolve=>{finish=resolve});return 'PRIVATE complete'
    })
    await h.node.announce();h.execute();await tick()
    expect(h.controls.filter(c=>c.type==='discussion.progress')).toMatchObject([{seq:1,text:'PRIVATE partial'}])
    expect(h.controls.some(c=>c.type==='discussion.result')).toBe(false)
    finish();await tick()
    expect(h.controls.filter(c=>c.type==='discussion.progress')).toMatchObject([{seq:1},{seq:2,text:'PRIVATE complete'}])
    expect(h.controls.at(-1)).toMatchObject({type:'discussion.result',text:'PRIVATE complete'})
    expect(readFileSync(join(h.dir,'journal.json'),'utf8')).not.toContain('PRIVATE')
    expect(JSON.stringify(h.ordinary)).not.toContain('PRIVATE')
  })

  it('sends failed-call usage only over the authenticated discussion result channel', async () => {
    const h=setup(); const usage={inputTokens:100,outputTokens:20,totalTokens:120,durationMs:2000}
    h.run.mockImplementation(async (_m,_t,_s,_w,_r,onUsage)=>{onUsage?.(usage);throw Error('failed')})
    await h.node.announce(); h.execute(); await tick()
    expect(h.controls.at(-1)).toMatchObject({type:'discussion.result',state:'failed',usage})
    expect(JSON.stringify(h.ordinary)).not.toContain('totalTokens')
    expect(readFileSync(join(h.dir,'journal.json'),'utf8')).not.toContain('totalTokens')
  })

  it('uses verified DSH reasoning levels and rejects silently substituted effort', async () => {
    const prepareCall = vi.fn<DiscussionLlm['prepareCall']>(async config => ({ config, stream: async function* () { yield { type: 'text-delta', text: 'done' }; yield { type: 'finish', reason: { kind: 'stop' } } } }))
    const llm: DiscussionLlm = { listProviders: () => [{ id: 'provider' }], listModels: async () => [{ id: 'model' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }), prepareCall }
    const port = createDiscussionPort({ llm, codexExecutable: '/missing' }); clean.push(() => port.dispose())
    expect((await port.catalog())[0]?.reasoningEfforts).toEqual(['high'])
    await expect(port.run(model, 'question', new AbortController().signal, undefined, 'invalid')).rejects.toMatchObject({ code: 'invalid-args' })
    expect(prepareCall).not.toHaveBeenCalled()
    await expect(port.run(model, 'question', new AbortController().signal, undefined, 'high')).resolves.toBe('done')
    expect(prepareCall.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort: 'high' })
    prepareCall.mockImplementationOnce(async config => ({ config: { ...config, reasoningEffort: 'low' }, stream: async function* () {} }))
    await expect(port.run(model, 'question', new AbortController().signal, undefined, 'high')).rejects.toMatchObject({ code: 'revision-conflict' })
  })
  it('deduplicates through the ordinary journal but sends text only via its dedicated channel', async () => {
    const h = setup(); await h.node.announce(); h.execute(); await tick(); h.execute(); await tick()
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.controls.at(-1)).toMatchObject({ type: 'discussion.result', state: 'completed', text: 'PRIVATE REPLY' })
    expect(h.ordinary.every(frame => frame.type === 'ack')).toBe(true)
    expect(JSON.stringify(h.ordinary)).not.toContain('PRIVATE')
    expect(readFileSync(join(h.dir, 'journal.json'), 'utf8')).not.toContain('PRIVATE')
    expect(h.journal.lookup({ operatorId: 'operator', target: h.frame.target, idempotencyKey: 'key' })?.status).toBe('confirmed')
  })
  it('denies expired and disabled calls before running a model', async () => {
    const h = setup(); await h.node.announce(); const args = h.frame.args as any
    await expect(h.node.execute(h.frame, { ...args, expiresAt: 999 })).rejects.toMatchObject({ code: 'expired' })
    h.binding.policies.allowDiscussion = false
    await expect(h.node.execute(h.frame, args)).rejects.toMatchObject({ code: 'unsupported' })
    expect(h.run).not.toHaveBeenCalled()
  })
  it('aborts on disconnect and does not put a completed body into the offline channel', async () => {
    const h = setup(); let signal!: AbortSignal
    h.run.mockImplementation(async (_m, _t, s) => { signal = s; await new Promise(resolve => s.addEventListener('abort', resolve)); throw new Error('stopped') })
    await h.node.announce(); h.execute(); await tick(); h.binding.policies.allowDiscussion = false; h.node.invalidate(); await tick()
    expect(signal.aborted).toBe(true); expect(h.controls.filter(f => f.type === 'discussion.result')).toEqual([])
  })
  it('uses a one-shot DSH model call with no tools or prior workspace messages', async () => {
    let received: any
    const llm: DiscussionLlm = { listProviders: () => [{ id: 'provider' }], listModels: async () => [{ id: 'model' }],
      prepareCall: async config => ({ config, stream: async function* (options) {
        received = options; yield { type: 'text-delta', text: 'reply' }; yield { type: 'finish', reason: { kind: 'stop' } }
      } }) }
    const p = createDiscussionPort({ llm, codexExecutable: '/missing' }); clean.push(() => p.dispose())
    await p.catalog(); expect(await p.run(model, 'question', new AbortController().signal)).toBe('reply')
    expect(received.tools).toEqual([]); expect(received.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'question' }] }])
  })
  it('rejects provider model substitution and tool-call output', async () => {
    const llm: DiscussionLlm = { listProviders: () => [{ id: 'provider' }], listModels: async () => [{ id: 'model' }],
      prepareCall: async config => ({ config, stream: async function* () { yield { type: 'block-start', block: { type: 'tool-call' } } } }) }
    const p = createDiscussionPort({ llm, codexExecutable: '/missing' }); clean.push(() => p.dispose()); await p.catalog()
    await expect(p.run(model, 'question', new AbortController().signal)).rejects.toMatchObject({ code: 'isolation-violation' })
    llm.prepareCall = async config => ({ config: { ...config, model: 'different' }, stream: async function* () {} })
    await expect(p.run(model, 'question', new AbortController().signal)).rejects.toMatchObject({ code: 'revision-conflict' })
  })
})
