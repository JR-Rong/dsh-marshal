# E2E-2026-11-18 · Super-agent 人工派发桥真机验收

- 日期：2026-11-18（America/Los_Angeles）
- 代码：分支 feat/task-board-superagent；最终代码 commit f58a1ff；PR #4
- 环境：本机 DSH 桌面宿主；最终 GUI 验收跑在 http://127.0.0.1:62150；早期真机跑在 63125 / 56120
- 任务包：TASK-0001 / SPC-0001

## 1. 真机链路

| 项 | 值 |
|---|---|
| 工单 id | 20469794-3c17-4c6d-a229-5296971084cb |
| 标题 | Super-agent 桥真机验收 |
| 执行 id | 7e47e297-152c-44c1-9bcc-f32c8ea2793d |
| 执行会话 | session-f3c7d3f7-4509-4b3f-8583-2200918a3af0 |
| 结果 | succeeded；卡片 done |
| initiatedBy | marshal-superagent |
| 标签 | 智能体:丞相 |
| 权限/模型 | danger-full-access / deepseek-account/deepseek-flash |

执行提示由桥生成，包含：丞相 brief、3 条相关长期记忆、工单要求、执行约定。卡片在结算后状态 done，执行记录可从卡片打开。

真机请求与浏览器 hook 发出的两次请求一致：先由看板 action 建卡，再由 human-create 通知桥。GUI 按钮点击本身未自动化，hook 的浏览器观察由单测覆盖；建议皇上再手点一张卡作最终体验验收。

## 2. 记忆闭环

- 桥结算后 status.recent[0] 显示 memoryWritten: true，agentId 为丞相，执行摘要为「Super-agent 桥已连通」。
- 该工单的 episode 已进入丞相的 agent 记忆；随后会话的系统记忆块中出现：
  - 工单「Super-agent 桥真机验收」完成
- 说明“结算写回 + 下次注入”闭环在真实记忆服务上成立。

## 3. 最终代码守卫复验（http://127.0.0.1:56120）

| 检查 | 结果 |
|---|---|
| GET /marshal-superagent | 200，6241 字节 HTML 控制页 |
| GET /marshal-superagent/health | ok=true；extension active=true；controlPage=/marshal-superagent |
| 缺 Origin POST human-create | 403 forbidden |
| cross-site POST human-create | 403 forbidden |
| 同源 POST human-create（已执行卡） | 200 duplicate-dispatch，未重复 run |
| 同源 POST config（defaultAgent=丞相, memoryLimit=6） | 200；状态回读一致 |
| 模型工具 config 动作 | 拒绝：unknown marshal_superagent action: config |

## 3.1 第一次 GUI 点击未触发的原因与修复

- 皇上第一次点「创建并执行」生成卡片 2793e898-12aa-4f24-83a9-e75ba38ce70d：卡片无「智能体」标签、prompt 未被桥改写、execution 的 initiatedBy 是普通 session，桥 records 仍为 1。
- 诊断：DSH 桌面 Web GUI 的页面 origin 是 dsh-app://app/，旧 hook 把通知发到 dsh-app://app/marshal-superagent/...，没有落到主机的 /marshal-superagent 路由；且「创建并执行」会在桥之前手动 run。
- 修复：hook 通知改走 /api/marshal-superagent/human-create（DSH 桌面把 /api/* 映射到主机 HTTP 并在宿主鉴权下转发），主机新增该别名；客户端已重载。请皇上再点「创建」（不要点「创建并执行」）验证。

## 3.2 GUI 成功验收（2026-11-18 02:27，62150）

在完整重启 DSH 后，皇上在任务看板点「创建」建卡；桥自动派发，未点「创建并执行」。

| 项 | 值 |
|---|---|
| 工单 id | d7103e7e-60d0-4c10-85e8-4aa1eb9e8bea |
| 标题 | 测试gui |
| 标签 | 智能体:丞相 |
| 执行 id | 33c73544-6018-4c5f-9e9e-324dd727ae6e |
| 执行会话 | session-30f5ccc8-c511-4eea-818f-5e71caa5c277 |
| initiatedBy | marshal-superagent |
| 结果 | succeeded；卡片 done |
| 桥记录 | status=settled，outcome=succeeded，memoryWritten=true |

执行 prompt 含丞相 brief、1 条相关长期记忆、工单要求与执行约定。结算后该工单 episode「工单「测试gui」完成」已出现在丞相的会话记忆块。A1/A6/A7 的 GUI 自动派发链路由此闭环。

## 3.3 二次复审安全加固（2026-11-18）

- 原先本机 curl 可直达 `/api/marshal-superagent/human-create`（无 cookie 仍 409 进入 dispatcher）；legacy 路由也可只凭伪造 Origin 到达。现在 human-create/config/dispatch 都必须通过 DSH Host connection 的 admission：签名 `dsh-auth-*` cookie、Host/Origin、有效期；并再次检查回环 Host。CI 覆盖“本机无 cookie curl 403”“legacy 伪造头 403”。
- `/status`、`/agents` 原先带 `Host: evil.example` 仍 200；现在 Host 非回环/缺失一律 403。
- 客户端 bundle 由 `scripts/append-superagent-hook.mjs` 刷新（替换旧 observer），测试从实际 `client/index.js` 提取并运行 observer，不再只测源文件。
- 改派卡：`composePrompt` 从旧派发块提取操作者原始要求，按当前成员重建；`mergeTags` 清除旧 `智能体:` 标签；改派后 prompt/标签/memory recall 均指向 B。
- 本机 live 已同步新宿主模块；需完整重启 DSH 后才能在生产路由复验 403。

## 4. agent 自建卡不触发（真机）

- 用 agent 工具 task_board_create 建卡 9f2958f1-2b68-4af7-aa58-f1d3cac14381。
- 等待 2.5s 后：卡片 status=todo、executionCount=0；桥 `state.records` 仍为 1，recent 只有真机验收卡。
- 证明 agent 工具建卡不会触发 human-create 派发；测试卡已删除。

## 5. 结论与残项

- A1/A6/A7 的 GUI 真机链路（皇上点「创建」→ hook → 桥自动 update/run → Running/会话 → 结算 → memoryWritten=true → 记忆 episode）已由 3.2 闭环。
- agent 自建卡不触发（A3）、缺 Origin/cross-site 拒绝、控制页、默认丞相、工具只读均已复验。
- 残项：0.2.1 tarball 在干净 profile 安装；高于会话默认权限的真实权限闸门；PR #4 由皇上自审（不自动合并）。第三轮盲审唯一 B1 已由皇上批准的 EXC-0001 结案，reviewer 原判仍 fail，不宣称 pass。
