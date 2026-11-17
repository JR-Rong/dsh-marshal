import { z } from 'zod'
import { PreCallRejection } from '../adapters/types.ts'

export const PromptOptionsSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string().min(1).max(40).optional(),
}).strict()
export type PromptOptions = z.infer<typeof PromptOptionsSchema>
export const ControlsSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1).max(200), label: z.string().min(1).max(200),
    efforts: z.array(z.string().min(1).max(40)).max(16),
  }).strict()).max(100),
  current: PromptOptionsSchema.optional(),
}).strict()
export type SessionControls = z.infer<typeof ControlsSchema>
export interface PromptAttachment { readonly path: string; readonly name: string; readonly mime: string }
export interface PromptExtras { readonly options?: PromptOptions; readonly files?: readonly PromptAttachment[] }

/** Validate against the source runtime's catalog, never an invented model list. */
export function validateOptions(controls: SessionControls, options?: PromptOptions): void {
  if (!options || (!options.model && !options.reasoning)) return
  const model = controls.models.find(row => row.id === (options.model ?? controls.current?.model))
  if (!model || (options.reasoning && !model.efforts.includes(options.reasoning))) {
    throw new PreCallRejection('invalid-args', 'model or reasoning effort unavailable')
  }
}
export function attachmentText(text: string, files: readonly PromptAttachment[] = []): string {
  const documents = files.filter(file => !file.mime.startsWith('image/'))
  return documents.length ? text + '\n\n用户附加的文件（请按任务需要读取）：\n' + documents.map(file => JSON.stringify({ name: file.name, path: file.path })).join('\n') : text
}
