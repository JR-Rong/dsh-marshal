import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from '../src/hub/page.ts'

/**
 * V1-T09c 页面契约：这些断言只检查静态模板结构，不起 DOM。
 * 真正的交互行为由后续浏览器/集成回归验证，这里确保关键分支和禁用路径没有被改回去。
 */
describe('page v1 capability flow', () => {
  it('选择会话仍只 observe，显式 acquire 必须走能力声明', () => {
    expect(PAGE_HTML).toContain("command('observe', { kind: 'follow', action: 'subscribe' }")
    // 取得写权是单独的显式命令，空参数对象，仍带完整 target 与幂等键。
    expect(PAGE_HTML).toContain("command('acquire', {}, target, false, key)")
    expect(PAGE_HTML).toContain("operations.indexOf('acquire') >= 0")
    expect(PAGE_HTML).toContain("currentCapability.ownership !== 'foreign-unknown'")
    expect(PAGE_HTML).toContain('取得写权')
    // acquire 资格还要看屏障、设备同步/过期与未知设备。
    expect(PAGE_HTML).toContain('acquireEligible')
    expect(PAGE_HTML).toContain("device.syncing === true || device.stale === true")
    expect(PAGE_HTML).toContain('barrierBlocked || unknownDevices[current.deviceId]')
    // 不乐观改 ownership/writeState：只显示受理结果，等事件或刷新。
    expect(PAGE_HTML).not.toContain('currentCapability.ownership =')
    expect(PAGE_HTML).not.toContain('ours-idle')
  })

  it('未接管有明确入口，已连接原生会话可写', () => {
    expect(PAGE_HTML).toContain('写权未确认（ownership-unverified）')
    expect(PAGE_HTML).toContain('首次发送将自动接管并继续原会话')
    expect(PAGE_HTML).toContain('外部写者运行中')
    expect(PAGE_HTML).toContain("caps.ownership !== 'ours'")
    expect(PAGE_HTML).toContain("operations.indexOf('prompt') < 0")
    // evaluateWriteState 接收当前能力文档，并优先于设备级兜底。
    expect(PAGE_HTML).toContain('function evaluateWriteState(device, row, capability)')
    expect(PAGE_HTML).toContain('capability && typeof capability === \'object\' ? capability : capabilitiesOf(device, row.agent)')
  })

  it('configure 用 runtimeEpoch#settingsRevision，且不回写 current', () => {
    expect(PAGE_HTML).toContain("capability.runtimeEpoch + '#' + capability.settingsRevision")
    expect(PAGE_HTML).toContain("command('configure', { expectedRevision: expectedRevision, field: tunable.id, value }")
    expect(PAGE_HTML).toContain('runtimeEpoch')
    expect(PAGE_HTML).toContain('settingsRevision')
    expect(PAGE_HTML).toContain('Number.isInteger(capability.settingsRevision)')
    expect(PAGE_HTML).toContain('实例代次未知，不能配置')
    expect(PAGE_HTML).toContain('pending')
    expect(PAGE_HTML).toContain('回读确认中')
    expect(PAGE_HTML).toContain('回读超时（未自动重试）')
    expect(PAGE_HTML).toContain('回读未确认，不自动重试')
    expect(PAGE_HTML).toContain('已受理，等待源端回读')
    // 提交值不得写回展示值；current 只来自新的服务端能力文档。
    // 用正则排除赋值，避免把 `tunable.current === ...` 这种只读比较误判为写回。
    expect(PAGE_HTML).not.toMatch(/tunable\.current\s*=(?!=)/)
    // 没有超时自动重发路径。
    expect(PAGE_HTML).not.toContain('setTimeout(function() { configureTunable')
  })

  it('能力面板呈现 ownership、代次、修订、pending 与不可编辑原因', () => {
    expect(PAGE_HTML).toContain('id="capability"')
    expect(PAGE_HTML).toContain('function renderCapability')
    expect(PAGE_HTML).toContain('function renderTunable(capability, tunable, container)')
    expect(PAGE_HTML).toContain("'所有权：'")
    expect(PAGE_HTML).toContain("'实例代次：'")
    expect(PAGE_HTML).toContain("'设置修订：'")
    expect(PAGE_HTML).toContain("'待回读：'")
    expect(PAGE_HTML).toContain("tunable.editable !== true")
    expect(PAGE_HTML).toContain("typeof tunable.reason === 'string'")
    expect(PAGE_HTML).toContain("tunable.id === 'goal'")
    expect(PAGE_HTML).toContain('document.createElement(\'select\')')
    // 能力变化只从服务端文档重渲染。
    expect(PAGE_HTML).toContain("event.kind === 'capability.changed'")
    expect(PAGE_HTML).toContain('function applyCapabilityDocument')
    expect(PAGE_HTML).toContain('function refreshCurrentCapability')
  })

  it('审批卡只渲染单次决定，过滤 always/session 语义', () => {
    expect(PAGE_HTML).toContain('function decisionIsSafe')
    expect(PAGE_HTML).toContain('decisions = raw.filter(decisionIsSafe)')
    expect(PAGE_HTML).toContain('card.approval.action')
    expect(PAGE_HTML).toContain('answers: [{ id: decision.id, selectedOptionIds: [] }]')
    expect(PAGE_HTML).toContain('没有可安全表达的本机决定')
    // 不存在任何会话级允许按钮或答案形状。
    expect(PAGE_HTML).not.toContain('acceptForSession')
    expect(PAGE_HTML).not.toContain('allowAlways')
    expect(PAGE_HTML).not.toContain('alwaysAllow')
    expect(PAGE_HTML).not.toContain('session-allow')
  })

  it('卡片用完整 target 匹配且响应迟到不串线', () => {
    expect(PAGE_HTML).toContain('var targetKey = sessionKey(target)')
    expect(PAGE_HTML).toContain('sessionKey(value.target) !== targetKey')
    expect(PAGE_HTML).toContain('cardMap.delete(matchedKey)')
    expect(PAGE_HTML).toContain('if (current === null || sessionKey(current) !== sessionKey(target)) return')
    // 卡片闭包固定创建时的完整 target。
    expect(PAGE_HTML).toContain('var cardTarget = { deviceId: target.deviceId, agent: target.agent, sessionId: target.sessionId }')
    expect(PAGE_HTML).toContain("command('answer', payload, cardTarget, false, key)")
    // 列表与选择都有单调令牌。
    expect(PAGE_HTML).toContain('var token = ++loadToken')
    expect(PAGE_HTML).toContain('var token = ++selectionToken')
    expect(PAGE_HTML).toContain('if (token !== loadToken) return')
    expect(PAGE_HTML).toContain('if (token !== selectionToken) return')
    // 切换 agent 清空能力、卡片与映射。
    expect(PAGE_HTML).toContain('clearCapability()')
    expect(PAGE_HTML).toContain('cardMap.clear()')
  })

  it('移动端单列且控件可触控', () => {
    expect(PAGE_HTML).toContain('@media (max-width:720px)')
    expect(PAGE_HTML).toContain('flex-direction:column')
    expect(PAGE_HTML).toContain('min-height:40px')
    expect(PAGE_HTML).not.toContain('serviceWorker')
  })

  it('所有服务端文本仍按纯文本渲染', () => {
    expect(PAGE_HTML).not.toContain('innerHTML')
    expect(PAGE_HTML).not.toContain('insertAdjacentHTML')
    expect(PAGE_HTML).not.toContain('outerHTML')
    expect(PAGE_HTML).toContain('textContent')
  })
})
