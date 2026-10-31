import { z } from 'zod'

export const MAX_FRAME_BYTES = 1_048_576

export class FrameError extends Error {
  override readonly name = 'FrameError'
  /** 尽力提取的原始帧 type，解码失败时可能缺失。 */
  readonly frameType: string | undefined

  constructor(message: string, frameType?: string) {
    super(message)
    this.frameType = frameType
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

export const COMMAND_OPS = ['prompt', 'resume', 'create', 'interrupt', 'answer', 'cancel', 'configure'] as const

const Target = z.object({
  device: z.string().min(1),
  agent: z.string().min(1),
  sessionId: z.string().min(1),
})

const Hello = z.object({
  v: z.literal(1), type: z.literal('hello'),
  device: z.string().min(1), token: z.string().min(16),
  agents: z.array(z.string()),
})

const Event = z.object({
  v: z.literal(1), type: z.literal('event'),
  device: z.string().min(1), agent: z.string().min(1), sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(), ts: z.string(),
  kind: MarshalKind, payload: z.unknown(),
})

const Command = z.object({
  v: z.literal(1), type: z.literal('command'),
  id: z.string().min(1), idempotencyKey: z.string().min(1), deadline: z.number(),
  op: z.enum(COMMAND_OPS), target: Target, args: z.unknown().optional(),
})

const Ack = z.object({
  v: z.literal(1), type: z.literal('ack'),
  id: z.string().min(1), ok: z.boolean(),
  result: z.unknown().optional(), code: z.string().optional(), message: z.string().optional(),
})

export const FrameSchema = z.discriminatedUnion('type', [Hello, Event, Command, Ack])
export type Frame = z.infer<typeof FrameSchema>
export type EventFrame = z.infer<typeof Event>
export type CommandFrame = z.infer<typeof Command>
export type HelloFrame = z.infer<typeof Hello>
export type AckFrame = z.infer<typeof Ack>

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)'
  return path.map((segment) => String(segment)).join('.')
}

function extractFrameType(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const type: unknown = (json as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

function tooLarge(bytes: number): FrameError {
  return new FrameError(`marshal: frame too large: ${bytes} bytes exceeds limit of ${MAX_FRAME_BYTES} bytes`)
}

export function encodeFrame(frame: Frame): string {
  const text = JSON.stringify(frame)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FRAME_BYTES) throw tooLarge(bytes)
  return text
}

export function decodeFrame(text: string): Frame {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FRAME_BYTES) throw tooLarge(bytes)
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new FrameError('marshal: frame is not JSON') }
  const parsed = FrameSchema.safeParse(json)
  if (!parsed.success) {
    const frameType = extractFrameType(json)
    const issue = parsed.error.issues[0]
    const where = issue ? formatPath(issue.path) : '(root)'
    const detail = issue?.message ?? 'invalid frame'
    const label = frameType === undefined ? '' : ` type=${frameType}`
    throw new FrameError(`marshal: invalid frame${label} at ${where}: ${detail}`, frameType)
  }
  return parsed.data
}
