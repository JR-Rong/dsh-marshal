const { registerPlugin } = require('@capacitor/core')
const MarshalPush = registerPlugin('MarshalPush', {
  web: () => Promise.resolve({
    async token() { return { provider: 'fcm', token: '' } },
    async updateLive() {},
  }),
})
module.exports = { MarshalPush }
