# 手机控制端

手机不保存 DeepSeek 密码，也不保存平台 token。已登录的电脑打开 `/marshal/pair`（需要账号会话），出示一次性配对码。手机扫码后拿到自己的设备凭证；Hub 只存 SHA-256。可以单独撤销。别的账号的码不能在这台 Hub 上使用。

管理令牌 `dashboardToken` 仍可用于高级登录，手机默认不走这条路。

## 手机能做什么

- 出现在设备列表里，身份是 `controller`，自己不跑 agent。
- 对花名册里的 agent 新建会话、发消息、回答提问、中断。审批只提交「这一次」的选项。
- 任务板可查看、新建、修改和移动。
- 记忆只读。节点把记忆推上来，手机不能写。
- 群聊可以读历史、发消息。
- 登记 APNs / FCM / 华为推送 token。审批、提问、运行开始和结束会尝试推送。

## 推送密钥

写在 Hub 配置的 `push` 里，值是文件路径或账号标识，不要把私钥提交到仓库。含 `PLACEHOLDER` 或空字符串的项视为未配置，Hub 不会发出去。

```json
{
  "push": {
    "apns": {
      "keyId": "PLACEHOLDER",
      "teamId": "PLACEHOLDER",
      "bundleId": "com.rongjunrui.marshal.mobile",
      "keyPath": "/绝对路径/AuthKey.p8"
    },
    "fcm": {
      "projectId": "PLACEHOLDER",
      "clientEmail": "PLACEHOLDER",
      "privateKeyPath": "/绝对路径/firebase-adminsdk.json"
    },
    "huawei": {
      "appId": "PLACEHOLDER",
      "clientId": "PLACEHOLDER",
      "clientSecretPath": "/绝对路径/huawei-secret.txt"
    }
  }
}
```

需要机主自己准备：

- Apple Developer 账号、APNs Auth Key，以及把 `mobile/ios/LiveActivity` 加进 Xcode 的 Widget Extension，才能在灵动岛显示进行中的任务或待审批。
- Firebase 项目的服务账号，给非华为 Android 发 FCM。
- 华为 AppGallery Connect 的应用和推送凭据。没有 GMS 的华为手机走华为推送；实况窗在 HMS Live View 可用时使用，否则退回一条持续通知。

节点用自己的设备 token 把任务、只读记忆和花名册 POST 到 `/marshal/api/tasks`、`/marshal/api/memory`、`/marshal/api/roster`。
