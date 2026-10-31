import { z } from 'zod'
import { MAX_FRAME_BYTES, MAX_JSON_DEPTH } from './limits.ts'

export const CONTRACT_REVISION = 'p1-review-2'

/** 契约 §12 的错误码，加上本实现内部使用的传输级分类。 */
export const WIRE_ERROR_CODES = [
  'auth-failed', 'device-mismatch', 'stale-connection', 'frame-invalid', 'device-offline',
  'sync-required', 'session-unknown', 'writer-busy', 'ownership-unverified', 'expired',
  'clock-skew', 'conflict', 'idempotency-conflict', 'revision-conflict', 'outcome-unknown',
  'approval-disabled', 'approval-expired', 'decision-invalid', 'widen-rejected', 'unsupported',
  'version-unsupported', 'size-limit', 'readback-timeout', 'readback-mismatch', 'agent-crashed',
  'recovery-required', 'record-unavailable', 'settings-unsafe', 'session-purpose-conflict',
  'invalid-args',
  // 传输层内部使用，不在契约 §12 的公开枚举里。
  'hello-required', 'timeout', 'disposed', 'invalid', 'unknown', 'result-too-large',
  'deadline-expired', 'tighten-only', 'session-mismatch',
] as const
export const WireErrorCode = z.enum(WIRE_ERROR_CODES)
export type WireErrorCode = z.infer<typeof WireErrorCode>

/** 契约 §12 固定的 close code；1009 仅表示帧超限，由 ws 库在 maxPayload 溢出时发出。 */
export const CLOSE_CODES = {
  FRAME_INVALID: 4400,
  AUTH_FAILED: 4401,
  DEVICE_MISMATCH: 4403,
  VERSION_UNSUPPORTED: 4406,
  HANDSHAKE_TIMEOUT: 4408,
  STALE_CONNECTION: 4409,
  FRAME_SIZE: 1009,
} as const

export class FrameError extends Error {
  override readonly name = 'FrameError'
  /** 尽力提取的原始帧 type，解码失败时可能缺失。 */
  readonly frameType: string | undefined
  readonly code: WireErrorCode

  constructor(message: string, frameType?: string, code: WireErrorCode = 'frame-invalid') {
    // 契约 §12：任何通道都不得省略机器可读 code，消息统一以 `marshal: <code>:` 开头。
    const withoutPrefix = message.startsWith('marshal: ') ? message.slice('marshal: '.length) : message
    const detail = withoutPrefix.startsWith(`${code}:`)
      ? withoutPrefix.slice(code.length + 1).trimStart()
      : withoutPrefix
    super(`marshal: ${code}: ${detail}`)
    this.frameType = frameType
    this.code = code
  }
}

export const MARSHAL_KINDS = [
  'session.updated', 'session.removed', 'turn.started', 'turn.completed',
  'reasoning.delta', 'message.delta', 'message.completed',
  'tool.started', 'tool.output', 'tool.completed',
  'input.requested', 'input.resolved', 'capability.changed', 'error',
] as const

export const MarshalKind = z.enum(MARSHAL_KINDS)
export type MarshalKind = z.infer<typeof MarshalKind>

/** v0 op set; create/fork/acquire/decide arrive with v1. Append here and in wire/commands.ts. */
export const COMMAND_OPS = ['observe', 'prompt', 'interrupt', 'answer', 'cancel', 'configure'] as const
export const CommandOpSchema = z.enum(COMMAND_OPS)
export type CommandOp = z.infer<typeof CommandOpSchema>

export const RelayPolicySchema = z.enum(['off', 'notify', 'remote'])

const TargetSchema = z.object({
  deviceId: z.string().min(1),
  agent: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
}).strict()

const HelloSchema = z.object({
  v: z.literal(2), type: z.literal('hello'),
  contractRevision: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  nodeEpoch: z.string().min(1),
  agents: z.array(z.string().min(1)),
  features: z.array(z.string().min(1)),
  operatorId: z.string().min(1).optional(),
  policyRevision: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.operatorId === undefined) !== (value.policyRevision === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'operatorId and policyRevision must be provided together',
      path: ['operatorId'],
    })
  }
})

const PoliciesSchema = z.object({
  privacy: z.enum(['metadata', 'content']),
  questionRelay: RelayPolicySchema,
  approvalRelay: RelayPolicySchema,
  allowContent: z.boolean(),
  allowInteractions: z.boolean(),
  allowDiscussion: z.boolean(),
}).strict()

