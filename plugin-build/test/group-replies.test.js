import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMarshalEventBus } from '../lib/src/groups/event-bus.js';
import { createGroupService } from '../lib/src/groups/service.js';

test('overlapping sends use one poller and a persisted reply cannot be appended twice', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-group-replies-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    const eventBus = createMarshalEventBus();
    const changes = [];
    eventBus.subscribe((...event) => changes.push(event));
    t.after(() => eventBus.dispose());
    const options = {
        root, deviceId: 'mac', replyPollMs: 10, eventBus,
        prompt: async () => undefined,
        reader: {
            latest: async () => 0,
            async since(_sessionId, seq) {
                reads++;
                return seq === 0 ? [{ seq: 1, text: '唯一回复' }] : [];
            },
        },
    };
    const service = createGroupService(options);
    const group = service.create({
        name: 'fixture',
        members: [
            { squadId: 'team', memberId: 'a', name: '甲' },
            { squadId: 'team', memberId: 'b', name: '乙' },
        ],
    });
    service.bind(group.id, 'mac/team/a', 'session-a');
    await Promise.all([
        service.send(group.id, { text: 'first' }),
        service.send(group.id, { text: 'second' }),
    ]);
    t.mock.timers.tick(10);
    await Promise.resolve();
    assert.equal(reads, 1);
    let replies = service.get(group.id).messages.filter(item => item.author === 'member');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].source, { sessionId: 'session-a', seq: 1 });
    assert.deepEqual(changes, Array.from({ length: 5 }, () => ['groups.changed', {}]));
    service.dispose();

    const reopened = createGroupService(options);
    t.after(() => reopened.dispose());
    await reopened.send(group.id, { text: 'third' });
    assert.equal(changes.length, 7); // New user message and accepted delivery.
    t.mock.timers.tick(10);
    await Promise.resolve();
    assert.equal(reads, 2);
    replies = reopened.get(group.id).messages.filter(item => item.author === 'member');
    assert.equal(replies.length, 1);
    assert.equal(changes.length, 7); // Polling a stored reply does not invalidate the stream.
});
