# 调度官面板「手机连接」按钮

## 功能

> 本按钮现在是**一个码**：Hub 地址/令牌/群聊 ticket + DSH 工作台配对全在同一个二维码里，手机 0.6.0 扫一次全配好。DSH「配对 iPhone」保留作只配工作台的后备。

在调度官「跨设备」页右上角「重新连接」左边加一个「📱 手机连接」。**只在跨设备页挂载，离开该页即移除**，不会常驻其它界面。点击弹出二维码：

- 自动读本机 `hub.json` 的 `dashboardToken` 与 node 配置的 `hubUrl`；
- 调本机已有 `/marshal/account/login` 换 60 秒群聊 ticket；
- 调 `/remote-bridge/pair/token` 取 30 秒 DSH 配对令牌与地址；
- 生成 `marshal://setup?payload=<base64url(JSON)>` 的一个码，JSON 内含 Hub、Hub 令牌、群聊 ticket、DSH 地址、DSH 令牌；
- 刷新、复制配对链接、关闭；30 秒令牌过期前 5 秒自动刷新二维码；手机端需 **0.6.0 或更新版本**（0.5.0 不认识 setup 一码格式）；
- 桌面客户端文件更新后，**正在跑的 DSH 需重启一次**才会加载新弹窗。

服务端一行未改；只用已安装插件的现有换票口。

## 文件

| 文件 | 用途 |
|---|---|
| `marshal-phone-connect.js` | 注入模板（含 QR 库占位、Hub/令牌占位） |
| `inject-phone-connect.mjs` | 读取本机配置并注入/回滚/干跑 |
| `test-one-qr.mjs` | 无头浏览器验一个码的 Hub/DSH/ticket 载荷 |