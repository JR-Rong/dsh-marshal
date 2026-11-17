export class DeviceRegistry {
    devices = new Map();
    attach(seed, sender, now, attachment) {
        this.devices.set(seed.id, {
            record: { ...seed, connectedAt: now, lastSeen: now },
            sender,
            ...(attachment === undefined ? {} : { connectionId: attachment.connectionId, nodeEpoch: attachment.nodeEpoch }),
        });
    }
    detach(id) { this.devices.delete(id); }
    /** 只在该 id 当前登记的就是这个 sender 时才摘除；用于丢弃迟到的 close。 */
    detachIf(id, sender) {
        const slot = this.devices.get(id);
        if (slot === undefined || slot.sender !== sender)
            return false;
        this.devices.delete(id);
        return true;
    }
    touch(id, now) {
        const slot = this.devices.get(id);
        if (slot !== undefined)
            slot.record = { ...slot.record, lastSeen: now };
    }
    get(id) { return this.devices.get(id); }
    list(_now) { return [...this.devices.values()].map(slot => slot.record); }
    expire(now, ttlMs) {
        const expired = [];
        for (const [id, slot] of this.devices) {
            if (now - slot.record.lastSeen > ttlMs) {
                this.devices.delete(id);
                expired.push(id);
            }
        }
        return expired;
    }
}
