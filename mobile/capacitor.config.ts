import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 调度官手机端壳配置。
 *
 * 关键约束：
 * - 本应用只承载「客户端」：没有 server 角色、没有入站监听。
 * - 外部链接交给系统浏览器，WebView 不放行任意导航。
 * - CapacitorHttp 打开后，外壳自身的设备/会话查询走原生网络栈，不受 CORS 限制。
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
  android: {
    allowMixedContent: false,
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
