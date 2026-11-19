import { registerPlugin } from '@capacitor/core'
import type { MarshalStreamPlugin } from './definitions.ts'

export class MarshalStreamWeb implements MarshalStreamPlugin {
  async open(): Promise<void> {
    throw new Error('MarshalStream 仅在原生壳内可用')
  }

  async close(): Promise<void> {}

  async pushToken() {
    return { ok: false, reason: 'web' }
  }

  async addListener(): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} }
  }
}

export const MarshalStream = registerPlugin<MarshalStreamPlugin>('MarshalStream', {
  web: () => Promise.resolve(new MarshalStreamWeb()),
})
