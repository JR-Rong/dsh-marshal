# Agent 记忆

调度官的 Agent 记忆是 SQLite + FTS5 + 本地哈希向量的长期记忆，按 owner 分库：

    ~/.dsh-marshal/memory/
      global.db
      workspaces/<workspaceId>/memory.db
      agents/<agentId>/memory.db
      settings.json

## 两层记忆

文件记忆和 SQLite 记忆同时挂载，各写各的，注入时按正文去重，同一句事实只出现一次。

| 层 | 存在哪里 | 谁来写 | 注入什么 |
|---|---|---|---|
| 文件记忆 `marshal_memory` | `rules.md` / `profile.md` / 工作区 `handoff.md` / `notes.md` | 工具直接写短结论。全局只接受 profile 追加 | 全局铁律和当前工作区交接。笔记留在工具里，不进提示词 |
| SQLite `agent_memory` | 按 owner 分库 | Agent / 工作区可直接记。全局写入变成待审批提案 | 长期事实、交接、画像和召回。和文件块重复的正文会丢掉 |

## 作用域

| 层 | 归属 | 可见性 |
|---|---|---|
| Agent | 单个 Agent | 只有该 Agent。私有事实放这里 |
| Workspace | 一个工作区 | 在该工作区工作的 Agent |
| Global | 机主 | `all`：所有会话都注入。`no-group`：只注入 1:1，群聊会话不注入 |

全局没有 `private`。旧数据里未知或 `private` 的可见性会在打开库时改成 `no-group`。群聊和单聊的差别在注入时按会话类型判断（群成员会话、`group: true`，或会话头里的 group），不靠提示词自觉。

Agent 不能直接写全局。`agent_memory` 的 `scope=global` 只产生一条提案：`pending`、提案的 agentId、正文、建议可见性和时间。提案不进入任何提示词。记忆页的「全局记忆审批」可以同意、改完再同意，或拒绝。只有同意才会变成一条生效的全局记忆。机主可以在同一页直接新建、修改和删除全局记忆。

Agent 进入一个工作区时，同时读取该工作区的共享记忆；换工作区时 Agent 私有记忆不变。
群聊会注入 Agent 私有记忆，默认禁止原文引用；可在记忆设置里打开“群聊允许引用”。全局的 `no-group` 不靠这句提示，群聊会话里根本不会注入。

## 检索

- FTS5 unicode61 + 中文 bigram/trigram 预处理，查询侧剔除功能词 bigram；
- 384 维本地哈希向量（默认，无外部依赖）；
- 最终分数 = FTS/向量命中 + importance + clarity + recency + access；
- 可后续切换真实 embedding，表结构不换。

## 清晰度与归档

- `vivid → clear → fuzzy → trace`，不自动进入 forgotten；
- 重要 / pinned / profile / handoff / decision 衰减更慢；
- 注入时模糊记忆会带“细节记不清了”的措辞；
- 手动删除进入 `memory_archive`，不物理销毁。

## 自动记忆

- 会话开始：注入 Agent profile/handoff、当前 Workspace 交接、Global 规则；
- 每条新用户消息：按最后一条用户消息做一次 top-k 召回；
- 系统提示按“固定区 + 相关区”拼装，超预算整条裁剪；
- 会话 turn/end 后 60 秒：过滤 → 摘要模型提炼 → 规则打分 → 写 Agent episode；
- summaryProvider / summaryModel 留空，或当天 token 达到 `dailyTokenCap`（默认 50000）时，退回本地启发式，不再调用模型；
- 摘要走插件其余路径同一个 `prepareCall` 包装。provider 不限定 qwen，填什么就调什么；
- 用量记在 `summary-usage.json`，按 UTC 日累计模型返回的 token，没有用量字段时按字符估算。

## 本地记忆接口

`/marshal/memory/*` 绑定当前桌面会话，不能靠改 `agentId` 读取别人的库。

- `POST /marshal/memory/session` 只接受本机回环，并带 `x-marshal-memory: 1`。它签发 `__Host-marshal-memory-session` 和 `__Host-marshal-memory-csrf`。
- 写操作要同时带上 cookie 和 `x-marshal-csrf`，两边都必须等于服务端为这个会话保存的随机值，和 `/marshal` 其它写接口一样。
- 全局审批、直接改全局记忆、设置和同步只允许机主会话。
- 未登录的 `/marshal/health` 不返回 `agentMemory`；只有本机回环看得到这个字段。

## 加密同步

节点配置（12–19 个字符需要小写、大写、数字、符号里的至少三类；20 个字符及以上至少两类。全同一个字符不行）：

    export DSH_MARSHAL_MEMORY_SYNC_KEY='一段只在自己设备间共享的同步口令'

记忆页点“同步”：

1. 本地记录和删除墓碑用 AES-256-GCM 加密；
2. 推送到 /marshal/api/memory-sync/push；
3. 从 /marshal/api/memory-sync/pull 拉取并解密；
4. hub 只保存密文、id、revision、时间和墓碑标记，没有正文、标签或向量。

Hub 用设备 bearer 认出设备，再核对这台设备属于哪个 owner。账号注册的设备记下 `ownerId`（账号哈希）；还没有 owner 的旧设备归到该 Hub 的 operator。客户端传来的 ownerId 只是记忆归属（agent 或 workspace），不能借它读取另一个账号的密文。某个 id 一旦留下墓碑，后到的活记录不能把它救回来。

每个 owner 有自己的随机 scrypt 盐，和密文存在同一个文件里。升级前的旧记录仍用固定盐 `dsh-marshal-memory-sync-v1` 解密；新写入使用该 owner 的盐。同步文件权限 `0600`，写入走锁和原子替换，密文总量默认不超过 32 MiB。

口令太弱时同步直接失败，提示 `weak-passphrase`。

## 3D 记忆星系

- 胶囊“记忆”页；
- 每个 Agent 独立星系；
- 节点大小 = importance + access_count；
- 颜色 = kind；
- 边 = 标签 / 同会话；
- 拖拽旋转、滚轮缩放、点击节点查看详情；
- 低配设备可切回列表（后续）。

## 测试

根目录：

```bash
pnpm test:memory
```

这条命令跑 `plugin-build/test/*.test.js`（`node --test`）。`pnpm test` 会先跑 vitest，再跑同一组。`pnpm typecheck` 仍只检查 `src/`。

## 当前限制

- 同步仍是记忆页上的手动按钮，没有后台定时同步；
- Agent 私有记忆的“不要原文引用到群聊”仍是提示，不是密码学隔离；全局 `no-group` 则是注入时直接不给；
- 文件记忆的全局 profile 仍是短操作笔记，不走 SQLite 那条审批队列。
