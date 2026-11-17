import { PromptOptionsSchema } from '../agents/controls.ts'
import { UploadSchema } from '../node/uploads.ts'
import { DiscussionTurnSchema, DiscussionStopSchema, type DiscussionTurn, type DiscussionStop } from '../discussions/types.ts'
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
  options: PromptOptionsSchema.optional(),
  attachments: z.array(z.string().uuid()).max(8).optional(),
}).strict()

const InterruptArgsSchema = z.object({
  // 只有当前 runtime 才能安全打断；epoch 不符由适配器拒绝为 stale-connection。
  runtimeEpoch: z.string().min(1),
  turnId: z.string().min(1).optional(),
}).strict()

const WireAnswerSchema = z.object({
  // 稳定选项 ID 由 node 端投影生成；显示 label 不参与识别。
  id: z.string().min(1).max(128),
  selectedOptionIds: z.array(z.string().min(1).max(256)).max(64),
  text: z.string().max(4096).optional(),
}).strict()

const AnswerArgsSchema = z.object({
  requestId: z.string().min(1),
  // 卡片总大小（含 answers）由投影层按 MAX_INTERACTION_INPUT_BYTES 限制。
  answers: z.array(WireAnswerSchema).max(64),
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

// acquire 不携带参数：是否可取得写权只能由适配器按排他证据裁定。
const AcquireArgsSchema = z.object({}).strict()

const CreateArgsSchema = z.object({
  // cwd 只接受显式、有界路径；缺省由适配器决定，不猜机器目录。
  cwd: z.string().min(1).max(4096).optional(),
}).strict()

// fork 的目标是父会话，新会话身份由原生返回。
const ForkArgsSchema = z.object({}).strict()

export type ObserveArgs = z.infer<typeof ObserveArgsSchema>
export type PromptArgs = z.infer<typeof PromptArgsSchema>
export type InterruptArgs = z.infer<typeof InterruptArgsSchema>
export type AnswerArgs = z.infer<typeof AnswerArgsSchema>
export type CancelArgs = z.infer<typeof CancelArgsSchema>
export type ConfigureArgs = z.infer<typeof ConfigureArgsSchema>
export type AcquireArgs = z.infer<typeof AcquireArgsSchema>
export type CreateArgs = z.infer<typeof CreateArgsSchema>
export type ForkArgs = z.infer<typeof ForkArgsSchema>
export type CommandArgs =
  | z.infer<typeof UploadSchema>
  | ObserveArgs
  | PromptArgs
  | InterruptArgs
  | AnswerArgs
  | CancelArgs
  | ConfigureArgs
  | AcquireArgs
  | CreateArgs
  | ForkArgs
  | DiscussionTurn
  | DiscussionStop

const ARG_SCHEMAS = {
  controls: z.object({}).strict(),
  upload: UploadSchema,
  'discussion.turn': DiscussionTurnSchema,
  'discussion.stop': DiscussionStopSchema,
  observe: ObserveArgsSchema,
  prompt: PromptArgsSchema,
  interrupt: InterruptArgsSchema,
  answer: AnswerArgsSchema,
  cancel: CancelArgsSchema,
  configure: ConfigureArgsSchema,
  acquire: AcquireArgsSchema,
  create: CreateArgsSchema,
  fork: ForkArgsSchema,
} as const

export function parseCommandArgs(op: 'observe', args: unknown): ObserveArgs
export function parseCommandArgs(op: 'prompt', args: unknown): PromptArgs
export function parseCommandArgs(op: 'interrupt', args: unknown): InterruptArgs
export function parseCommandArgs(op: 'answer', args: unknown): AnswerArgs
export function parseCommandArgs(op: 'cancel', args: unknown): CancelArgs
export function parseCommandArgs(op: 'configure', args: unknown): ConfigureArgs
export function parseCommandArgs(op: 'acquire', args: unknown): AcquireArgs
export function parseCommandArgs(op: 'create', args: unknown): CreateArgs
export function parseCommandArgs(op: 'fork', args: unknown): ForkArgs
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
