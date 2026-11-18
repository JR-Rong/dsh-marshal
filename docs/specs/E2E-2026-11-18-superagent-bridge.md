# E2E-2026-11-18 · Super-agent 人工派发桥真机验收

- 日期：2026-11-18（America/Los_Angeles）
- 代码：分支 feat/task-board-superagent；功能 commit bdcad3a；HEAD e4171a8（仅 evidence/handoff）
- 环境：本机 DSH 桌面宿主；最终代码运行于 http://127.0.0.1:56120；首轮真机跑在 http://127.0.0.1:63125
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

## 4. agent 自建卡不触发（真机）

- 用 agent 工具 task_board_create 建卡 9f2958f1-2b68-4af7-aa58-f1d3cac14381。
- 等待 2.5s 后：卡片 status=todo、executionCount=0；桥 `state.records` 仍为 1，recent 只有真机验收卡。
- 证明 agent 工具建卡不会触发 human-create 派发；测试卡已删除。

## 5. 结论与残项

- A1/A6/A7 的真机核心链路（建卡 → 派发 → 原生 run → Running/会话 → 结算 → 记忆）已有本条记录作为证据；最终代码的控制页/守卫/只读工具在 56120 复验。
- 残项：GUI 按钮点击的最终体验验收；0.2.1 tarball 在干净 profile 安装；高于会话默认权限的真实权限闸门；第三轮独立盲审。
