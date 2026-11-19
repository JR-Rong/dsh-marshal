import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 调度官手机端壳配置。
 *
 * 关键约束：
 * - 本应用只承载「客户端」：没有 server 角色、没有入站监听，Hub 页面在应用内打开。
 * - allowNavigation 放行外部地址，是为了让 Hub 控制台在应用内直接加载（同源 Cookie / SSE 才可用）。
 * - CapacitorHttp 打开后，外壳自身的设备/会话查询走原生网络栈，不受 CORS 限制。
 */
const config: CapacitorConfig = {
  appId: 'com.rongjunrui.marshal.mobile',
  appName: '调度官',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['*'],
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
  },
  android: {
    // DSH 远程桥 /ios/v1 在局域网/USB adb reverse 下是 ws://；WebView 源是
    // https://localhost，必须允许混合内容才能连本机桥。Hub 仍走 https。
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: { enabled: true },
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#151719',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#151719',
    },
  },
}

export default config
