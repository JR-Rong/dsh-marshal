# dsh-marshal v0 架构设计

日期：2026-10-29
状态：基于已有 v0 实现的 P1 目标架构；新增能力待实施
上游：[总体设计](2026-10-29-marshal-design.md) · [公共契约](2026-10-29-marshal-contract.md)
验证：[验收矩阵](2026-10-29-marshal-acceptance.md) · [v0 增量计划](../plans/2026-10-29-marshal-v0-p1.md)

## 1. 运行时与依赖方向

hub、node、浏览器为三个角色；一个 npm 插件包按 role 装配。hub 本地 agent 使用显式本地 node 装配，无特权捷径。

依赖方向为 index → hub/node → adapter → wire。公共策略由 node 执行；hub 的检查是额外约束，不能取代源端检查。单元测试可使用 runtime 替身，装配测试必须经过真实 HTTP/WSS/SSE 边界。

## 2. 模块责任

以下列出目标责任。当前 `feat/v0@702ef24` 已有 config、wire/frames、hub 的 devices/registry/server/relay/api/page、node 的 link/runner/questions/redact、DSH adapter/surface/map 及对应测试。

待新增的是 wire/commands、hub/identity、hub/sync、node/journal/sync/privacy/inputs/audit；privacy 应复用现有 redact，inputs 应吸收 questions 中现有待答逻辑，不创建互不一致的两套状态。表中的新职责尚未全量实现，不能当作当前模块能力。

| 模块 | 责任与边界 |
|---|---|
| src/config.ts | 严格配置验证；稳定 deviceId；默认 off；源端与 hub 内容授权 |
| src/wire/frames.ts | 按帧类型/方向验证、版本和连接代次；统一 ms 时间与 schema |
| src/wire/commands.ts | op 判别、规范化载荷、目标与状态版本，不使用任意字符串透传 |
| src/hub/devices.ts、src/bin/device.ts | 一机一密签发/撤销、只存 token 摘要、限制文件权限；文件损坏启动失败；变更热加载 |
| src/hub/identity.ts | 持久 operatorId 生成与受限存储；登录会话→审计身份的映射 |
| src/hub/registry.ts | 当前连接与 connectionId；替换/关闭使用比较后删除 |
| src/hub/server.ts | WSS Upgrade、Authorization、hello ACK、每帧身份检查、握手超时 |
| src/hub/relay.ts | event/ack/error 显式路由、in-flight 合并、状态查询、控制帧背压 |
| src/hub/sync.ts | 分片快照暂存、原子替换范围、游标与 stale 状态 |
| src/hub/api.ts、src/hub/page.ts | 登录/CSRF/失败限速、API、SSE、只读历史分页、交互状态、受限请求大小、纯文本渲染 |
| src/node/link.ts | 握手后上线、重连同步、分离控制帧与离线事件、字节预算；拨号 1s 起、封顶 10s、带 jitter |
| src/node/runner.ts | 身份、期限、幂等、写权与 op 验证；结果/错误投影 |
| src/node/journal.ts | node 去重持久记录；原子 admitted/结果；无正文；崩溃 unknown |
| src/node/sync.ts | 分页清单、快照屏障、epoch/seq、周期发现/删除 |
| src/node/privacy.ts | 字段白名单、内置/附加脱敏、字节限制；覆盖全部出站通道 |
| src/node/inputs.ts、src/node/questions.ts | 当前待答、策略、首答竞争、waterfall 交回、非历史快照 |
| src/node/audit.ts | 结构化无内容审计、操作人取认证上下文 |
| src/adapters/dsh/surface.ts | DSH 特有 API、进程内身份和 writer-held 接缝 |
| src/adapters/dsh/adapter.ts、map.ts | 原生帧归一化，观察与写入分开，统一 seq 分配 |

避免重复：ACK 和事件共享验证/隐私工具，但使用不同队列；适配器不各写一套幂等/期限逻辑。v1 只扩展 adapter 生命周期，不绕过 runner。

## 3. 关键端口

| 端口 | 输入/输出约束 |
|---|---|
| DshSurface.list/history/observe | AbortSignal、分页游标；不得 prompt/resume 取得写权 |
| DshSurface.write | 当前原生写者证据、操作标识；原生原子拒绝占用，不靠 list 后检查代替 |
| Adapter.frame | 同一会话快照、流、问题共用 seq；nodeEpoch 由 node 管理 |
| NodeLink | handshake/sync/online 分开；接收经认证的结构化 Frame；onOnline 只在同步完成后调用 |
| CommandJournal | reserve/lookup/transition；相同域原子互斥，持久失败不执行；显式容量上限 |
| HubRelay | command/status/publish/settle；settle 必须同时接收认证连接上下文 |
| OperatorIdentity | get/create；hub 本地受限存储；跨重启稳定，不接受浏览器自报 |
| SnapshotCoordinator | begin/chunk/end；完整范围、屏障游标、原子提交；单设备/hub 暂存字节预算 |
| PendingInputs | listValid/settle/expire；完整复合键与原始 expiresAt，不能延长审批期限 |

这里只规定责任与结果，不用本地自造的宽松类型宣称兼容 DSH。现有签名已封装在 surface；V0-T00 只补齐缺失证据和必要适配。

## 4. 命令时序与故障语义

```text
浏览器 POST（稳定幂等键）
  → hub 鉴权 / schema / in-flight 原子登记
  → 当前 device 连接 command
  → node 期限 / 原生写者 / 去重 journal
  → 持久 admitted → 调用 DSH → 保存受理结果
  → ACK（经过结果隐私投影）
  → hub 认证设备与连接匹配 → relay.settle
  → HTTP accepted
  → 后续 turn 事件独立报告 completed/failed/interrupted
```

