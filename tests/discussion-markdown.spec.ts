import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { groupMarkdown, GROUP_MARKDOWN_SCRIPT, type MarkdownNode } from '../src/hub/discussions/markdown.ts'

function flatten(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children ?? [])])
}
class Element {
  children: Element[] = []
  text = ''; value = ''; href = ''; checked = false; disabled = false; type = ''
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) { this.children.push(...nodes) }
  get childNodes() { return this.children }
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set innerHTML(_value: string) { throw Error('unsafe HTML sink') }
}

describe('group Markdown preview', () => {
  it('renders nested formatting, code, task lists and GFM tables with reusable message tokens', () => {
    const message = { text: '# Result\n\n**Done** and *verified* with `code`.\n\n- [x] file\n  - nested\n\n> note\n\n```python\nassert x < 3\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com/docs)' }
    const nodes = groupMarkdown(message), all = flatten(nodes)
    expect(all.map(node => node.tag)).toEqual(expect.arrayContaining(['h1','strong','em','code','ul','li','checkbox','blockquote','pre','table','th','td','a']))
    expect(all.find(node => node.tag === 'pre')).toMatchObject({ language: 'python', children: [{ tag: 'code', children: [{ text: 'assert x < 3' }] }] })
    expect(groupMarkdown(message)).toBe(nodes)
    const render = runInNewContext(GROUP_MARKDOWN_SCRIPT + ';groupMarkdownBody', {
      URL, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const e = new Element('#text'); e.textContent = text; return e } },
      textNode: (tag: string, text: string) => { const e = new Element(tag); e.textContent = text; return e },
    })
    const result = render(nodes, message.text) as Element
    expect(result.textContent).toContain('Done and verified with code.')
    expect(result.textContent).toContain('复制代码assert x < 3')
    expect(result.textContent).not.toContain('```')
    expect(result.textContent).not.toContain('**Done**')
    expect(render(groupMarkdown({ text: 'A &amp; B' }), '').textContent).toBe('A & B')
    expect(render(groupMarkdown({ text: '&copy; &#x3c;script&#x3e; `&amp;`' }), '').textContent).toBe('© <script> &amp;')
  })
  it('keeps raw HTML, dangerous links and image tracking out of the active DOM', () => {
    const input = '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,boom) ![tracking](https://example.com/pixel)\n\n<script>alert(1)</script>'
    const nodes = flatten(groupMarkdown({ text: input }))
    expect(nodes.some(node => ['script', 'img', 'svg', 'iframe'].includes(node.tag ?? ''))).toBe(false)
    expect(nodes.filter(node => node.href).map(node => node.href)).toEqual(['https://example.com/pixel'])
    expect(nodes.some(node => node.text?.includes('<script>'))).toBe(true)
  })
})
