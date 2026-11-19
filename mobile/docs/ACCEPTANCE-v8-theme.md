# 验收记录 · v0.4.1（主题色 / 去绿）

记录时间：2026-11-18 19:45
目标：撤掉绿色；默认 DeepSeek 蓝，另给 Codex 紫、灰，并可在设置里选、记住。

---

## 一、主题实现

- 主题变量：`src/styles.css` 的 `--accent / --accent-strong / --accent-soft / --accent-border / --accent-ink / --accent-glow / --accent-gradient`。
- 三套：默认 blue；`html[data-theme="purple"]`；`html[data-theme="gray"]`。
- 选择器：`src/lib/theme.ts`，localStorage 键 `dsh-marshal-theme`；`index.html` 在首屏前先应用，避免闪绿/闪蓝。
- 设置页与首次启动页都有「主题色」卡；工作台 CSS 也改用同一批变量，覆盖 DSH 工作台的 chip/nav/按钮/用户消息。

## 二、实测（Playwright）

```
default blue #5b7cfa
purple #a78bfa
gray #c9d1d9
reload gray #c9d1d9
blue #5b7cfa
errors []
```

说明：切换即生效、刷新后仍记住、切回蓝色正常；页面无报错。

## 三、图标与启动图

- Android：`ic_launcher.png / ic_launcher_round.png / ic_launcher_foreground.png` 全量从绿改蓝；自适应背景 `ic_launcher_background` 改为 `#5B7CFA`；启动图 `splash.png`（横竖各密度）改蓝。
- iOS：`AppIcon-512@2x.png` 与 `Splash.imageset` 源资产改蓝；模拟器包复用已编译壳，真机/重编时生效。
- APK 内 `res/mipmap-xxxhdpi-v4/ic_launcher.png` 已抽取核对为蓝。
- `dist` 与 `ios/App/App/public` 已无 `#83c7b0 / #1d2b27 / #2c4a40` 旧绿。

## 四、测试与构建

| 项 | 结果 |
|---|---|
| 主题测试 | 通过（上表） |
| 单元测试 | 51/51 |
| UI 冒烟 | 15 图，pageErrors [] |
| 工作台真桥 | 仍通过（10 智能体 / 64 会话 / 6 任务；界面继承蓝） |
| Android | 0.4.1 / versionCode 7 |
| iOS | 0.4.1 / build 7 |

## 五、产物

```
artifacts/dsh-marshal-mobile-0.4.1-debug.apk
sha256 f88eb4f0585e97ee93e2280d6ca4b97486566eeea68f18233bb1d1346b8cc94b

artifacts/dsh-marshal-mobile-0.4.1-ios-simulator.zip
sha256 07b407d447ad3d9cee83bf433ae633edc3d4d2cf0d52bf3610be701c46c24bf8
```

截图：
- `docs/screenshots/07-settings.png`（设置页主题色三选）
- `docs/screenshots/theme-picker-blue.png`（首次启动页主题色）
- `docs/screenshots/workbench-0.4.1-blue.png`（蓝色工作台）

## 六、说明

- 主题只改界面强调色，不改内容；应用图标/启动图固定蓝，不随主题切换。
- 旧绿色已从手机端代码全量移除；桌面 DSH 自身主题不在此次范围。
