import { z } from 'zod'

export const MAX_FRAME_BYTES = 1_048_576

export class FrameError extends Error {}

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

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

export function decodeFrame(text: string): Frame {
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new FrameError('marshal: frame too large')
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new FrameError('marshal: frame is not JSON') }
  const parsed = FrameSchema.safeParse(json)
  if (!parsed.success) throw new FrameError(`marshal: invalid frame: ${parsed.error.issues[0]?.path.join('.') ?? '?'} ${parsed.error.issues[0]?.message ?? ''}`.trim())
  return parsed.data
}
