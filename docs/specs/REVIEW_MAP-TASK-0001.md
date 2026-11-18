# REVIEW MAP · TASK-0001

有效变更约 2,400 行 / 7 块（新增模块 1,423 行、测试 844 行、bundle 追加 96 行、文档与打包其余）。超过 400 行阈值，按章程提交阅读地图。

| 块 | 范围 | 类别 | 行数 | 风险 | 证据 | 建议 |
|---|---|---|---|---|---|---|
| 1 | plugin-build/lib/src/superagent/dispatch.js、prompt.js、extension.js | 核心 | 583 | 高 | superagent-dispatch / superagent-settle 共 18 条 | 深审 |
| 2 | plugin-build/lib/src/superagent/mount.js + control-page.js | 核心 | 600 | 高 | superagent-mount 6 条 + 路由守卫/控制页测试 | 深审 |
| 3 | plugin-build/lib/src/superagent/agents.js、settings.js、state.js、memory.js | 支撑 | 546 | 中 | superagent-core 7 条 + 记忆读写测试 | 抽读 |
| 4 | plugin-build/lib/src/index.js（import + mountSuperagent） | 接线 | 7 | 中 | 入口 import 实跑 | 抽读 |
| 5 | plugin-build/client/superagent-hook.js + client/index.js 追加段 | 核心 | 190 | 高 | superagent-hook 5 条；bundle 一致性断言 | 深审 |
| 6 | plugin-build/test/superagent-*.test.js + support | 测试 | 844 | — | 换手评审 | 只看断言是否真能失败 |
| 7 | docs/specs、docs/adr、tasks、project.json、README/INSTALL、tarball | 外围 | 其余 | 低 | 文档与打包检查 | 告知不占预算 |

## 反查表

| 验收 | 实现块 | 证据 |
|---|---|---|
| A1 | 1、2、5 | dispatch: default agent prepares the card / mount: human-create route / hook: GUI create |
| A2 | 1、3 | dispatch: tag overrides / agents: alias and tag |
| A3 | 5 | hook: only POST create over fetch; agent tool calls never touch the observer |
| A4 | 1 | dispatch: rootOnly suppresses subtasks |
| A5 | 1、3 | dispatch: prompt/pins; patch: permission not raised |
| A6 | 1、2 | dispatch: update then run; record sessionId; board status running |
| A7 | 1、3 | settle: one agent-scoped episode with summary; memory fake records kind/agentId |
| A8 | 1、3 | dispatch: memory recall feeds prompt and can be switched off |
| A9 | 1、3 | duplicate notifications / restart test / settle-in-flight |
| A10 | 1、2 | run refusal recorded; memory failure recorded; health/status |
| A11 | 1、2、5 | disabled route test; hook test skips failed/disabled responses |
| A12 | 2、5 | DSH connection admission (signed cookie) + loopback Host; curl without cookie 403; dispatch refuses source != board-ui |
| A13 | 6 | node --test test/*.test.js 72/72（含 hook→HTTP→dispatch 集成、bundle 行为、curl 冒充拒绝） |
| A14 | 7 | tarball contents + README/INSTALL |
| A15 | 5 | shipped client/index.js 中提取的 observer 与实际运行行为；与源文件逐字一致 |
| A16 | 1 | 改派卡重算当前身份的 prompt/标签，旧身份不残留 |
| A17 | 2 | status/agents 对非回环 Host 返回 403 |

## 人类预算

高：块 1、2、5 全额；中：块 3、4 抽读；低：块 7 不读，块 6 只看断言是否能失败。按高风险块计预算，不按总行数计。

## 未覆盖与已知缺口

- GUI 真机链路已在 2026-11-18 62150 完整重启后由 d7103e7e 验收通过；本表中的单元/集成测试仍用于回归。
- 看板客户端的 action 端点是第三方实现细节；hook 失效时不会误触发，但也不会派发。已列入复审条件。
- 远端/手机建卡不触发；用 marshal_superagent dispatch 补派。
