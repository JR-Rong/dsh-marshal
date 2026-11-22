export const CONNECTIVITY_TTL_MS = 45_000

export function createConnectivity() {
  let generation = 0
  let devicesAt: number | null = null
  let rosterAt: number | null = null
  let streamDown = false
  const invalidate = () => { generation++; devicesAt = rosterAt = null }
  const fresh = (at: number | null, now: number) => at !== null && now >= at && now - at < CONNECTIVITY_TTL_MS
  return {
    beginProbe: () => ++generation,
    accepts: (probe: number) => probe === generation && !streamDown,
    devices: (now: number) => { devicesAt = now },
    roster: (now: number | null) => { rosterAt = now },
    invalidate,
    stream: (status: 'open' | 'error' | 'close' | 'reset') => {
      streamDown = status === 'error' || status === 'close'
      invalidate()
    },
    snapshot(now: number) {
      const hub = !streamDown && fresh(devicesAt, now)
      const roster = hub && fresh(rosterAt, now)
      const expiry = Math.min(hub && devicesAt !== null ? devicesAt + CONNECTIVITY_TTL_MS : Infinity,
        roster && rosterAt !== null ? rosterAt + CONNECTIVITY_TTL_MS : Infinity)
      return { hub, roster, expiry }
    },
  }
}
