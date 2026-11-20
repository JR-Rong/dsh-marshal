# 安装 dsh-marshal

## 结论先说

**不要从仓库根目录安装。** 根 `package.json` 指向历史 TypeScript 核心，`prepare` 构建的是旧的 `src/`，不包含智能体/群聊/跨设备代码。

当前可安装产物只有：

- `plugin-build/dsh-marshal-0.2.0-agent-groups.11.tgz`（推荐，依赖会由 pnpm 安装）
- 或 `plugin-build/` 目录（需要先在那里执行 `pnpm install --prod`）

## 依赖（务必先看）

marshal 本身是一个 DSH 插件，下面两个是**同 profile 的 DSH 插件依赖**，不是 marshal npm 包里的普通 dependency。请先安装它们，再启用 marshal：

| 依赖包 | 是否必需 | 作用 |
|---|---|---|
| `@linxin666/dsh-agents` | **必需** | 提供 `/dsh-agents` 后端、智能体库、成员会话；缺它时「智能体」「群聊」「跨设备」都会提示后端未挂载 |
| `@linxin666/dsh-client-ui-task-board` | **可选** | 提供完整原生任务看板；缺它时 marshal 使用内置轻量看板（基础建卡/运行/删除） |

安装命令（有 `dsh` 的 CLI 环境）：

```bash
dsh plugin --profile desktop add @linxin666/dsh-agents
dsh plugin --profile desktop add @linxin666/dsh-client-ui-task-board
```

Desktop 没有 `dsh` 命令时：打开 **Plugins → Add plugin**，搜索并安装这两个插件，然后重启 DSH。

> 这两个包是 DSH 插件，不是 npm 上的普通库；只装 marshal tarball 不会自动带入它们。

## 其他前置条件

- DeepSeek Harness 0.2.2 或更新版本；
- Desktop 自带 Node 24，不要用 PATH 里的 Node 22 去构建或运行插件。

## Desktop 安装（没有 dsh 命令）

1. 打开 DeepSeek Harness；
2. 左侧 **Plugins** → **Add plugin / 添加插件**；
3. 选择本仓库的 `plugin-build/dsh-marshal-0.2.0-agent-groups.11.tgz`；
4. 启用后重启 DSH；打开侧边栏 **调度官**。

Desktop 的插件管理器会做安装和链接；不需要也不保证有全局 `dsh` 命令。

## CLI 安装

如果当前环境有 `dsh`：

```bash
dsh plugin --profile desktop add "$(pwd)/plugin-build/dsh-marshal-0.2.0-agent-groups.11.tgz"
```

tarball 会由 pnpm 正常安装依赖（zod / ws / marked / entities）。不要用 `link:` 指到工作区目录：工作区一移动插件就坏，而且链接安装不会自动安装依赖。

## 从目录安装

```bash
cd plugin-build
pnpm install --prod
dsh plugin --profile desktop add "$(pwd)"
```

目录安装是 `link:`，后续移动/删除目录会让插件失效。长期使用请用 tarball 或把目录放到稳定位置（例如 `~/.dsh/plugins/dsh-marshal`）。

## 安装后自检

打开 **调度官**，或请求：

```text
GET /marshal/health
```

返回示例：

```json
{
  "ok": true,
  "name": "dsh-marshal",
  "version": "0.2.0-agent-groups.11",
  "capabilities": {
    "groups": true,
    "agents": true,
    "taskBoard": true,
    "taskBoardSource": "host",
    "crossGroups": true
  }
}
```

- `agents: false`：缺少 `@linxin666/dsh-agents`，或它没有挂载 `/dsh-agents` API；
- `taskBoardSource: "local"`：没有宿主 task-board，正在用内置轻量看板；
- `crossGroups: false`：当前 node 没有配置 hubUrl/token。

## 常见问题

### `Cannot find package 'zod'`

说明是 `link:` 安装，宿主只链接了目录，没有安装依赖。改用 tarball，或在 `plugin-build/` 执行 `pnpm install --prod` 后重新启用。

### `already-installed` / `unknown-plugin`

先移除旧 bundle，再重新添加：

1. Plugins 里找到 `dsh-marshal` / `include:dsh-marshal`；
2. Remove / 卸载；
3. 重新 Add plugin 选择 tarball。

旧的 `availability: missing` 通常来自工作区被移动/删除，必须移除后重装。

### 改了 lib 代码怎么重新加载

在 Plugins 里 disable → enable，或重启 DSH。没有单独的 reload 按钮时，这两步就是可靠路径。

### 桌面版没有 `dsh` 命令

用 Plugins → Add plugin。CLI 只适用于有 `dsh` 的环境；Desktop 的插件管理器和 CLI 不是同一个入口。

### Hub 地址

仓库里的默认值只是 `https://hub.example.com` 示例。真实地址、证书和 token 在首次设置页填写，不要提交到仓库。

## 已知边界

- `permission` 会保存到定义里，但 DSH 0.2.2 没有提供统一的宿主级强制；不要把它当成安全边界。
- 成员 `brief` 会在 dsh-agents 成员会话和 Agent 工作区普通会话中注入；编辑后下一回合生效。
- 智能体页依赖 `/dsh-agents`；缺失时页面会明确提示后端未挂载，而不是只抛 404。