const HelloAckSchema = z.object({
  v: z.literal(2), type: z.literal('hello.ack'),
  connectionId: z.string().min(1),
  hubEpoch: z.string().min(1),
  contractRevision: z.string().min(1),
  features: z.array(z.string().min(1)),
  nodeEpoch: z.string().min(1),
  operatorId: z.string().min(1),
  policyRevision: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
  policies: PoliciesSchema,
  serverTime: z.number().int().nonnegative(),
}).strict()

const CommandSchema = z.object({
  v: z.literal(2), type: z.literal('command'),
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  operatorId: z.string().min(1),
  target: TargetSchema,
  op: CommandOpSchema,
  args: z.unknown(),
  issuedAt: z.number().int().nonnegative(),
  deadline: z.number().int().nonnegative(),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
}).strict()

const AckSchema = z.object({
  v: z.literal(2), type: z.literal('ack'),
  commandId: z.string().min(1),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  status: z.enum(['accepted', 'confirmed', 'rejected', 'pending-confirmation', 'outcome-unknown']),
  code: WireErrorCode.optional(),
  result: z.unknown().optional(),
}).strict()

const EventSchema = z.object({
  v: z.literal(2), type: z.literal('event'),
  deviceId: z.string().min(1), agent: z.string().min(1), sessionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  kind: MarshalKind, payload: z.unknown(),
}).strict()

const SyncScopeSchema = z.object({
  agents: z.array(z.string().min(1)),
  sessions: z.array(z.string().min(1)),
}).strict()

const SyncBeginSchema = z.object({
  v: z.literal(2), type: z.literal('sync.begin'),
  syncId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  connectionId: z.string().min(1),
  scope: SyncScopeSchema,
  version: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  highWatermark: z.number().int().nonnegative(),
}).strict()

const SyncChunkSchema = z.object({
  v: z.literal(2), type: z.literal('sync.chunk'),
  syncId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  connectionId: z.string().min(1),
  index: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  rows: z.array(z.unknown()),
}).strict()

const SyncEndSchema = z.object({
  v: z.literal(2), type: z.literal('sync.end'),
  syncId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  connectionId: z.string().min(1),
  checksum: z.string().min(1).optional(),
}).strict()

const SyncAckSchema = z.object({
  v: z.literal(2), type: z.literal('sync.ack'),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  syncId: z.string().min(1),
  accepted: z.boolean(),
  version: z.number().int().nonnegative().optional(),
  error: WireErrorCode.optional(),
}).strict()

const CommandStatusSchema = z.object({
  v: z.literal(2), type: z.literal('command.status'),
  requestId: z.string().min(1),
  operatorId: z.string().min(1),
  target: TargetSchema,
  idempotencyKey: z.string().min(1),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
}).strict()

const CommandStatusResultSchema = z.object({
  v: z.literal(2), type: z.literal('command.status.result'),
  requestId: z.string().min(1),
  status: z.enum(['accepted', 'confirmed', 'rejected', 'pending-confirmation', 'outcome-unknown']),
  code: WireErrorCode.optional(),
  result: z.unknown().optional(),
}).strict()

const InputsSnapshotSchema = z.object({
  v: z.literal(2), type: z.literal('inputs.snapshot'),
  requestId: z.string().min(1),
  target: TargetSchema,
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
}).strict()

const InputsSnapshotResultSchema = z.object({
  v: z.literal(2), type: z.literal('inputs.snapshot.result'),
  requestId: z.string().min(1),
  runtimeEpoch: z.string().min(1),
  highWatermark: z.number().int().nonnegative(),
  cards: z.array(z.unknown()),
}).strict()

const HeartbeatSchema = z.object({
  v: z.literal(2), type: z.literal('heartbeat'),
  nonce: z.string().min(1),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  sentAt: z.number().int().nonnegative(),
}).strict()

const HeartbeatAckSchema = z.object({
  v: z.literal(2), type: z.literal('heartbeat.ack'),
  nonce: z.string().min(1),
  connectionId: z.string().min(1),
  nodeEpoch: z.string().min(1),
  sentAt: z.number().int().nonnegative(),
  localDiscussionRevision: z.number().int().nonnegative().optional(),
}).strict()

export const FrameSchema = z.discriminatedUnion('type', [
  HelloSchema, HelloAckSchema, CommandSchema, AckSchema, EventSchema,
  SyncBeginSchema, SyncChunkSchema, SyncEndSchema, SyncAckSchema,
  CommandStatusSchema, CommandStatusResultSchema,
  InputsSnapshotSchema, InputsSnapshotResultSchema,
  HeartbeatSchema, HeartbeatAckSchema,
])

