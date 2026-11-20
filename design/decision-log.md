# Decision Log · Marshal Mobile Node

## v0.1 — 2026-11-20（初稿待签收）
- **背景**：奉皇上旨意开发 Marshal 移动端 Node 应用（iOS + Android），要求以 node 形态运行、扫码连接目标设备并访问该设备及其关联 Hub、精致 Apple 风格、直接使用仓库现有图标（`plugin-build/icon.svg`）、双端真机测试。
- **调研结论**：
  1. 当前 `main` 分支尚未包含 `mobile/` 目录；远端 `origin/feat/mobile-one-code` 虽有早期 Capacitor 8 客户端，但其 UI 为暗灰极客风（非 Apple 风格）、图标为手绘「调」字（非仓库 `icon.svg`），且 Android 强依赖 JDK 21 + SDK 36。
  2. 本机环境为 Zulu JDK 17.0.19 + Android SDK 35 + Xcode 27.2（Swift 6.4.2），连接华为真机 `ALT-AL10`（Android 12，已装旧版 `com.rongjunrui.marshal.mobile` v0.7.5）与 `siyao的iPhone`（iPhone 14 Pro Max，iOS 27.2，当前 `developerMode: disabled`）。
  3. 线上 Hub（`https://123.57.223.115`）已开放 `/marshal/api/pairing`、`/marshal/api/pairing/redeem`、`/marshal/api/devices`、`/marshal/api/sessions`、`/marshal/api/discussions`、`/marshal/api/cross-groups/state` 等接口。
- **拟定方案**：起草 `design/frontend-guidelines.md` v0.1，待皇上确认视觉方向、技术底座/包名策略及 iOS 真机开发者模式与签名安排后立即推进原型、冻结与双端真机开发验收。

## v0.7.6 — 2026-11-20（Apple HIG 视觉与 Android 真机验收落地）
- **落地内容**：按 Apple HIG 双层材质、语义 Token、浅/深色跟随系统与仓库 `plugin-build/icon.svg` 同源图标完成 `mobile` v0.7.6 改造；63/63 单测与 TypeScript 检查通过，Android 华为真机（ALT-AL10）安装与明暗色实测通过，详见 `mobile/docs/ACCEPTANCE-v11-apple.md`。
