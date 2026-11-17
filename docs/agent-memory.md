# Agent 记忆

调度官的 Agent 记忆是 SQLite + FTS5 + 本地哈希向量的长期记忆，按 owner 分库：

    ~/.dsh-marshal/memory/
      global.db
      workspaces/<workspaceId>/memory.db
      agents/<agentId>/memory.db
      settings.json

## 作用域

| 层 | 归属 | 可见性 |
|---|---|---|
| Agent | 单个 Agent | 只有该 Agent |
| Workspace | 一个工作区 | 在该工作区工作的 Agent |
| Global | 机主 | 本机所有 Agent |

Agent 进入一个工作区时，同时读取该工作区的共享记忆；换工作区时 Agent 私有记忆不变。
群聊会注入 Agent 私有记忆，默认禁止原文引用；可在记忆设置里打开“群聊允许引用”。

## 检索

- FTS5 unicode61 + 中文 bigram/trigram 预处理；
- 384 维本地哈希向量（默认，无外部依赖）；
- 最终分数 = FTS/向量 RRF + importance + recency + access + pinned；
- 可后续切换真实 embedding，表结构不换。

## 自动记忆

- 会话开始：注入 Agent profile/handoff、当前 Workspace 交接、Global 规则；
- 每条新用户消息：按最后一条用户消息做一次 top-k 召回；
- 会话 turn/end 后 60 秒：本地启发式摘要写入 Agent episode；
- 设置页可关闭自动摘要/自动召回。

## 加密同步

节点配置：

    export DSH_MARSHAL_MEMORY_SYNC_KEY='一段只在自己设备间共享的同步口令'

记忆页点“同步”：

1. 本地记录用 AES-256-GCM 加密；
2. 推送到 /marshal/api/memory-sync/push；
3. 从 /marshal/api/memory-sync/pull 拉取并解密；
4. hub 只保存密文、id、revision、时间，没有正文/标签/向量。

第一版使用共享口令派生密钥；后续可替换为 X25519 设备密钥封装，不改变密文记录格式。

## 3D 记忆星系

- 胶囊“记忆”页；
- 每个 Agent 独立星系；
- 节点大小 = importance + access_count；
- 颜色 = kind；
- 边 = 标签 / 同会话；
- 拖拽旋转、滚轮缩放、点击节点查看详情；
- 低配设备可切回列表（后续）。

## 当前限制

- 摘要目前是本地启发式，不调用 LLM；summaryModel 字段预留给后续模型摘要；
- 同步是手动按钮，尚未做后台定时同步；
- 群聊私有记忆的“禁止原文引用”是提示 + 输出检查策略，不是密码学隔离；
- 删除记忆暂未同步 tombstone。
