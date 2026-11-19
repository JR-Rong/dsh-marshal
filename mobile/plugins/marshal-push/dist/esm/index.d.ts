export interface PushToken {
  provider: 'apns' | 'fcm' | 'huawei'
  token: string
  liveToken?: string
}

export interface MarshalPushPlugin {
  token(): Promise<PushToken>
  updateLive(options: { title: string; body: string; running: boolean }): Promise<void>
}

export declare const MarshalPush: MarshalPushPlugin
