const { registerPlugin } = require('@capacitor/core')

class MarshalStreamWeb {
  async open() {
    throw new Error('MarshalStream 仅在原生壳内可用')
  }

  async close() {}

  async addListener() {
    return { remove: async () => {} }
  }
}

const MarshalStream = registerPlugin('MarshalStream', {
  web: () => Promise.resolve(new MarshalStreamWeb()),
})

module.exports = { MarshalStream, MarshalStreamWeb }
