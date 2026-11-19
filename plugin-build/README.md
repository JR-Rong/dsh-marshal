# dsh-marshal plugin build

Self-contained installable build of the marshal plugin.

Install from the tarball in this directory:

- Desktop: Plugins -> Add plugin -> pick the .tgz;
- CLI: dsh plugin --profile desktop add /abs/path/dsh-marshal-0.2.0-agent-groups.2.tgz.

Required DSH plugins (install in the same profile first):

- @linxin666/dsh-agents (required for agents/groups/cross-device)
- @linxin666/dsh-client-ui-task-board (optional; full task board)

These are DSH plugins, not ordinary npm dependencies of marshal. Without
@linxin666/dsh-agents the health endpoint reports agents:false; without the
task-board plugin marshal uses its built-in lightweight board.

Do not install from the repository root. See INSTALL.md.

## 任务看板编排

在「调度官 → 任务看板」新建卡片，选择已绑定工作区的 Leader。可以指定模板、让 Leader 选择或跳过。内置开发交付、PR 对抗审查、报表与报告、技术调研与选型、故障排查。PR 审查自动执行，其他模板把计划交给 Leader 的常驻会话。

PR 审查支持 GitHub 和 Gitee PR 链接。节点需要启用工作区记忆、DSH 和已认证的 Codex，Codex 版本沿用 Agent 群聊的原生协议要求。私有仓库可在节点环境配置只读的 `DSH_MARSHAL_GITHUB_TOKEN` 或 `DSH_MARSHAL_GITEE_TOKEN`。选择运行后，节点按固定提交读取 PR 文本补丁，两位审查者各自审查并互相复核，Leader 汇总。交接和最终报告存进该工作区的 SQLite 记忆，卡片显示阶段、提交及报告。缺少完整补丁的文件会标出，文本补丁上限为 48 KiB。
