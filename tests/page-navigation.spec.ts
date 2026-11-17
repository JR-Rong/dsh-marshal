import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { PAGE_HTML } from '../src/hub/page.ts'

class Element {
  private text = ''
  className = ''
  hidden = false
  disabled = false
  type = ''
  open = false
  title = ''
  value = ''
  children: Element[] = []
  get textContent() { return this.text }
  set textContent(value: string) { this.text = value; this.children = [] }
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  onclick?: () => Promise<void> | void
  constructor(readonly tagName = 'div') {}
  append(...nodes: Element[]) { this.children.push(...nodes) }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  focus() {}
  get classList() {
    return {
      add: (name: string) => { this.className += ' ' + name },
      toggle: (name: string, on: boolean) => {
        const rest = this.className.split(' ').filter(part => part && part !== name)
        this.className = [...rest, ...(on ? [name] : [])].join(' ')
      },
    }
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...((selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
}

function page() {
  const nodes = new Map<string, Element>()
  const element = (id: string) => {
    if (!nodes.has(id)) {
      const node = new Element()
      if (id === 'send') node.append(new Element('button'))
      nodes.set(id, node)
    }
    return nodes.get(id)!
  }
  const commands: string[] = []
  const fixture = { deviceId: 'mac', agent: 'codex', sessionId: 'session-1234', title: '修复会话发送', updatedAt: 1000, running: false,
    capability: { ownership: 'ours', operations: ['prompt', 'observe'], tunables: [], runtimeEpoch: 'epoch', settingsRevision: 1 } }
  const browser = {
    document: { getElementById: element, createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }), cookie: '' },
    location: { origin: 'https://marshal.example' }, window: { addEventListener() {} }, setInterval() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, options?: { body?: string }) => {
      if (url.includes('/api/session') && !url.includes('/api/sessions')) return { ok: false, status: 401 }
      if (url.includes('/api/sessions')) return { ok: true, json: async () => ({ sessions: [fixture] }) }
      if (url.includes('/api/inputs')) return { ok: true, json: async () => ({ cards: [] }) }
      if (url.includes('/api/command')) { commands.push(JSON.parse(options?.body ?? '{}').op); return { ok: true, json: async () => ({ ok: true, result: { subscriptionId: 'sub' } }) } }
      return { ok: true, json: async () => ({ devices: [{ id: 'mac', name: 'Mac', agents: ['codex'], online: true }] }) }
    },
  }
  const script = PAGE_HTML.split('<script>')[1]!.split('</script>')[0]!
  runInNewContext(script.replace('restore();', ''), browser)
  const run = (script: string) => runInNewContext(script, browser)
  return { browser, element, commands, run,
    event: (kind: string, seq: number, extra: Record<string, unknown> = {}) => run(`onEvent(${JSON.stringify({
      deviceId: 'mac', agent: 'codex', sessionId: 'session-1234', kind, seq, ts: 1000, payload: {}, ...extra,
    })})`),
  }
}

async function selectedPage() {
  const context = page()
  await context.run('refreshDevices()')
  context.run('barrierBlocked = false')
  await context.run("loadSessions('mac','codex',{id:'mac',name:'Mac'})")
  const selected = context.element('sessions').querySelectorAll('.row')[0]!
  await selected.onclick!()
  return { ...context, selected, send: context.element('send').querySelector('button')! }
}