ACK、错误帧与连接关闭必须有独立分支；不得只接 event。没有收到受理证据时显示 outcome-unknown，绝不靠超时推断执行未发生。查询只读；hub 不重放命令。

每会话互斥检查覆盖等待期间期限变化。重复请求直接取 journal 状态，不重新创建 DSH requestId。进程在任意崩溃窗口退出，未决操作按公共契约恢复为 unknown，不构造“最终一定只执行成功一次”的承诺。

## 5. 连接与状态同步

节点初次启动、hub 重启后重连、网络恢复都走同一路径：

1. 完成带版本/代次/内容策略的 hello ACK。
2. 原生分页清单与能力生成完整快照，设置增量屏障。
3. hub 暂存分片，验证 sync.end 后原子替换该设备范围。
4. 之后按 epoch/seq 应用增量，进入 online，开放写操作。
5. 发现缺口或离线队列淘汰时重新同步，不能仅打印 dropped 后宣称一致。

清单中删除的会话要从索引移除；agent 不可用不能当作“仍可写但空闲”。没有新事件的会话通过同步恢复，不依赖 follow 被再次点击。node 周期发现新建/删除会话。快照与周期扫描须有界分页、AbortSignal 和单实例执行，不能重叠扫描。

v0 不存内容补看历史；页面断线可重建索引和当前待答，时间线显示缺口。v1 再加入有限内容回放，不能把 v0 的状态同步延后到 v1。

## 6. 普通问题与交互生命周期

DSH 认领模式只用于已验证的普通问题 waterfall。远端策略、请求类别、完整可表达性必须在认领前验证。remote 认领后在 node 持有待答 Promise，交互正文通过即时发送或 inputs.snapshot 获取，不进离线事件缓存。

合法首答由 node 原子结算；非法答案不抢占；多端以源端 input.resolved 收拢。超时或远端放弃时按已验证的 next() 语义回本地；取消/卸载要清理 timer/handler，不能同时给本地和远端执行两次答案。continued 补偿首版不实现。

页面刷新从源端恢复有效待答；只记录 requestId 不能恢复题目，不能把完整卡片塞进历史缓冲解决。源端断线显示未知不可答。

## 7. 隐私与安全

事件、ACK、错误、快照、待答、状态查询全部在源端投影。metadata 不透出原始标题/cwd；content 必须由设备和 hub 同时允许。内置敏感规则不可关闭，递归超限丢弃而非放行。

日志保留安全枚举与标识；原生异常、命令正文和已认证 token 均不记录。审计与 journal 分开：前者供追踪，后者供执行去重；二者都不持久化内容。

API/SSE 使用登录 cookie 与 Origin/CSRF 检查，设备通道使用 Authorization。登录失败按来源与全局限速；dashboardToken 必须来自随机源。WSS 握手后每帧再次绑定 deviceId/connectionId；旧 close 不能注销新连接。HTTP 请求体、JSON 深度、SSE 写缓存、同步暂存、设备待握手数量都有硬限额。设备表损坏时启动失败，热加载变更后 5s 内撤销生效；页面把 wire 文本按纯文本渲染。

## 8. 可观测性与运行目标

计数器至少包括 commands.admitted/rejected/unknown、duplicate.merged、identity.rejected、events.dropped、sync.started/completed/failed、input.expired、agent.errors。按分类聚合，不把内容作为 label。

资源预算和时间默认值只引用公共契约；延迟、50 node 合成负载和 100 会话分页的执行条件见 B07。内存测量分别报告插件、hub 缓冲与 agent 进程，不能混用或承诺未经测量的进程占用。

## 9. 必须先验证的 DSH 接缝

| 接缝 | 验证方式 | 不成立时 |
|---|---|---|
| webServer Upgrade 与 ws | 使用真实宿主完成握手/首帧/关闭，不仅检查 TypeScript 类型 | 停止该适配路径，记录具体替代方案后重测 |
| list/history/follow 进程内身份 | 固定源码 commit，实测无 Remote 上下文调用 | 建立正确原生身份；必要时只提供明确 poll 观察 |
| writer-held | 两客户端并发 prompt 与本地交互同时运行 | 没有原子边界则只读，不靠先 list 再写 |
| waterfall 顺序和 next() | 远端认领、超时、本地回答、卸载四条链路 | questionRelay 关闭，保留本地行为 |
| disposal | 插件停用后连接、timer、follow 全释放 | 阻塞交付，不能靠进程退出清理 |

已有 [接缝报告](../spikes/2026-10-29-dsh-seams.md) 中三项 OK 保留，不能把源码/最小握手实验扩大为两机或完整宿主验收。V0-T00 增补 writer-held、完整生命周期及目标环境差异，分别记录 OK/FAIL/UNKNOWN。

## 10. 架构决策

- 保留反向 WSS 和自包含页面，满足 node 零入站与单包部署。
- 新增 node 无内容的持久去重 journal，避免 hub 重启/ACK 丢失导致重复执行；不引入云端正文数据库。
- 将连接同步作为通用基础能力，不能留到适配器完成后补救。
- 观察与控制独立：现有 DSH resume 只是 follow，wire v2 改名 observe；v1 新增的原生 resume 受 acquire 写权门槛约束。
- P1 与验收映射统一放入验收矩阵；本文件不复制不同默认值和“预计全部通过”的结果。
