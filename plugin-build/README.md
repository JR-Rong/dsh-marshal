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

## 工单群

在 Marshal 「任务看板」里选择工作区建单，卡片会固定关联一个工单群。点击「工单群」可查看群消息、关单归档和重开。重试和同工作区改派会在原群追加运行批次。工单群日志是完整对话，工作区公共记忆存阶段交接和报告引用。旧卡片可以在首次打开时补绑已有工作区。

本机运行时，群正文保存到原设备的 task-rooms.sqlite。选择同工作区的跨设备 Agent 后，原设备会将完整历史分页转存到 Hub。Hub 确认序号完整后接管正文，原设备只保留工单关联和位置。接入同一 Hub 的设备必须绑定同一个账号，并登记相同的工作区 ID。远端节点还需要启用群聊讨论策略。工单归档可在获准设备的「工单群」里查看。

跨设备联动需要同时更新节点插件和安装包中的 standalone Hub。云端服务可用该安装包的 marshal-hub 入口，或继续指向其 lib/src/bin/hub.js。工单群正文随 Hub 存储目录备份。
