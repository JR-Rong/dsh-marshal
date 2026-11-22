# 验收记录 · v0.3.1（一键配对二维码）

记录时间：2026-11-18 17:20
定位：手机端 **node 形态**——自绘界面、出站直连 Hub、不承载 hub、不监听端口。

---

## 一、本版改了什么

| 改动 | 落点 |
|---|---|
| 电脑端一键配对 | 新增 npm run onboard：自动读 Hub 地址 + dashboardToken，默认顺带 60 秒群聊 ticket |
| 二维码/深链 | marshal://open?hub=...&token=...&ticket=...；900px PNG 写 /tmp/marshal-onboard.png（0600） |
| 手机自动配置 | 深链带 token 时保存 Hub+令牌并 enterApp；带 ticket 时再登录群聊 |
| 粘贴兜底 | 首次设置页新增「一键配对链接」；设置页群聊输入框也接受完整 marshal:// 深链 |
| 应用锁 | 锁屏时暂存整条深链，解锁后重放，深链不能绕过锁 |
| 令牌保护 | 终端不打印 token 全文；只打印长度/前缀；深链复制到剪贴板并提示勿外传 |

---

## 二、结论

| 项 | 结果 |
|---|---|
| 类型检查 | 通过 |
| 单元测试 | **50/50**（新增 parseOnboardLink 1 项） |
| UI 冒烟 | 15 图全过，pageErrors [] |
| 一键配对脚本 | 通过：Hub=hub.example.com、token len=64、ticket len=43、QR 0600 |
| 深链导入（浏览器） | 通过：粘贴 marshal:// 链接 → 自动配置 → 设备列表出现 |
| 真机扫码 | 未复测（本机无 adb 设备；iOS 模拟器运行时版本不匹配） |

---

## 三、一键配对怎么用

```bash
cd dsh-marshal-mobile
npm run onboard -- --hub https://hub.example.com
```

输出：

```
一键配对二维码: /tmp/marshal-onboard.png
Hub       : https://hub.example.com
管理令牌  : len=64 prefix=<redacted>（不打印全文）
群聊 ticket: 已附带（60 秒，扫晚了只完成 Hub 配对）
深链      : 已复制到剪贴板（含令牌，勿外传）
```

手机相机扫 PNG → 打开调度官 → 自动填 Hub/令牌并连接；若 ticket 未过期，同时登录群聊。
扫不动/相机不认自定义 scheme 时，把深链发到手机打开，或在首次设置页「一键配对链接」粘贴。

只配 Hub + 令牌、不带群聊 ticket：

```bash
npm run onboard -- --no-ticket
```

只重登群聊（已有配置）：

```bash
npm run ticket -- --hub https://hub.example.com
```

---

## 四、安全与边界

1. **二维码含长期管理令牌**：等同 Hub 管理员凭据。只给本人手机扫；扫完删除 PNG；泄露请轮换 dashboardToken。
2. **剪贴板/终端**：深链含令牌，脚本默认不打印全文，只复制到剪贴板；--print-link 才会打印，慎用。
3. **ticket 60 秒**：二维码默认附带；扫晚了只会完成 Hub 配对，群聊需重新 npm run ticket。
4. **应用锁**：锁屏时整条深链暂存，解锁后重放，不会绕过锁。
5. **真机扫码未复测**：本机无 adb 设备；浏览器侧粘贴导入与脚本生成已验，原生深链由 Capacitor App 插件处理。
6. **iOS 全量重编译仍受 SwiftPM 缓存沙箱限制**；本版原生代码未改，复用已编译壳 + 新 Web 资源。

---

## 五、双端产物

### Android

```
artifacts/dsh-marshal-mobile-0.3.1-debug.apk   4.0 MB
sha256 1f2817d8d1da9194a7b013a859e7046790b41cf51563b5e096c8af0ca8ff078e
versionCode 4  versionName 0.3.1
```

### iOS

```
artifacts/dsh-marshal-mobile-0.3.1-ios-simulator.zip   2.0 MB（解压 6.7 MB）
sha256 3fd2804d92e4f61a48667937beb17a3acb8a16ba23c2e79336a3249804c9b79d
CFBundleShortVersionString 0.3.1
CFBundleVersion 4
```

---

## 六、复现

```bash
npm test
npx tsc --noEmit
node scripts/ui-smoke.mjs
npm run onboard -- --hub https://hub.example.com
npm run onboard -- --no-ticket
```
