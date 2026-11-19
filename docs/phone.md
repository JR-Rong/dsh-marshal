# 手机控制器

手机只连 Hub，使用 `Authorization: Bearer mph1.<凭证>`。节点上报看板、记忆和花名册使用 `Authorization: Bearer mnd1.<节点凭证>`。节点凭证不能读会话、历史、事件流或群聊。

配对二维码只有 Hub 地址和一个 128 位、60 秒、一次性的码：`marshal://pair?code=…&hub=…`。重新配对同一安装会作废旧凭证。未兑换的码最多 8 个。

看板修改发给拥有该看板的节点，带 `baseRevision`。修订不一致返回 409。节点只有在确实读到看板时才带 `read: true` 上报；省略的字段不会被空数组盖掉。

## 推送

Hub 从设备表旁边的 `push.json` 读钥匙，文件权限应是 0600。缺文件、占位符或厂商非 2xx 都记为失败，不会标成已送达。只对审批、提问，以及手机点过关注的会话开始/结束各发一次，并做去重和每分钟 8 条的限制。

```json
{
  "apns": { "keyId": "PLACEHOLDER", "teamId": "PLACEHOLDER", "bundleId": "com.rongjunrui.marshal.mobile", "keyPath": "/etc/marshal/AuthKey.p8" },
  "fcm": { "projectId": "PLACEHOLDER", "clientEmail": "PLACEHOLDER", "privateKeyPath": "/etc/marshal/fcm.json" },
  "huawei": { "appId": "PLACEHOLDER", "clientId": "PLACEHOLDER", "clientSecretPath": "/etc/marshal/huawei-secret" }
}
```

把 `PLACEHOLDER` 换成真实值，并把钥匙放到 `keyPath` 指的文件。不要把钥匙提交进仓库。FCM 走 HTTP v1：`https://oauth2.googleapis.com/token` 换访问令牌，再 `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`。华为走 `https://oauth-login.cloud.huawei.com/oauth2/v3/token` 和 `https://push-api.cloud.huawei.com/v1/{appId}/messages:send`。手机上的 Live View 先调 `com.huawei.hms.liveview.LiveView`，类不在时改用常驻通知。

桌面「手机连接」向 `/marshal/api/pairing` 领取二维码。到期前 5 秒用上一张码作为 `replace` 再领一张，Hub 会作废同一账号还没使用的旧码。二维码正文只有 `marshal://pair?code=…&hub=…`。

## DSH 还要补的接口

见 `docs/dsh-phone-api.md`。节点只在 `taskBoard.capabilities()`、`memory.readPhone`、`roster.list` 真的存在时调用。缺方法就省略那一面，不上报空数组。
