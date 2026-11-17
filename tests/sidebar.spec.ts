import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'
import { dashboardAddress } from '../src/sidebar.ts'

describe('sidebar address projection', () => {
  it('strips node credentials, custom paths and query data from the browser address', () => {
    const config = parseConfig({ role: 'node', hubUrl: 'wss://user:private@hub.example:48443/private?token=private', token: 'device-secret-never-public', deviceId: 'mac' }, 'host')
    expect(dashboardAddress(config)).toBe('https://hub.example:48443/marshal')
  })
  it('projects only the configured Hub origin', () => {
    const config = parseConfig({ role: 'hub', publicOrigin: 'https://hub.example', dashboardToken: 'secure-dashboard-token-123456789abcdef' }, 'host')
    expect(dashboardAddress(config)).toBe('https://hub.example/marshal')
  })
})
