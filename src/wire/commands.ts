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
  subscriptionId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'subscribe' && value.subscriptionId !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'subscribe must not carry subscriptionId', path: ['subscriptionId'] })
  }
  if (value.action === 'unsubscribe' && value.subscriptionId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'unsubscribe requires subscriptionId', path: ['subscriptionId'] })
  }
})

const ObserveArgsSchema = z.discriminatedUnion('kind', [ObserveHistorySchema, ObserveFollowSchema])

const PromptArgsSchema = z.object({
  // 拒绝原生 mode 等透传字段：普通 prompt 的受理语义由 node 端保证。
  text: z.string().min(1).max(200_000),
}).strict()

const InterruptArgsSchema = z.object({
  turnId: z.string().min(1).optional(),
}).strict()

const AnswerArgsSchema = z.object({
  requestId: z.string().min(1),
  // 卡片总大小（含 answers）由投影层按 MAX_INTERACTION_INPUT_BYTES 限制。
  answers: z.unknown(),
}).strict()

const CancelArgsSchema = z.object({
  requestId: z.string().min(1).optional(),
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

export function parseCommandArgs(op: CommandOp, args: unknown): CommandArgs {
  const schema = ARG_SCHEMAS[op]
  const parsed = schema.safeParse(args === undefined ? {} : args)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')
  const detail = issue?.message ?? 'invalid arguments'
  throw new FrameError(`marshal: invalid args for ${op} at ${where}: ${detail}`, 'command', 'invalid-args')
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
