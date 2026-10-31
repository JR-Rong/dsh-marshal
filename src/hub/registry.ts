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

/** 当前连接的身份；T02 会把它替换为完整连接代次校验。 */
export interface Attachment {
  readonly connectionId: string
  readonly nodeEpoch: string
}

interface Slot {
  record: DeviceView
  readonly sender: Sender
  readonly connectionId?: string
  readonly nodeEpoch?: string
}

export class DeviceRegistry {
  private readonly devices = new Map<string, Slot>()

  attach(seed: DeviceSeed, sender: Sender, now: number, attachment?: Attachment): void {
    this.devices.set(seed.id, {
      record: { ...seed, connectedAt: now, lastSeen: now },
      sender,
      ...(attachment === undefined ? {} : { connectionId: attachment.connectionId, nodeEpoch: attachment.nodeEpoch }),
    })
  }

  detach(id: string): void { this.devices.delete(id) }

  /** 只在该 id 当前登记的就是这个 sender 时才摘除；用于丢弃迟到的 close。 */
  detachIf(id: string, sender: Sender): boolean {
    const slot = this.devices.get(id)
    if (slot === undefined || slot.sender !== sender) return false
    this.devices.delete(id)
    return true
  }

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
