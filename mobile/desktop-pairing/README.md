# 调度官面板「手机连接」按钮

二维码只有 Hub 地址和一个 60 秒一次性配对码：`marshal://pair?code=…&hub=…`。到期前 5 秒自动更换。脚本不写入管理令牌、群聊票或桥令牌。

配对码由已登录 Hub 的页面 `POST /marshal/api/pairing` 领取，请求要带 CSRF。节点凭证不能发配对码。如果这个页面没有 Hub 会话，请打开 Hub 的「手机配对」页确认后再扫。

| 文件 | 用途 |
|---|---|
| `marshal-phone-connect.js` | 注入的按钮和二维码 |
| `inject-phone-connect.mjs` | 只注入脚本，不读 dashboardToken |
| `test-one-qr.mjs` | 无头浏览器检查二维码不含令牌 |
