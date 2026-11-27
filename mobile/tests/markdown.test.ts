import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMarkdownHref, parseInline, parseMarkdown } from '../src/lib/markdown.ts'

test('parseMarkdown handles headings, paragraphs, lists, tasks, blockquotes, hr, code fences, and tables', () => {
  const md = [
    '# 标题一',
    '',
    '第一行正文 **加粗** 与 `inline_code` 以及 snake_case_name。',
    '第二行换行 *斜体* 和 ~~删除线~~。',
    '',
    '- 列表一',
    '- [x] 已完成任务',
    '- [ ] 未完成任务',
    '',
    '1. 步骤一',
    '2. 步骤二',
    '',
    '> 引用内容 **重点**',
    '',
    '---',
    '',
    '```ts',
    'const x = 1 < 2 && 3 > 0',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | ---: |',
    '| 值1 | `值2` |',
  ].join('\n')

  const blocks = parseMarkdown(md)
  assert.deepEqual(blocks.map((b) => b.type), [
    'heading', 'paragraph', 'list', 'list', 'blockquote', 'hr', 'code', 'table',
  ])
  assert.equal(blocks[0]?.type === 'heading' && blocks[0].level, 1)

  const para = blocks[1]
  assert.equal(para?.type, 'paragraph')
  if (para?.type === 'paragraph') {
    assert.ok(para.children.some((n) => n.type === 'strong'))
    assert.ok(para.children.some((n) => n.type === 'code' && n.text === 'inline_code'))
    assert.ok(para.children.some((n) => n.type === 'text' && n.text.includes('snake_case_name')))
    assert.ok(para.children.some((n) => n.type === 'break'))
    assert.ok(para.children.some((n) => n.type === 'em'))
    assert.ok(para.children.some((n) => n.type === 'del'))
  }

  const ul = blocks[2]
  assert.equal(ul?.type, 'list')
  if (ul?.type === 'list') {
    assert.equal(ul.ordered, false)
    assert.equal(ul.items[1]?.checked, true)
    assert.equal(ul.items[2]?.checked, false)
  }

  const code = blocks[6]
  assert.equal(code?.type, 'code')
  if (code?.type === 'code') {
    assert.equal(code.lang, 'ts')
    assert.equal(code.text, 'const x = 1 < 2 && 3 > 0')
  }

  const table = blocks[7]
  assert.equal(table?.type, 'table')
  if (table?.type === 'table') {
    assert.deepEqual(table.align, [null, 'right'])
    assert.equal(table.header.length, 2)
    assert.equal(table.rows.length, 1)
  }
})

test('parseMarkdown safely handles unclosed code fences during streaming', () => {
  const blocks = parseMarkdown('正在输出：\n```python\nprint("hello")')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1]?.type, 'code')
  if (blocks[1]?.type === 'code') {
    assert.equal(blocks[1].lang, 'python')
    assert.equal(blocks[1].text, 'print("hello")')
  }
})

test('link classification allows http(s), turns file:// into file chips, and neutralizes javascript/XSS', () => {
  assert.deepEqual(classifyMarkdownHref('https://example.com/a?b=1'), { kind: 'external', href: 'https://example.com/a?b=1' })
  assert.deepEqual(classifyMarkdownHref('file:///Volumes/Repo/src/app.ts#L10-L20'), { kind: 'file', label: 'app.ts' })
  assert.deepEqual(classifyMarkdownHref('javascript:alert(1)'), { kind: 'unsafe' })
  assert.deepEqual(classifyMarkdownHref('data:text/html,<script>alert(1)</script>'), { kind: 'unsafe' })

  const inline = parseInline('点击 [安全](https://example.com) / [源码](file:///a/b/foo.ts) / [恶意](javascript:alert(1)) <script>x</script>')
  assert.ok(inline.some((n) => n.type === 'link' && n.href === 'https://example.com/'))
  assert.ok(inline.some((n) => n.type === 'fileRef' && n.label === '源码'))
  assert.equal(inline.some((n) => n.type === 'link' && n.href.startsWith('javascript:')), false)
  assert.ok(inline.some((n) => n.type === 'text' && n.text.includes('<script>x</script>')))
})
