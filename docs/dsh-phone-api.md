# 手机中继使用的 DSH 接口

节点按宿主实际提供的能力转发。写操作需要宿主声明对应操作及修订检查。

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

`revision` 是这块看板的单调非负安全整数。没有这个字段时，手机可以展示初始只读快照。缺失或过期的快照会保留 Hub 已有视图，实际空板仍用 `tasks: []` 上报。

## taskBoard.capabilities

```
capabilities(): {
  revision: true
  apply: Array<'create' | 'delete' | 'run' | 'edit' | 'move'>
}
```

节点在 `revision: true` 且 `apply` 列出对应 kind 时才调用写入。宿主必须返回比 `baseRevision` 更高的修订才能确认成功。

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
  | { entries: Array<{ id: string, layer: 'private' | 'workspace' | 'global', agent: string, text: string }> }
  | { code: 'withheld' | 'unavailable' }
>
```

`allowContent` 为 false 或宿主撤回共享时返回 `{ code: 'withheld' }`，Hub 随即清除旧正文。读失败返回 `{ code: 'unavailable' }`，之前获授权的快照最多缓存 45 秒。`{ entries: [] }` 表示成功读到空集合。`capBytes` 是正文的 UTF-8 字节上限。

节点只在 WebSocket 完成同步且握手同意内容共享时上报正文，并绑定当前 `connectionId` 与 `policyRevision`。Hub 在写入和读取时复核这两个值、设备的当前授权和所属账户。账户绑定可以来自配对登记或 Hub 显式配置的机主。历史客户端缺少这两个字段时无法发布正文。

已装配的 Marshal 插件在宿主缺少 `memory.readPhone` 时提供 SQLite 投影。投影只读取可见性为 `all` 的当前全局记忆，标为 `global`。Agent 私有库、工作区正文、待审提案和 `no-group` 条目保留在原有存储和加密同步路径。

## roster.list

```
list(): { agents: Array<{ id: string, name: string }> } | { code: 'unavailable' }
```

`id` 是稳定的成员身份，`name` 是显示名。手机只读展示成员及其所属设备，通用新会话从设备的引擎入口发起。安装包开启 groups 时可以从现有 `dsh-agents` 账本提供队伍内成员，只上报身份和名字。账本缺失或读失败返回 `{ code: 'unavailable' }`。
