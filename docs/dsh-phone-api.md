# DSH 需要给手机中继补的接口

节点已经按这份契约调用。方法不存在，或 `capabilities()` 没有声明对应写入时，节点不上报空数据，也不把写入当成成功。DSH 加上这些方法之后，下一次中继周期会自动开始用。

服务名是 Cordis 服务：`taskBoard`、`memory`、`roster`。节点用 `ctx.get(name)` 取到对象。

## taskBoard.snapshot

```
snapshot(): {
  revision: number
  tasks: Array<{
    id: string
    title: string
    description?: string
    status: 'todo' | 'doing' | 'done'
  }>
}
```

`revision` 是这块看板的单调整数。没有这个字段时，节点仍转发任务正文，但拒绝任何写入。

## taskBoard.capabilities

```
capabilities(): {
  revision: true
  apply: Array<'create' | 'delete' | 'run' | 'edit' | 'move'>
}
```

节点只调用 `apply` 数组里列出的 kind。没有 `capabilities` 时，一个 kind 都不会调用。现在的 `apply` 遇到不认识的 kind 会原样返回快照，所以不能靠试调来判断。

## taskBoard.apply

```
apply(requestId: string, action): Promise<snapshot>
```

`requestId` 是 Hub 命令 id，同一 id 重复调用必须是同一个结果。

| kind | 参数 | 成功 | 失败 |
| --- | --- | --- | --- |
| `create` | `{ kind, baseRevision, input: { title, description? } }` | 新快照，`revision` 比 `baseRevision` 大 | `code: 'conflict'` 当 `baseRevision` 不是当前修订 |
| `delete` | `{ kind, baseRevision, taskId }` | 同上 | `conflict` 或 `not-found` |
| `run` | `{ kind, baseRevision, taskId }` | 同上 | `conflict` 或 `not-found` |
| `edit` | `{ kind, baseRevision, taskId, input: { title?, description? } }` | 同上 | `conflict` 或 `not-found` |
| `move` | `{ kind, baseRevision, taskId, status: 'todo' \| 'doing' \| 'done' }` | 同上 | `conflict` 或 `not-found` |

冲突时抛出 `{ code: 'conflict' }`，不要返回一份看起来改过的快照。

现有本地看板只有 `create`、`delete`、`run`，没有 `edit`、`move`，也没有 `revision`。补上 `capabilities()` 和修订检查之后，节点才会转发手机上的修改。

## memory.readPhone

```
readPhone({ allowContent: boolean, capBytes: number }): Promise<
  | { entries: Array<{ id: string, layer: 'private' | 'workspace', agent: string, text: string }> }
  | { code: 'withheld' | 'unavailable' }
>
```

`allowContent` 为 false，或内容共享关着时，返回 `{ code: 'withheld' }`，不要返回空数组。节点看到空数组会把它当成「这块记忆确实是空的」并覆盖 Hub 上的旧正文。读失败返回 `{ code: 'unavailable' }`。`capBytes` 是正文字节上限，超出的部分由 DSH 截断，节点不再发明内容。

`layer: 'private'` 对应全局 `rules` / `profile`。`layer: 'workspace'` 对应工作区 `handoff` / `notes`。`agent` 没有归属时用空串。

## roster.list

```
list(): { agents: Array<{ id: string, name: string }> } | { code: 'unavailable' }
```

`name` 是花名册里的显示名，例如「丞相」。账本不存在时返回 `{ code: 'unavailable' }`，不要编一个名字。节点在这个方法出现之前不会从别的文件猜花名册。
