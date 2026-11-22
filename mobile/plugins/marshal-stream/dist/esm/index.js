import { registerPlugin } from '@capacitor/core'

export class MarshalStreamWeb {
  async open() {
    throw new Error('MarshalStream 仅在原生壳内可用')
  }

  async close() {}

  async pushToken() {
    return { ok: false, reason: 'web' }
  }

  async addListener() {
    return { remove: async () => {} }
  }
}

export const MarshalStream = registerPlugin('MarshalStream', {
  web: () => Promise.resolve(new MarshalStreamWeb()),
})
