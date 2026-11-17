import { describe, expect, it } from 'vitest'
import { createDiscussionText } from '../src/discussions/ports.ts'
import { FrameSchema, directionOf } from '../src/wire/frames.ts'
import { memberPrompt, estimateOutputTokens } from '../src/hub/discussions/profile.ts'
import { groupMarkdown } from '../src/hub/discussions/markdown.ts'
import { DISCUSSION_SCRIPT } from '../src/hub/discussions/page.ts'

describe('streaming group replies', () => {
  it('emits executable browser code including streaming and profile controls', () => {
    expect(() => new Function(DISCUSSION_SCRIPT)).not.toThrow()
  })
  it('replaces completed Codex items instead of doubling their deltas and preserves multiple messages', () => {
    const collect=createDiscussionText()
    expect(collect('item/agentMessage/delta',{itemId:'a',delta:'## Hello'})).toBe('## Hello')
    expect(collect('item/completed',{item:{id:'a',type:'agentMessage',text:'## Hello'}})).toBe('## Hello')
    expect(collect('item/agentMessage/delta',{itemId:'b',delta:'world'})).toBe('## Hello\n\nworld')
    expect(collect('item/completed',{item:{id:'b',type:'agentMessage',text:'world!'}})).toBe('## Hello\n\nworld!')
    expect(collect('item/reasoning/textDelta',{itemId:'hidden',delta:'hidden reasoning'})).toBeUndefined()
    expect(()=>collect('item/agentMessage/delta',{itemId:'c',delta:'汉'.repeat(6000)})).toThrow('size-limit')
  })
  it('validates bounded streaming frames and previews an unfinished code fence', () => {
    const frame={v:2,type:'discussion.progress',connectionId:'c',nodeEpoch:'e',roomId:'r',memberId:'m',turnId:'t',seq:1,text:'```python\nprint(1)',durationMs:10}
    expect(directionOf(FrameSchema.parse(frame))).toBe('node-to-hub')
    expect(FrameSchema.safeParse({...frame,seq:0}).success).toBe(false)
    expect(FrameSchema.safeParse({...frame,text:'汉'.repeat(6000)}).success).toBe(false)
    expect(groupMarkdown({text:frame.text})).toMatchObject([{tag:'pre',language:'python'}])
    expect(groupMarkdown({text:frame.text+'\n```\n\n**Done**'})).toHaveLength(2)
  })
  it('keeps visible estimates separate from billing and preserves phase boundaries in persona prompts', () => {
    expect(estimateOutputTokens('')).toBe(0)
    expect(estimateOutputTokens('中文abcd')).toBe(3)
    expect(memberPrompt('JSON ONLY')).toBe('JSON ONLY')
    const prompt=memberPrompt('JSON ONLY',{persona:'Friendly reviewer',expertise:'expert',stance:'review'})
    expect(prompt).toContain('Friendly reviewer')
    expect(prompt).toContain('Do not invent credentials')
    expect(prompt).toContain('tool/workspace limits')
  })
})
