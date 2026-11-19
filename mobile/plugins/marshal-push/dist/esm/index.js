import { registerPlugin } from '@capacitor/core'

export const MarshalPush = registerPlugin('MarshalPush', {
  web: () => Promise.resolve({
    async token() { return { provider: 'fcm', token: '' } },
    async updateLive() {},
  }),
})
