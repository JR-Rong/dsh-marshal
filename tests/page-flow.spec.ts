import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from '../src/hub/page.ts'

describe('page flow', () => {
  it('登录表单只用请求体提交 token，恢复走 session', () => {
    expect(PAGE_HTML).toContain("request('/marshal/login'")
    expect(PAGE_HTML).toContain("body: JSON.stringify({ token: token })")
    expect(PAGE_HTML).toContain('/marshal/api/session')
    // token 不进入 URL：页面里只有登录请求体这一处引用输入值。
    expect(PAGE_HTML).not.toContain('?token=')
    expect(PAGE_HTML).toContain('type="password"')
  })

  it('CSRF 从 cookie 读取并作为 header 发送', () => {
    expect(PAGE_HTML).toContain("__Host-marshal-csrf")
    expect(PAGE_HTML).toContain("headers['x-marshal-csrf']")
  })

  it('所有 wire 文本按纯文本渲染，不拼 HTML', () => {
    expect(PAGE_HTML).not.toContain('innerHTML')
    expect(PAGE_HTML).not.toContain('insertAdjacentHTML')
    expect(PAGE_HTML).not.toContain('outerHTML')
    expect(PAGE_HTML).toContain('textContent')
  })

  it('卡片独立于时间线并按完整键管理', () => {
    expect(PAGE_HTML).toContain('id="cards"')
    expect(PAGE_HTML).toContain('function cardKey(target, runtimeEpoch, requestId)')
    expect(PAGE_HTML).toContain("if (seen[question.id]) continue")
    // 远端卡片必须有 acceptOnceEligible，否则只读。
    expect(PAGE_HTML).toContain("card.acceptOnceEligible === true")
  })

  it('答案提交使用 T07 形状', () => {
    expect(PAGE_HTML).toContain('selectedOptionIds')
    expect(PAGE_HTML).toContain('answers: answers')
    expect(PAGE_HTML).toContain("answer.text = text")
  })

  it('发送前写 IndexedDB，存储失败拒绝新写', () => {
    expect(PAGE_HTML).toContain('indexedDB')
    expect(PAGE_HTML).toContain("createObjectStore('intents'")
    expect(PAGE_HTML).toContain('持久存储不可用，拒绝发送')
    expect(PAGE_HTML).toContain('function reconcilePending')
    // 恢复后只查 command-status，不自动重发。
    expect(PAGE_HTML).toContain('/marshal/api/command-status')
  })

  it('SSE reset 先清空再重建，并区分结果文案', () => {
    expect(PAGE_HTML).toContain("addEventListener('reset'")
    expect(PAGE_HTML).toContain('状态未知、暂不可答')
    expect(PAGE_HTML).toContain('DSH 已交回本地')
    expect(PAGE_HTML).toContain('未确认')
    expect(PAGE_HTML).toContain('已受理')
    expect(PAGE_HTML).toContain('回合完成')
    expect(PAGE_HTML).toContain('拒绝')
    expect(PAGE_HTML).toContain('function onReset')
  })

  it('选择会话只 observe，写操作按状态禁用', () => {
    expect(PAGE_HTML).toContain("command('observe', { kind: 'follow', action: 'subscribe' }")
    expect(PAGE_HTML).toContain("writeState !== 'ready'")
    expect(PAGE_HTML).toContain('会话忙碌')
    expect(PAGE_HTML).toContain('能力已过期')
  })
})
