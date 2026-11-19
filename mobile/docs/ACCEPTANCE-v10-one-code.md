# 验收记录 · v0.6.0（一个码：Hub + DSH 工作台）

记录时间：2026-11-18 21:25
反馈：手机端仍报「Hub 拒绝了连接」；要求一个码把所有内容一次配好。

---

## 一、根因（臣的错）

1. 桌面「手机连接」刚改成**一个码** `marshal://setup?payload=...`；
2. 但手机装的是 **0.5.0 APK**，它还不认识 setup 格式，把 setup 当旧 Hub 链接处理，令牌/参数对不上，随后报「Hub 拒绝」；
3. 桌面当前正在跑的窗口也还在用**旧客户端**（弹窗标题/文案仍是旧的），必须重启 DSH 一次才会加载新弹窗。

所以不是 Hub 令牌坏：令牌对 `/devices` 仍是 200；是版本与客户端未对齐。

## 二、一个码里有什么

`marshal://setup?payload=<base64url(JSON)>`，JSON：

```json
{
  "v": 1,
  "hub": "https://hub.example.com",
  "hubToken": "<64 位>",
  "ticket": "<60 秒群聊 ticket，可选>",
  "bridge": "ws://127.0.0.1:<端口>/ios/v1",
  "bridgeToken": "<30 秒 DSH 配对令牌>"
}
```

桌面弹窗生成时同时取 Hub 换票口与 `/remote-bridge/pair/token`；DSH 令牌过期前 5 秒自动刷新二维码。

## 三、验证

### 桌面一个码生成（mock）

```
status 一个码：Hub + DSH 工作台；DSH 配对剩余 30 秒；群聊 ticket 60 秒
qr 1
payload { hub: 'https://hub.example.com', hubTokenLen: 64, ticketLen: 43, bridge: 'ws://127.0.0.1:<port>/ios/v1', bridgeTokenLen: 43 }
bridge token stripped true
errors []
```

### 手机扫一个码（假相机 + 真二维码 + 真桥）

```
scanner open
workbench 已连接 · 64 会话 · 6 任务
hubConfig saved true tokenLen 64 hub https://hub.example.com
bridge saved true host 127.0.0.1:<port>
closed 0
errors []
```

即扫一次：Hub 配置保存、DSH 设备令牌保存、工作台直接连上。另有单独的 DSH 扫码/主题/UI 冒烟全过。

## 四、需要机主完成的两步

1. 装 **0.6.0 APK**（0.5.0 不认识一码，必换）。
2. **重启一次桌面 DSH**（当前窗口还是旧客户端；重启后「手机连接」才显示“一个码”）。
3. 打开「跨设备」→「手机连接」→ 手机「扫码配对」扫这一张。

若 DSH 地址是 `127.0.0.1`，安卓 USB 需 `adb reverse tcp:<二维码端口> tcp:<二维码端口>`；同一 Wi-Fi 需 DSH 局域网/隧道地址（本地桥默认只监听回环）。

## 五、产物

```
artifacts/dsh-marshal-mobile-0.6.0-debug.apk
sha256 ec3bde2f53d95819a80f5ee2e93f06802e034c7c48d36c76564ae5d9cbe194ad

artifacts/dsh-marshal-mobile-0.6.0-ios-simulator.zip
sha256 10875cb615fc03082e3f6c56595dfffa6b9a3069872a9340a0800768e0eadda7
```

说明：桌面注入文件已更新；当前运行窗口未重启，故仍是旧弹窗（臣已核）。重启后加载一个码。
