# 调度官「手机连接」按钮 · 验收

当前二维码只有 `marshal://pair?code=…&hub=…`。注入脚本不再写入管理令牌。配对码由已登录 Hub 的会话领取，60 秒有效，到期前 5 秒更换。下面的 2026-11-18 记录描述的是旧的令牌二维码，不要再按那个格式生成。

时间：2026-11-18 17:55
位置：调度官「跨设备」页右上角「重新连接」左边（仅该页显示，离开即移除）

## 一、改了什么

- 在已安装的调度官客户端注入一个**仅跨设备页**的按钮：
  `~/.dsh-marshal/install-20261031/plugin-ui/client/index.js`
- 点击后弹出二维码弹窗；二维码内容为：
  `marshal://open?hub=<Hub>&token=<dashboardToken>&ticket=<60 秒 ticket>`
- Hub/令牌从本机配置注入；ticket 由本机已有的 `/marshal/account/login` 现换。
- 服务端一行未改，不需要重启 DSH；按钮已在本机界面热加载出现。
- 手机端需 **0.3.2 或更新版本**：0.3.1 安卓会把 WebView Origin 带给 Hub 而被 403；0.3.2 已改原生 CapacitorHttp + 精确 Origin。
- 首次注入自动备份：`client/index.js.bak-phone-connect`；注入文件权限 0600。

## 二、实测

真 DSH 界面（CUA）：

- 跨设备页 AX 树出现 1 个 `AXButton "📱 手机连接"`，紧挨在 `AXButton "重新连接"` 左边；切到「会话」后该按钮为 0 个（会话页自己的「重新连接」不会误挂）；
- 常驻胶囊已移除，其它页面不再出现；
- 点击后弹窗出现，状态为 `已生成；群聊 ticket 剩余 60 秒`；
- `刷新二维码`、`复制配对链接`、`关闭` 均在；
- 关闭后弹窗移除；再次点击可重新生成。
- **未对二维码截图/外传**（二维码含令牌）。

无头浏览器（`dsh-marshal-mobile/scripts/test-phone-connect-inline.mjs`，哑变量）：

```
button ok: 📱 手机连接
{"title":"手机连接","status":"已生成；群聊 ticket 剩余 60 秒","svg":1,"errors":[]}
after refresh: 已生成；群聊 ticket 剩余 60 秒 svg 1
closed: 0
```

## 三、文件

| 文件 | 用途 |
|---|---|
| `desktop-pairing/marshal-phone-connect.js` | 注入模板（QR 库/Hub/令牌占位） |
| `desktop-pairing/inject-phone-connect.mjs` | 重新注入 / --revert / --dry-run |
| `desktop-pairing/README.md` | 使用、回滚、安全说明 |
| `dsh-marshal-mobile/scripts/test-phone-connect-inline.mjs` | 无头浏览器冒烟（跨设备挂载/离开移除） |

## 四、重注入与回滚

令牌轮换或插件升级后：

```bash
node desktop-pairing/inject-phone-connect.mjs
node desktop-pairing/inject-phone-connect.mjs --revert
node desktop-pairing/inject-phone-connect.mjs --dry-run
```

## 五、安全

二维码含长期管理令牌，等同 Hub 管理员凭据；客户端文件也含该令牌（0600）。只给自己的手机扫，扫完关闭；不要把二维码截图发人；泄露请轮换 `dashboardToken` 后重注入。