describe('page navigation behavior', () => {
  it('first send acquires the original session, waits for source confirmation, then sends exactly once', async () => {
    const { run, element } = await selectedPage()
    run(`applyCapabilityDocument({ownership:'foreign-unknown',operations:['acquire'],tunables:[]});
      var sentOps = []; persistIntent = async () => true; updateIntent = async () => {}; reconcilePending = () => {};
      command = async (op) => { sentOps.push(op); return {ok:true,status:'confirmed'}; };
      refreshCurrentCapability = async () => applyCapabilityDocument({ownership:'attached',operations:['prompt'],tunables:[]});`)
    element('text').value = 'Continue the original context'
    await run('sendForm.onsubmit({preventDefault(){}})')
    expect(run('sentOps')).toEqual(['acquire', 'prompt'])
    expect(element('text').value).toBe('')
    expect(element('log').querySelector('p')?.textContent).toBe('Continue the original context')
  })
  it('unconfirmed acquisition keeps the draft and never submits the prompt', async () => {
    const { run, element } = await selectedPage()
    run(`applyCapabilityDocument({ownership:'foreign-unknown',operations:['acquire'],tunables:[]});
      var sentOps = []; persistIntent = async () => true; updateIntent = async () => {};
      command = async (op) => { sentOps.push(op); return null; }; refreshCurrentCapability = async () => {};`)
    element('text').value = 'Keep my message'
    await run('sendForm.onsubmit({preventDefault(){}})')
    expect(run('sentOps')).toEqual(['acquire'])
    expect(element('text').value).toBe('Keep my message')
  })
  it('streamed text stays in one bubble and selection resets its in-memory buffer', async () => {
    const { event, element, run } = await selectedPage()
    event('message.delta', 1, { payload: { itemId: 'reply', text: 'Hello ' } })
    event('message.delta', 2, { payload: { itemId: 'reply', text: 'world' } })
    expect(element('log').children).toHaveLength(1)
    expect(element('log').querySelector('p')?.textContent).toBe('Hello world')
    run('clearNode(log)')
    event('message.delta', 3, { payload: { itemId: 'reply', text: 'new view' } })
    expect(element('log').querySelector('p')?.textContent).toBe('new view')
  })
  it('a reconnect preserves displayed messages only with the same authoritative content generation', async () => {
    const { run, event, element } = await selectedPage()
    const reset = { complete: true, hubEpoch: 'hub-1', continuity: { mac: { nodeEpoch: 'node-1', purge: 0 } } }
    await run(`onReset(${JSON.stringify(reset)})`)
    event('message.delta', 1, { payload: { itemId: 'reply', text: 'Keep this reply' } })
    await run(`onReset(${JSON.stringify(reset)})`)
    expect(element('log').querySelector('p')?.textContent).toBe('Keep this reply')
    event('message.delta', 1, { payload: { itemId: 'reply', text: 'duplicate' } })
    expect(element('log').querySelector('p')?.textContent).toBe('Keep this reply')
    reset.continuity.mac.purge++
    await run(`onReset(${JSON.stringify(reset)})`)
    expect(element('log').children).toHaveLength(0)
  })
  it('设备和会话使用语义按钮，切换会话列表不会覆盖事件区', async () => {
    const { run, element, commands } = page()
    await run('refreshDevices()')
    const agent = element('devices').querySelectorAll('.row')[0]!
    expect(agent.tagName).toBe('button')
    expect(agent.attributes['aria-label']).toBe('Mac · Codex')
    await run("loadSessions('mac','codex',{id:'mac',name:'Mac'})")
    const session = element('sessions').querySelectorAll('.row')[0]!
    expect(session.tagName).toBe('button')
    expect(element('log').children).toHaveLength(0)
    await session.onclick!()
    expect(element('sessionTitle').textContent).toBe('修复会话发送')
    expect(commands).toEqual(['observe'])
    run("onEvent({deviceId:'mac',agent:'codex',sessionId:'session-1234',seq:1,ts:1000,kind:'turn.completed',payload:{state:'completed'}})")
    expect(element('log').children).toHaveLength(1)
    expect(element('sessions').querySelectorAll('.row')).toHaveLength(1)
    expect(session.attributes['aria-pressed']).toBe('true')
  })

  it('新发现的会话没有单独能力时展示源端 agent 能力，不显示假未知', async () => {
    const { run, element, send } = await selectedPage()
    await run(`request = async () => ({ok:true,json:async()=>({sessions:[{deviceId:'mac',agent:'codex',sessionId:'session-1234',running:false}]})});
      devicesData.devices[0].capabilities = {codex:{ownership:'attached',operations:['prompt'],tunables:[]}};
      refreshCurrentCapability()`)
    expect(send.disabled).toBe(false)
    expect(element('capability').querySelector('span')?.textContent).toBe('所有权：已连接原生会话')
    expect(run("shortSessionId('session-abcdef12-3456')")).toBe('abcdef12')
  })

  it('未变化的设备轮询保留已有按钮，避免丢失键盘焦点', async () => {
    const { run, element } = page()
    await run('refreshDevices()')
    const first = element('devices').children[0]
    await run('refreshDevices()')
    expect(element('devices').children[0]).toBe(first)
  })

  it('回合事件立即更新发送状态和原有选中行，重复或乱序事件不能回退状态', async () => {
    const { event, element, run, selected, send } = await selectedPage()
    const indicator = selected.querySelector('.dot')!
    const label = selected.querySelector('.session-state')!
    expect(send.disabled).toBe(false)
    event('turn.started', 2)
    expect(send.disabled).toBe(true)
    expect(element('text').disabled).toBe(true)
    expect(run('currentRow.running')).toBe(true)
    expect(label.textContent).toBe('运行中')
    expect(indicator.className.split(' ')).toContain('running')

    event('turn.completed', 2)
    event('turn.completed', 1)
    expect(send.disabled).toBe(true)
    expect(element('log').children).toHaveLength(1)
    event('turn.completed', 3)
    expect(send.disabled).toBe(false)
    expect(element('text').disabled).toBe(false)
    expect(run('currentRow.running')).toBe(false)
    expect(label.textContent).toBe('空闲')
    expect(indicator.className.split(' ')).not.toContain('running')
    expect(element('sessions').querySelectorAll('.row')).toEqual([selected])
    expect(selected.querySelector('.dot')).toBe(indicator)
    expect(selected.querySelector('.session-state')).toBe(label)
    expect(selected.attributes['aria-pressed']).toBe('true')
  })

  it('其他设备、智能体、会话的事件及无序号事件不改变当前运行状态', async () => {
    const { event, element, send } = await selectedPage()
    const otherTargets = [{ deviceId: 'other-mac' }, { agent: 'claude' }, { sessionId: 'other-session' }]
    for (const other of otherTargets) event('turn.started', 100, other)
    event('turn.started', 100, { seq: undefined })
    expect(send.disabled).toBe(false)
    expect(element('log').children).toHaveLength(0)
    event('turn.started', 1)
    for (const other of otherTargets) event('turn.completed', 100, other)
    expect(send.disabled).toBe(true)
    event('turn.completed', 2)
    expect(send.disabled).toBe(false)
    expect(element('log').children).toHaveLength(2)
  })

  it.each([
    ['未取得写权', "currentCapability.ownership = 'foreign-unknown'", '所有权未确认'],
    ['未验证写权', "currentCapability.ownership = 'unverified'", '写权未确认'],
    ['屏障未完成', 'barrierBlocked = true', '状态未知'],
  ])('回合完成不会绕过%s', async (_label, constraint, reason) => {
    const { event, element, run, selected, send } = await selectedPage()
    event('turn.started', 1)
    run(constraint)
    event('turn.completed', 2)
    expect(run('currentRow.running')).toBe(false)
    expect(selected.querySelector('.session-state')!.textContent).toBe('空闲')
    expect(send.disabled).toBe(true)
    expect(element('text').disabled).toBe(true)
    expect(element('status').textContent).toContain(reason)
  })

  it('历史会话选择不接管，首条消息提供显式接管并发送入口', async () => {
    const { run, element, event, send, commands } = await selectedPage()
    run("applyCapabilityDocument({ownership:'foreign-unknown',operations:['acquire'],tunables:[]})")
    expect(run('acquireEligible()')).toBe(true)
    expect(send.disabled).toBe(false)
    expect(send.textContent).toBe('接管并发送')
    const acquire = element('capability').querySelectorAll('button').find(button => button.textContent === '接管并继续')
    expect(acquire).toBeDefined()
    expect(commands).toEqual(['observe'])
    event('capability.changed', 1, { payload: { ownership: 'attached', operations: ['prompt', 'acquire'], tunables: [] } })
    expect(send.disabled).toBe(false)
    expect(element('text').disabled).toBe(false)
    expect(run('acquireEligible()')).toBe(false)
  })

  it('DSH 的原生宿主控制可继续发送，忙碌和同步屏障仍禁用', async () => {
    const { run, send } = await selectedPage()
    run("current.agent = 'dsh'; currentRow.agent = 'dsh'; applyCapabilityDocument({ownership:'attached',operations:['prompt'],tunables:[]})")
    expect(send.disabled).toBe(false)
    run('currentRow.running = true; evaluateCurrentWriteState()')
    expect(send.disabled).toBe(true)
    run('currentRow.running = false; barrierBlocked = true; evaluateCurrentWriteState()')
    expect(send.disabled).toBe(true)
  })

  it('运行中会话和同步未完成时不能发起接管', async () => {
    const { run } = await selectedPage()
    run("applyCapabilityDocument({ownership:'foreign-unknown',operations:['acquire'],tunables:[]})")
    expect(run('acquireEligible()')).toBe(true)
    run('currentRow.running = true')
    expect(run('acquireEligible()')).toBe(false)
    run('currentRow.running = false; barrierBlocked = true')
    expect(run('acquireEligible()')).toBe(false)
  })

  it('metadata 增量没有正文时显示提示，不创建空白消息或推测正文', async () => {
    const { event, element } = await selectedPage()
    event('message.delta', 1, { payload: { itemId: 'reply', chars: 8 } })
    event('reasoning.delta', 2, { payload: { itemId: 'reason', chars: 13 } })
    event('message.delta', 3, { payload: { redacted: true, chars: 4, text: '不应显示' } })
    event('message.delta', 4, { payload: { text: '已授权正文' } })
    const messages = element('log').children.map(entry => entry.children.at(-1)!.querySelector('p')!.textContent)
    expect(messages).toEqual([
      '回复更新（8字，正文未同步）', '思考更新（13字，正文未同步）',
      '回复更新（4字，正文未同步）', '已授权正文',
    ])
  })
})
