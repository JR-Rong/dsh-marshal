export interface MarshalStreamMessage {
  event: string
  data: string
  id?: string
  streamId?: string
}

export interface MarshalStreamPlugin {
  open(options: { url: string; token?: string; id?: string; lastEventId?: string }): Promise<void>
  close(options?: { id?: string }): Promise<void>
  addListener(
    eventName: 'message',
    listenerFunc: (message: MarshalStreamMessage) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

export declare class MarshalStreamWeb implements MarshalStreamPlugin {
  open(): Promise<void>
  close(): Promise<void>
  addListener(): Promise<{ remove: () => Promise<void> }>
}

export declare const MarshalStream: MarshalStreamPlugin
