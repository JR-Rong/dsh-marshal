# 验收记录 · v0.3.2（Android Origin 403 修复）

记录时间：2026-11-18 18:35
适用：Android 0.3.1 用户反馈「手机连接提示 401，然后退出」

---

## 一、根因

Hub 对令牌接口校验来源：无 Origin 或 Origin 等于 publicOrigin 才放行；其它来源直接 403。

真 Hub 实测（同一有效 dashboardToken，GET /marshal/api/devices）：

```
origin= (none)                  -> 200
origin= https://localhost       -> 403 forbidden
origin= capacitor://localhost   -> 403 forbidden
origin= http://localhost        -> 403 forbidden
origin= https://hub.example.com  -> 200
```

Android WebView（androidScheme=https）的 Origin 是 **https://localhost**。0.3.1 的设备/会话请求走 WebView fetch，原生栈带上了这个 Origin，所以被 Hub 判 403；App 把它显示成「Hub 拒绝了管理令牌/连接」。登录 ticket 请求用的是 CapacitorHttp 显式 Origin，反而可能成功；两相错位，用户看到 401/拒绝后 App 回到设置页，像“退出”。

---

## 二、修复（0.3.2）

1. **所有 /marshal/api/* 走原生 CapacitorHttp**（仅 native）：显式发送 `Origin: <Hub origin>`，不再让 WebView 的 `https://localhost` 混进去。
2. **403 单独提示**：「Hub 拒绝了 App 的来源（403）」而不是笼统的 401。
3. **同一 ticket 判重**：冷启动 `getLaunchUrl` + `appUrlOpen` 可能重复送同一张 ticket；用非加密指纹写 localStorage，24 小时内同票只处理一次，避免第二次 401。
4. 版本 0.3.2 / Android versionCode 5 / iOS build 5；浏览器 fetch 路径不变，UI 冒烟不受影响。

---

## 三、验证

| 项 | 结果 |
|---|---|
| 类型检查 | 通过 |
| 单元测试 | **51/51**（新增 ticketFingerprint） |
| UI 冒烟 | 15 图全过，pageErrors [] |
| Hub Origin 复现 | localhost → 403；精确 Origin → 200 |
| APK | 0.3.2 / versionCode 5 |
| iOS | 0.3.2 / build 5（模拟器包，复用原生壳） |

说明：0.3.2 的原生 CapacitorHttp 换票/设备请求未在真机复测（本机无 adb 设备）；Hub 侧来源规则与登录请求已在真 Hub 验证。

---

## 四、安卓安装与使用

```bash
adb install -r dsh-marshal-mobile/artifacts/dsh-marshal-mobile-0.3.2-debug.apk
```

1. 装 **0.3.2**（不要继续用 0.3.1）；
2. 电脑调度官 →「跨设备」→「重新连接」左边「📱 手机连接」；
3. 点「刷新二维码」，**60 秒内只扫一次**；
4. 若仍失败，请插 USB 跑 `adb logcat | grep -i -E 'marshal|capacitor|fatal'` 抓日志。

---

## 五、产物

```
artifacts/dsh-marshal-mobile-0.3.2-debug.apk
sha256 7bcdbf27f1e40e1ca668d3c143d09c725c922971269fa9c32c0100d83548909b

artifacts/dsh-marshal-mobile-0.3.2-ios-simulator.zip
sha256 1e6873ad3fd6c63876f9b0b3a83d6f2c237972b9993d5d93adc6bf5ecb28aaf6
```
