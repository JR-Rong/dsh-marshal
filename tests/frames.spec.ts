import { describe, expect, it } from 'vitest'
import {
  CLOSE_CODES, CONTRACT_REVISION, FrameError, decodeFrame, directionOf, encodeFrame,
  type CommandFrame, type EventFrame, type HeartbeatFrame,
} from '../src/wire/frames.ts'
import { parseCommandArgs } from '../src/wire/commands.ts'
import { MAX_FRAME_BYTES } from '../src/wire/limits.ts'

const event: EventFrame = {
  v: 2, type: 'event', deviceId: 'mac', agent: 'dsh',
  sessionId: 's1', nodeEpoch: 'epoch-1', seq: 7, ts: 1_790_000_000_000,
  kind: 'tool.started', payload: { name: 'bash', args: { cmd: 'ls' } },
}

const command: CommandFrame = {
  v: 2, type: 'command', commandId: 'c1', idempotencyKey: 'k1', operatorId: 'op-1',
  target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
  op: 'prompt', args: { text: 'hi' }, issuedAt: 1_790_000_000_000,
  deadline: 1_790_000_030_000, connectionId: 'conn-1', nodeEpoch: 'epoch-1',
}

describe('frames', () => {
  it('往返编解码保持内容', () => {
    expect(decodeFrame(encodeFrame(event))).toEqual(event)
    expect(decodeFrame(encodeFrame(command))).toEqual(command)
  })

  it('只有 v2 帧可解码', () => {
    const bad = JSON.stringify({ ...event, v: 1 })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
    expect(() => decodeFrame(bad)).toThrow(/^marshal: version-unsupported: .*unsupported wire version/)
  })

  it('拒绝未知 kind', () => {
    const bad = JSON.stringify({ ...event, kind: 'thinking.raw' })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
  })

  it('拒绝未知字段', () => {
    expect(() => decodeFrame(JSON.stringify({ ...event, device: 'mac' }))).toThrow(FrameError)
    expect(() => decodeFrame(JSON.stringify({
      ...command, target: { ...command.target, device: 'mac' },
    }))).toThrow(FrameError)
  })

  it('拒绝缺少 target 的指令', () => {
    const { target: _target, ...noTarget } = command
    expect(() => decodeFrame(JSON.stringify(noTarget))).toThrow(/target/)
  })

  it('拒绝超过上限的帧', () => {
    const huge = JSON.stringify({ ...event, payload: 'x'.repeat(MAX_FRAME_BYTES) })
    expect(() => decodeFrame(huge)).toThrow(/too large/)
    try {
      decodeFrame(huge)
    } catch (error) {
      expect((error as FrameError).code).toBe('size-limit')
    }
  })

  it('拒绝非 JSON', () => {
    expect(() => decodeFrame('not json')).toThrow(FrameError)
  })

  it('拒绝超过深度上限的帧', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`
    expect(() => decodeFrame(deep)).toThrow(/maximum JSON depth/)
  })

  it('拒绝未知 type', () => {
    const bad = JSON.stringify({ ...event, type: 'bogus' })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
    expect(() => decodeFrame(bad)).toThrow(/bogus/)
  })

  it('hello 要求契约修订，operatorId 与 policyRevision 必须成对', () => {
    const hello = {
      v: 2, type: 'hello', contractRevision: CONTRACT_REVISION,
      deviceId: 'mac', deviceName: 'Mac', nodeEpoch: 'epoch-1',
      agents: ['dsh'], features: [],
    }
    expect(decodeFrame(JSON.stringify(hello))).toMatchObject({ type: 'hello', deviceId: 'mac' })
    expect(() => decodeFrame(JSON.stringify({ ...hello, operatorId: 'op-1' }))).toThrow(/operatorId/)
    expect(() => decodeFrame(JSON.stringify({ ...hello, operatorId: 'op-1', policyRevision: 3 })))
      .not.toThrow()
  })

  it('hello.ack 携带连接、契约修订与策略信息', () => {
    const ack = {
      v: 2, type: 'hello.ack', connectionId: 'conn-1', hubEpoch: 'hub-1',
      contractRevision: CONTRACT_REVISION, features: ['question-relay'], nodeEpoch: 'epoch-1',
      operatorId: 'op-1', policyRevision: 1, deviceId: 'mac',
      policies: {
        privacy: 'metadata', questionRelay: 'off', approvalRelay: 'off',
        allowContent: false, allowInteractions: false, allowDiscussion: false,
      },
      serverTime: 1_790_000_000_000,
    }
    expect(decodeFrame(JSON.stringify(ack))).toEqual(ack)
    const { contractRevision: _revision, ...withoutRevision } = ack
    expect(() => decodeFrame(JSON.stringify(withoutRevision))).toThrow(/contractRevision/)
  })

  it('拒绝超过上限的出站帧', () => {
    const huge = { ...event, payload: { blob: 'x'.repeat(MAX_FRAME_BYTES) } }
    expect(() => encodeFrame(huge)).toThrow(FrameError)
    expect(() => encodeFrame(huge)).toThrow(new RegExp(String(MAX_FRAME_BYTES)))
  })

  it('区分帧方向', () => {
    const heartbeat: HeartbeatFrame = {
      v: 2, type: 'heartbeat', nonce: 'n', connectionId: 'conn-1', nodeEpoch: 'epoch-1', sentAt: 1,
    }
    expect(directionOf(event)).toBe('node-to-hub')
    expect(directionOf(command)).toBe('hub-to-node')
    expect(directionOf(heartbeat)).toBe('both')
  })

  it('close code 表与契约一致', () => {
    expect(CLOSE_CODES.FRAME_INVALID).toBe(4400)
    expect(CLOSE_CODES.AUTH_FAILED).toBe(4401)
    expect(CLOSE_CODES.DEVICE_MISMATCH).toBe(4403)
    expect(CLOSE_CODES.VERSION_UNSUPPORTED).toBe(4406)
    expect(CLOSE_CODES.HANDSHAKE_TIMEOUT).toBe(4408)
    expect(CLOSE_CODES.STALE_CONNECTION).toBe(4409)
    expect(CLOSE_CODES.FRAME_SIZE).toBe(1009)
  })

  it('所有 FrameError 消息都带机器可读 code 前缀', () => {
    const cases: Array<() => void> = [
      () => decodeFrame('not json'),
      () => decodeFrame(JSON.stringify({ ...event, v: 1 })),
      () => decodeFrame(JSON.stringify({ ...event, type: 'bogus' })),
      () => decodeFrame('x'.repeat(MAX_FRAME_BYTES + 1)),
      () => decodeFrame(`${'['.repeat(40)}${']'.repeat(40)}`),
      () => parseCommandArgs('prompt', { text: '' }),
      () => parseCommandArgs('observe', { kind: 'follow', action: 'unsubscribe' }),
    ]
    for (const run of cases) {
      let error: FrameError | undefined
      try { run() } catch (caught) { error = caught as FrameError }
      expect(error).toBeInstanceOf(FrameError)
      expect(error?.message).toMatch(new RegExp(`^marshal: ${error?.code}: `))
    }
  })

  it('parseCommandArgs 拒绝非对象与未知键', () => {
    expect(() => parseCommandArgs('prompt', 'hi')).toThrow(/^marshal: invalid-args:/)
    expect(() => parseCommandArgs('prompt', ['hi'])).toThrow(/^marshal: invalid-args:/)
    expect(() => parseCommandArgs('prompt', { text: 'hi', extra: 1 })).toThrow(/^marshal: invalid-args:/)
    expect(parseCommandArgs('observe', { kind: 'follow', action: 'subscribe' }))
      .toEqual({ kind: 'follow', action: 'subscribe' })
  })
})
