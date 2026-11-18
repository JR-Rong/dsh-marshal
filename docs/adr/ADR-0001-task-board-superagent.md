# ADR-0001 · 任务看板人工派发桥的实现选择

- 状态：已接受
- 日期：2026-11-18
- 关联：SPC-0001、TASK-0001

## 背景

任务看板是第三方 DSH 插件 @linxin666/dsh-client-ui-task-board；它只对扩展发 status-changed / execution-settled / task-deleted 三类事件，没有 task-created 事件，也不在卡片里保存创建者。智能体定义在 @linxin666/dsh-agents 的账本里；其 /run 接口会新建成员会话，但工作区取小队设定，执行记录也不进看板。

皇上要的是：人在 GUI 新建工单 → 唤醒指定 agent → 在原生执行会话里开发 → 工作内容进该 agent 的记忆，且不能误触发 agent 自建卡。

## 选项

1. 新增独立子插件（dsh-marshal-superagent），与 dsh-marshal 并列安装。
   - 优点：干净、源码完整、可独立启停；不动现有插件。
   - 缺点：多一个插件；仍需修改第三方或做同样的触发。
2. 直接改 dsh-marshal，新增 superagent 模块 + 浏览器 hook（本次选择）。
   - 优点：皇上指定；一个插件；复用现有 webServer/tools/记忆服务；不碰第三方源码。
   - 缺点：仓库只提交编译产物，client bundle 是生成文件；hook 需追加到生成产物。
3. 改第三方 dsh-web 仓库，在看板内加 onTaskCreated 事件与创建来源字段。
   - 优点：语义最准确，不依赖浏览器旁路。
   - 缺点：跨仓库维护第三方分支；本次没有该仓库的交付授权；升级看板会再次冲突。

## 决定

选 2，并采用以下边界：

- 触发：浏览器端只观察 POST /api/task-board/action 中 action.kind === 'create' 的请求；响应成功后再通知本机主机。agent 用工具建卡不经过浏览器，因此天然不触发。
- 执行：走看板原生 run（taskBoard.apply({kind:'run'})），而不是 dsh-agents 成员会话。这样卡片工作区、会话、执行记录、状态、结算都由看板托管，卡上能直接看到 agent 在工作；agent 身份通过执行提示注入。
- 记忆：不依赖看板会话的身份自动解析。派发时从 createAgentMemoryService 的 agent scope 读取该成员记忆并注入提示；结算时显式 rememberFor({agentId, scope:'agent'}) 写回。
- 指定：设置里的默认 agent + 卡片标签 @某官（可配别名）覆盖；按名字或成员 id 解析。默认已设为丞相。
- 范围：默认只对根卡触发；子卡需显式 rootOnly=false。不自动确认权限；高于会话默认的权限只记录。
- 人机边界：模型工具只读（status / agents / reconcile）；配置与人工补派只在本机同源浏览器控制页 /marshal-superagent。human-create / config / dispatch 路由要求 Origin + Sec-Fetch-Site: same-origin + 回环 Host；本机进程蓄意伪造全部请求头不在本桥信任边界内。

## 代价

- 触发依赖看板客户端的 action 端点；端点变化时 hook 失效（fail-soft，不误触发）。
- 原生执行会话的系统提示仍是看板默认预设；agent 的 brief 以用户消息出现，不是系统提示。对按角色工作足够，但权威性弱于预设。
- 远端/手机建卡不触发；人工补派工具兜底。
- client bundle 是生成产物；本次追加 hook 并保留独立源文件与一致性测试，后续若重建 bundle 需要重新接入（已在 README 标注）。

## 验证

- 单测覆盖：默认/标签/别名、rootOnly、幂等、权限降级、结算写记忆、记忆注入、失败可见、关闭开关、路由安全、hook 行为。
- 回归：现有 plugin-build 测试全绿。
- 真机：皇上重启 DSH 后新建一张根卡，确认卡片 Running、会话可见、记忆新增；再建一张带 @ 标签的卡验证覆盖。

## 复审条件

- 看板新增创建事件或创建来源字段 → 改用它，移除浏览器旁路。
- dsh-agents 支持把成员 brief 绑定到看板执行会话 → 改用成员身份，减少提示拼接。
- 皇上要远端触发 → 增加看板路由来源/设备授权，而不是放宽本机路由。
