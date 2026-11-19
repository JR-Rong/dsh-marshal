export interface MarshalStreamMessage {
  event: string
  data: string
  id?: string
  streamId?: string
}

export interface PushTokenResult {
  ok: boolean
  provider?: 'apns' | 'fcm' | 'huawei'
  token?: string
  liveToken?: string
  liveTokens?: Record<string, string>
  reason?: string
}

export interface MarshalStreamPlugin {
  open(options: { url: string; token?: string; id?: string; lastEventId?: string }): Promise<void>
  close(options?: { id?: string }): Promise<void>
  pushToken(): Promise<PushTokenResult>
  addListener(
    eventName: 'message',
    listenerFunc: (message: MarshalStreamMessage) => void,
  ): Promise<{ remove: () => Promise<void> }>
}
