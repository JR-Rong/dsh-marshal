# dsh-marshal plugin build

Self-contained installable build of the marshal plugin.

Install from the tarball in this directory:

- Desktop: Plugins -> Add plugin -> pick the .tgz;
- CLI: dsh plugin --profile desktop add /abs/path/dsh-marshal-0.2.1-superagent.1.tgz.

Required DSH plugins (install in the same profile first):

- @linxin666/dsh-agents (required for agents/groups/cross-device)
- @linxin666/dsh-client-ui-task-board (optional; full task board)

These are DSH plugins, not ordinary npm dependencies of marshal. Without
@linxin666/dsh-agents the health endpoint reports agents:false; without the
task-board plugin marshal uses its built-in lightweight board.

Do not install from the repository root. See INSTALL.md.

## Super-agent 人工派发桥（0.2.1+）

皇上在任务看板 GUI 新建一张工单后，marshal 会按「默认智能体 + 卡片标签」唤醒指定智能体，在**看板原生执行会话**里完成工单；结算后把工作摘要写进该智能体的长期记忆，下次派发前再取回参考。

- **只认人工建卡**：浏览器端只观察看板 `POST api/task-board/action` 的 `create`；agent 用 `task_board_create` 建卡、GitHub 导入、定时任务都不触发。默认只派发根卡；子卡用 `rootOnly=false` 才派发。
- **指定智能体**：默认已设为 **丞相**；卡片标签写 `@工部尚书` 可改派；也可在控制页配别名（如 `工部 → 工部尚书`）。
- **执行**：marshal 把成员 brief、相关长期记忆、工单要求合成提示，补齐成员的模型/思考档位/预设；权限高于看板会话默认时不自动提升。随后调用看板原生 `run`，卡片进入 Running，执行会话可从卡片打开。
- **记忆**：结算后写入该成员 `agent` 作用域的 `episode`（含 taskId、标题、结果、摘要、会话 id）；派发时读取最多 6 条相关记忆注入提示。可在记忆页删除。
- **人类控制页**：`GET /marshal-superagent`（本机浏览器打开）可改默认 agent、开关、根卡策略、记忆条数、标签前缀，并可人工补派手机/远端建的卡。配置与补派只接受本机同源浏览器请求；agent 的模型工具是只读的。
- **只读工具**：`marshal_superagent action=status | agents | reconcile`。`config`/`dispatch` 不再暴露给模型调用。
- **状态与设置**：`~/.dsh-marshal/superagent/settings.json` 与 `state.json`。

- **健康检查**（本机）：`GET /marshal-superagent/health`，状态 `GET /marshal-superagent/api/status`。
- **不覆盖**：不改第三方看板/智能体源码；不自动确认权限；不做远端 GUI 自动触发。看板换 action 端点时 hook 自动失效（不误触发），需要重新接入。
- **回退**：重新安装上一版 tarball；删除 `~/.dsh-marshal/superagent/` 即清空派发记录。client bundle 里的 hook 由 `client/superagent-hook.js` 追加生成；重建 bundle 后运行 `npm run build:superagent-hook` 重新追加（测试会检查）。
