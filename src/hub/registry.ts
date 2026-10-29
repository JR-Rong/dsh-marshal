export interface Sender { send(text: string): void }

export interface DeviceSeed {
  readonly id: string
  readonly name: string
  readonly agents: readonly string[]
}

export interface DeviceView extends DeviceSeed {
  readonly connectedAt: number
  readonly lastSeen: number
}

interface Slot { record: DeviceView; readonly sender: Sender }

export class DeviceRegistry {
  private readonly devices = new Map<string, Slot>()

  attach(seed: DeviceSeed, sender: Sender, now: number): void {
    this.devices.set(seed.id, {
      record: { ...seed, connectedAt: now, lastSeen: now },
      sender,
    })
  }

  detach(id: string): void { this.devices.delete(id) }

  touch(id: string, now: number): void {
    const slot = this.devices.get(id)
    if (slot !== undefined) slot.record = { ...slot.record, lastSeen: now }
  }

  get(id: string): Slot | undefined { return this.devices.get(id) }

  list(_now: number): DeviceView[] { return [...this.devices.values()].map(slot => slot.record) }

  expire(now: number, ttlMs: number): string[] {
    const expired: string[] = []
    for (const [id, slot] of this.devices) {
      if (now - slot.record.lastSeen > ttlMs) { this.devices.delete(id); expired.push(id) }
    }
    return expired
  }
}
