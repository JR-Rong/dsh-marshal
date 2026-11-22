import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 调度官手机端壳配置。
 *
 * 关键约束：
 * - 本应用只承载「客户端」：没有 server 角色、没有入站监听。
 * - 不放行任意外部导航，也不允许混合内容。Hub 请求走原生网络栈。
 */
const config: CapacitorConfig = {
  appId: 'com.rongjunrui.marshal.mobile',
  appName: '调度官',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
  },
  android: {},
  plugins: {
    CapacitorHttp: { enabled: true },
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#1F6FEB',
      showSpinner: false,
    },
    StatusBar: {
      // 跟随系统外观：浅色模式深色文字，深色模式浅色文字。
      style: 'DEFAULT',
      overlaysWebView: false,
    },
  },
}

export default config
