# 验收记录 · v0.5.0（扫码配对 / 配对页重做）

记录时间：2026-11-18 21:10
反馈：配对页杂乱；要求页面直接给「扫码配对」，点开相机，对电脑「跨设备」二维码扫。

---

## 一、改成什么样

- **主屏只留一个主按钮**：「扫码配对」。点开直接进相机取景，不再先看一屏说明和输入框。
- **相机识别两种码**：
  - Hub「手机连接」：`marshal://open?...` → 自动配 Hub；
  - DSH「配对 iPhone」：`{token,url}` 或 `ws(s)://...` → 自动配 remote-bridge，直接进工作台。
- **手动粘贴收进「高级」折叠**：不用的人永远看不到；相机不可用/权限被拒时才展开。
- 首次启动页：扫码卡片 + 主题色 + 「手动配置（高级）」，不再堆 Hub 表单一屏。
- 工作台配对页：📷 图标 + 「扫码配对」+ 一行提示 + 「高级」折叠，页面干净。

截图：
- `docs/screenshots/01-setup.png`（首启，扫码主按钮）
- `docs/screenshots/workbench-pair.png`（工作台配对页）
- `docs/screenshots/workbench-0.5.0-scan.png`（扫码成功后进工作台）

## 二、扫码真桥验证

用同一套 UI，把相机换成一个画着**真 DSH 配对二维码**的 canvas 流（Playwright 假摄像头），点「扫码配对」：

```
scanner open
scanned and paired: 已连接 · 64 会话 · 6 任务
agents 10
closed 0
errors []
```

即：相机取景 → jsQR 解码 → 分类为 DSH 码 → P-256 配对 → 自动进工作台。验证链路与真机一致，只是相机源换成 canvas。

## 三、实现

- `src/lib/scanner.ts`：全屏相机 overlay，`getUserMedia` + `jsQR` 解码；成功后停轨道、移除 overlay、回调原文；失败保留错误卡。
- `src/lib/bridge.ts`：`classifyPairing()` 区分 Hub / DSH / unknown。
- `src/app.ts`：首启/首页「扫码配对」；Hub 码走 `handleDeepLink`，DSH 码 `pairBridge` + 存设备令牌 + 进工作台。
- `src/bridge/workbench.ts`：工作台配对页扫码；扫到 Hub 码关闭工作台交给 App。
- 权限：Android 加 `CAMERA`，用 Capacitor WebView 的 `onPermissionRequest` + `@capacitor/camera` 请求；iOS Info.plist 加 `NSCameraUsageDescription`。

## 四、回归

| 项 | 结果 |
|---|---|
| 扫码配对（假相机 + 真桥） | 通过（64 会话 / 10 智能体） |
| 工作台手动配对 | 通过（64 会话 / 6 任务） |
| 主题 | 蓝 / 紫 / 灰 + 记住，通过 |
| UI 冒烟 | 15 图通过，pageErrors [] |
| 单元测试 | 51/51 |
| Android | 0.5.0 / versionCode 8；APK 含 CAMERA 权限、CameraX、jsQR |
| iOS | 0.5.0 / build 8（模拟器包） |

真机相机未在本机复测（无 adb 设备）；Android WebView 的相机权限回调已在 Capacitor 源码确认会申请 CAMERA 并 grant VIDEO_CAPTURE。若真机黑屏/拒绝，请抓 `adb logcat`。

## 五、产物

```
artifacts/dsh-marshal-mobile-0.5.0-debug.apk
sha256 22310bb0fc9ecb92d1d90f306d45ec401726970d375d22eb0bf164054ce26d0d

artifacts/dsh-marshal-mobile-0.5.0-ios-simulator.zip
sha256 d738d18a3c2520b82e744f1d3f7fe811873978420b4f993b2af5da9927453cfe
```

## 六、两种二维码别扫错

- 要 **Hub 会话/群聊** → 扫「📱 手机连接」；
- 要 **智能体/会话内容/任务看板** → 扫「配对 iPhone」。
App 会自动识别；扫错也能配对，只是进的是对应模式。
