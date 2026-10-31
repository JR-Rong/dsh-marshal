import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FrameError, type CommandFrame, type CommandOp } from './frames.ts'

export type { CommandOp } from './frames.ts'
export { COMMAND_OPS } from './frames.ts'

const ObserveHistorySchema = z.object({
  kind: z.literal('history'),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200),
}).strict()

const ObserveFollowSchema = z.object({
  kind: z.literal('follow'),
  action: z.enum(['subscribe', 'unsubscribe']),
  // 订阅身份由 hub 签发；subscribe 与 unsubscribe 都必须携带同一个不透明 id。
  subscriptionId: z.string().min(1).max(128),
}).strict()

const ObserveArgsSchema = z.discriminatedUnion('kind', [ObserveHistorySchema, ObserveFollowSchema])

const PromptArgsSchema = z.object({
  // 拒绝原生 mode 等透传字段：普通 prompt 的受理语义由 node 端保证。
  text: z.string().min(1).max(200_000),
}).strict()

const InterruptArgsSchema = z.object({
  // 只有当前 runtime 才能安全打断；epoch 不符由适配器拒绝为 stale-connection。
  runtimeEpoch: z.string().min(1),
  turnId: z.string().min(1).optional(),
}).strict()

const AnswerArgsSchema = z.object({
  requestId: z.string().min(1),
  // 卡片总大小（含 answers）由投影层按 MAX_INTERACTION_INPUT_BYTES 限制。
  answers: z.unknown(),
}).strict()

const CancelArgsSchema = z.object({
  // cancel 只放弃一个已知待答请求，不允许退化成会话级取消。
  requestId: z.string().min(1),
}).strict()

const ConfigureArgsSchema = z.object({
  expectedRevision: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
}).strict()

export type ObserveArgs = z.infer<typeof ObserveArgsSchema>
export type PromptArgs = z.infer<typeof PromptArgsSchema>
export type InterruptArgs = z.infer<typeof InterruptArgsSchema>
export type AnswerArgs = z.infer<typeof AnswerArgsSchema>
export type CancelArgs = z.infer<typeof CancelArgsSchema>
export type ConfigureArgs = z.infer<typeof ConfigureArgsSchema>
export type CommandArgs = ObserveArgs | PromptArgs | InterruptArgs | AnswerArgs | CancelArgs | ConfigureArgs

const ARG_SCHEMAS = {
  observe: ObserveArgsSchema,
  prompt: PromptArgsSchema,
  interrupt: InterruptArgsSchema,
  answer: AnswerArgsSchema,
  cancel: CancelArgsSchema,
  configure: ConfigureArgsSchema,
} as const

export function parseCommandArgs(op: 'observe', args: unknown): ObserveArgs
export function parseCommandArgs(op: 'prompt', args: unknown): PromptArgs
export function parseCommandArgs(op: 'interrupt', args: unknown): InterruptArgs
export function parseCommandArgs(op: 'answer', args: unknown): AnswerArgs
export function parseCommandArgs(op: 'cancel', args: unknown): CancelArgs
export function parseCommandArgs(op: 'configure', args: unknown): ConfigureArgs
export function parseCommandArgs(op: CommandOp, args: unknown): CommandArgs
export function parseCommandArgs(op: CommandOp, args: unknown): CommandArgs {
  const schema = ARG_SCHEMAS[op]
  const value = args === undefined ? {} : args
  // strict schema 拒绝未知键；这里先给出统一的非对象错误，避免把数组/标量当参数透传。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FrameError(`invalid args for ${op}: expected an object`, 'command', 'invalid-args')
  }
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')
  const detail = issue?.message ?? 'invalid arguments'
  throw new FrameError(`invalid args for ${op} at ${where}: ${detail}`, 'command', 'invalid-args')
}

/** Deterministic JSON for digests: object keys sorted, array order preserved, undefined omitted. */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  const fields = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
  return `{${fields.join(',')}}`
}

/**
 * Digest over the semantic command payload only. Transport fields (commandId, issuedAt,
 * deadline, connectionId, nodeEpoch, operatorId) are deliberately excluded so retries
 * with the same idempotency key compare equal.
 */
export function commandPayloadDigest(op: CommandOp, target: CommandFrame['target'], args: unknown): string {
  const payload = stableJson({ op, target, args })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
