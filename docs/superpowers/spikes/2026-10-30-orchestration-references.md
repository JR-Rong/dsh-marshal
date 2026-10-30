# DSH 编排插件参考调查

日期：2026-10-30
状态：公开仓库、源码和发布记录调查；未安装插件，未运行兼容性或真实 agent 测试
用途：[讨论组 D1 设计](../specs/2026-10-30-marshal-discussion.md) 的选型依据；不是依赖引入决定

## 1. 结论与证据范围

优先参考社区 **dsh-agent-teams** 的成员、投递与调度机制，并对照官方 **experimental Agent Team** 的原生会话生命周期。已找到可用的 DSH 内部协作实现，但本次检查的项目都不能直接证明支持跨机器、独立 Codex/Claude runtime 的讨论组。模型 provider 多样性不等于 agent 平台互通。

“较成熟”仅指已有版本发布、实现与兼容性验证记录；不等于本项目已验证稳定。dsh-marshal 的现有接缝基线为 DSH `f3803c9697` / `0.2.2-alpha.2`，必须重新验证候选插件与该版本或选定升级版本的组合，不能由宽松 peerDependencies 推断兼容。

| 候选 | 核对依据 | 可参考核心 | 不能直接沿用的边界 |
|---|---|---|---|
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | `0.1.28`，main `3331b903f0e954d59ac69be1a75fd4fd7e1de20e`；源码、README、compatibility.json、发布记录 | captain/member、按收件人投递、attempt 代次过滤、事件驱动调度、状态与生命周期分离 | DSH 内部子 agent；磁盘收件箱/工作区正文、自动重试失联任务、默认工作工具不符合本项目讨论范围 |
| [官方 Agent Team](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447/packages/experimental/agent-team) | master `ce7073d51254c26cd63b22a60835b8f948deb447`；也核对基线 `f3803c9697` 的 README | roster、成员身份、inbox、task CAS、状态投影与 dispose | experimental、同一共享工作区、不支持跨进程协作；依赖原生持久会话，不能当作无正文持久化的跨机总线 |
| [官方 workflow](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447/packages/workflow/workflow) | 同一官方 commit 的 README | start/result/cancel/dispose，有界 parallel/pipeline 的调用组织 | 面向脚本流程；不是长期群聊。调用者仍负责清理，不应为固定讨论轮次引入任意模型生成 JS 执行面 |
| [dsh-swarm-scheduler](https://github.com/SadshiKoro/dsh-swarm-scheduler) | 当日仓库 README；自述 experimental beta 0.x，未做版本兼容实测 | worker 配额、原子 claim、依赖和任务状态 | 执行任务池且依赖官方实验 Agent Team；本轮只作补充阅读，不作为首版核心依赖 |

## 2. 主要参考的具体机制

### 2.1 社区 dsh-agent-teams

[0.1.28 发布记录](https://github.com/NanmiCoder/dsh-agent-teams/releases/tag/v0.1.28)与 [compatibility.json](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/compatibility.json)给出了宿主版本验证信息；矩阵推荐 `0.2.1-rc.2`，包含 11 个宿主版本，但未覆盖本项目的 `0.2.2-alpha.2`。这些是维护者记录，不是本轮执行结果，也不外推为所有 provider、桌面宿主或用户数据迁移均已验证。

- [mailbox.ts](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/src/mailbox.ts)：检查 sourceAttemptId、任务归属与当前代次后才接纳消息；实际进入模型步骤后才推进已读，值得借鉴“收到”和“已处理”分离。
- [scheduler.ts](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/src/scheduler.ts)：基于 idle/running 状态边沿调度与 claim，限制依赖输出体积；可借鉴有界分发和旧 attempt 隔离。
- [README](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/README.md)：provider/model 路由发生于 DSH 子 agent，不能称作接入独立 Codex CLI 或 Claude SDK。其 `.agent-teams` 磁盘消息和冷恢复重试也不能直接继承为 marshal 行为。

上述模块使用 DSH 宿主上下文，包没有将它们作为通用编排引擎公开导出。首选参考边界与状态机；能否依赖公共 API 或抽取最小模块，在 D1-T00 实测后决定。当前不复制源代码、不增加 npm 依赖。该仓库 [MIT LICENSE](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/LICENSE)已核对；将来若复制代码须保留许可证与版权说明，并记录固定来源版本。

### 2.2 官方 Agent Team 与 workflow

[Agent Team README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/experimental/agent-team/README.md)明确限定同进程、共享工作区；`send` 的 inboxMessageId 只证明接纳，不证明模型已处理或已刷盘。它还提供成员上限、消息字节上限、任务 CAS 与恢复记录。可参考这些生命周期和确认边界，不能把 task 文件提示当作锁，也不能假设显式重发已有幂等保证。

[Agent Team profile](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/experimental/agent-team-profile/README.md)默认关闭，启用会调整宿主 subagent 工具与控制路径。因此不能为了讨论组直接挂载整个 profile；DSH 适配路径应先验证窄接口及其工具禁用能力，不改变已有工作会话配置。

[workflow README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/workflow/workflow/README.md)可作为取消和资源归属参考；已接纳 run 的生命周期仍由调用者负责。讨论组用固定轮次调度即可，首版不需要 DAG 工作流编辑器或任意脚本执行。

## 3. 采用与不采用

采用：显式 roster、服务端身份、消息/轮次/成员代次、接纳与完成分离、可取消的有界调度、故障隔离、版本兼容报告。

不采用：自动创建工作任务并执行、群成员决定扩大权限、无限互相唤醒、未知结果自动重发、默认磁盘正文 inbox、为接入群聊改变整个宿主 profile。跨机认证、隐私、命令幂等及适配器边界继续使用 marshal 公共契约，不再另建一条旁路消息总线。

选型关闭条件：D1-T00 给出固定版本的接口/工具隔离/退出/重复投递实测；证据不足则保留“参考设计”结论。安装成功、仓库测试数量和发布存在均不能代替本项目的 G01–G12 验收。
