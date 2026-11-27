import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLineDiff, collectSessionArtifacts, extractTextArtifacts, extractToolArtifacts,
  isPreviewableLocalPath, parseArtifactTarget,
} from '../src/lib/artifacts.ts'
import { parseInline } from '../src/lib/markdown.ts'

test('parseArtifactTarget extracts file:// path, line range, and media kind', () => {
  assert.deepEqual(
    parseArtifactTarget('file:///Volumes/Workspace/app.ts#L12-L34'),
    { path: '/Volumes/Workspace/app.ts', name: 'app.ts', kind: 'text', startLine: 12, endLine: 34 },
  )
  assert.equal(parseArtifactTarget('/tmp/render.png').kind, 'image')
  assert.equal(parseArtifactTarget('/tmp/demo.mp4').kind, 'video')
  assert.equal(parseArtifactTarget('/tmp/clip.mov').kind, 'video')
  assert.equal(parseArtifactTarget('/tmp/voice.m4a').kind, 'audio')
  assert.equal(parseArtifactTarget('/tmp/report.pdf').kind, 'pdf')
  assert.equal(isPreviewableLocalPath('/Volumes/SystemDisk/render.png'), true)
  assert.equal(isPreviewableLocalPath('plain_word'), false)
})

test('extractToolArtifacts computes colored line diffs for edit, write, Codex fileChange, and present', () => {
  const edited = extractToolArtifacts('mcp_dsh_edit', {
    file_path: '/Volumes/Repo/src/app.ts',
    old_string: 'const a = 1\nconst b = 2\n',
    new_string: 'const a = 1\nconst b = 3\nconst c = 4\n',
  })
  assert.equal(edited.length, 1)
  assert.equal(edited[0]?.action, 'edit')
  assert.equal(edited[0]?.added, 2)
  assert.equal(edited[0]?.removed, 1)
  assert.ok(edited[0]?.diffLines?.some((l) => l.type === 'remove' && l.text === 'const b = 2'))
  assert.ok(edited[0]?.diffLines?.some((l) => l.type === 'add' && l.text === 'const b = 3'))

  const codex = extractToolArtifacts('fileChange', {
    changes: [{ path: '/Volumes/Repo/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
  })
  assert.equal(codex[0]?.added, 1)
  assert.equal(codex[0]?.removed, 1)

  const presented = extractToolArtifacts('mcp_dsh_present', {
    files: [{ path: '/Volumes/Repo/out.mp4', description: '渲染结果视频' }],
  })
  assert.equal(presented[0]?.kind, 'video')
  assert.equal(presented[0]?.description, '渲染结果视频')

  const diff = buildLineDiff('a\nb', 'a\nc')
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
})

test('extractTextArtifacts & collectSessionArtifacts deduplicate edits and media references', () => {
  const textRefs = extractTextArtifacts('查看 [render.png](file:///tmp/render.png) 以及 ![预览](/tmp/shot.jpg) 和 `/tmp/demo.mp4`')
  assert.deepEqual(textRefs.map((r) => r.name), ['render.png', 'shot.jpg', 'demo.mp4'])

  const all = collectSessionArtifacts([
    {
      role: 'tool',
      text: '',
      artifacts: extractToolArtifacts('edit', {
        file_path: '/tmp/foo.ts',
        old_string: 'x',
        new_string: 'y',
      }),
    },
    { role: 'assistant', text: '已修改 [foo.ts](file:///tmp/foo.ts#L1) 并输出 `/tmp/demo.mp4`' },
  ])
  assert.equal(all.length, 2)
  assert.equal(all[0]?.path, '/tmp/foo.ts')
  assert.equal(all[0]?.action, 'edit')
  assert.ok(all[0]?.diffLines?.length)
  assert.equal(all[1]?.kind, 'video')
})

test('markdown parseInline turns ![alt](...) into image nodes and file:// into clickable fileRef with path', () => {
  const nodes = parseInline('![效果图](/tmp/render.png) 和 [app.ts](file:///tmp/app.ts#L5-L9) 与 `/tmp/clip.mp4`')
  assert.ok(nodes.some((n) => n.type === 'image' && n.local && n.src === '/tmp/render.png'))
  assert.ok(nodes.some((n) => n.type === 'fileRef' && n.path === '/tmp/app.ts' && n.startLine === 5 && n.endLine === 9))
  assert.ok(nodes.some((n) => n.type === 'fileRef' && n.path === '/tmp/clip.mp4' && n.kind === 'video'))
})