export type Frame = z.infer<typeof FrameSchema>
export type HelloFrame = z.infer<typeof HelloSchema>
export type HelloAckFrame = z.infer<typeof HelloAckSchema>
export type CommandFrame = z.infer<typeof CommandSchema>
export type AckFrame = z.infer<typeof AckSchema>
export type EventFrame = z.infer<typeof EventSchema>
export type SyncBeginFrame = z.infer<typeof SyncBeginSchema>
export type SyncChunkFrame = z.infer<typeof SyncChunkSchema>
export type SyncEndFrame = z.infer<typeof SyncEndSchema>
export type SyncAckFrame = z.infer<typeof SyncAckSchema>
export type CommandStatusFrame = z.infer<typeof CommandStatusSchema>
export type CommandStatusResultFrame = z.infer<typeof CommandStatusResultSchema>
export type InputsSnapshotFrame = z.infer<typeof InputsSnapshotSchema>
export type InputsSnapshotResultFrame = z.infer<typeof InputsSnapshotResultSchema>
export type HeartbeatFrame = z.infer<typeof HeartbeatSchema>
export type HeartbeatAckFrame = z.infer<typeof HeartbeatAckSchema>

export type FrameDirection = 'node-to-hub' | 'hub-to-node'

const NODE_TO_HUB: ReadonlySet<Frame['type']> = new Set([
  'hello', 'event', 'sync.begin', 'sync.chunk', 'sync.end',
  'ack', 'command.status.result', 'inputs.snapshot.result',
])

const HUB_TO_NODE: ReadonlySet<Frame['type']> = new Set([
  'hello.ack', 'command', 'sync.ack', 'command.status', 'inputs.snapshot',
])

export function directionOf(frame: Frame): FrameDirection | 'both' {
  if (frame.type === 'heartbeat' || frame.type === 'heartbeat.ack') return 'both'
  if (NODE_TO_HUB.has(frame.type)) return 'node-to-hub'
  if (HUB_TO_NODE.has(frame.type)) return 'hub-to-node'
  return 'both'
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)'
  return path.map((segment) => String(segment)).join('.')
}

function extractFrameType(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const type: unknown = (json as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

function extractVersion(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return undefined
  return (json as { v?: unknown }).v
}

/** 迭代扫描 JSON 文本，字符串与转义不影响深度统计；不会因深层输入递归爆栈。 */
function textExceedsDepth(text: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') {
      depth += 1
      if (depth > MAX_JSON_DEPTH) return true
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
  return false
}

/** 解析后再检查一次，防止构造器绕过文本扫描。显式栈，深度只受 MAX_JSON_DEPTH 限制。 */
function valueExceedsDepth(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    const item = current.value
    if (item === null || typeof item !== 'object') continue
    if (current.depth >= MAX_JSON_DEPTH) return true
    for (const child of Object.values(item as Record<string, unknown>)) {
      stack.push({ value: child, depth: current.depth + 1 })
    }
  }
  return false
}

function tooLarge(bytes: number): FrameError {
  return new FrameError(
    `frame too large: ${bytes} bytes exceeds limit of ${MAX_FRAME_BYTES} bytes`,
    undefined,
    'size-limit',
  )
}

function tooDeep(): FrameError {
  return new FrameError(`frame exceeds maximum JSON depth of ${MAX_JSON_DEPTH}`)
}

export function encodeFrame(frame: Frame): string {
  const text = JSON.stringify(frame)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FRAME_BYTES) throw tooLarge(bytes)
  if (textExceedsDepth(text) || valueExceedsDepth(frame)) throw tooDeep()
  return text
}

export function decodeFrame(text: string): Frame {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FRAME_BYTES) throw tooLarge(bytes)
  if (textExceedsDepth(text)) throw tooDeep()
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new FrameError('frame is not JSON') }
  if (valueExceedsDepth(json)) throw tooDeep()
  const parsed = FrameSchema.safeParse(json)
  if (!parsed.success) {
    const frameType = extractFrameType(json)
    const version = extractVersion(json)
    if (version !== undefined && version !== 2) {
      throw new FrameError('unsupported wire version', frameType, 'version-unsupported')
    }
    const issue = parsed.error.issues[0]
    const where = issue ? formatPath(issue.path) : '(root)'
    const detail = issue?.message ?? 'invalid frame'
    const label = frameType === undefined ? '' : ` type=${frameType}`
    throw new FrameError(`invalid frame${label} at ${where}: ${detail}`, frameType)
  }
  return parsed.data
}
