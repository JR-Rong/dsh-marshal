import { z } from 'zod';
import { PreCallRejection } from "../adapters/types.js";
export const PromptOptionsSchema = z.object({
    model: z.string().min(1).max(200).optional(),
    reasoning: z.string().min(1).max(40).optional(),
}).strict();
export const ControlsSchema = z.object({
    models: z.array(z.object({
        id: z.string().min(1).max(200), label: z.string().min(1).max(200),
        efforts: z.array(z.string().min(1).max(40)).max(16),
    }).strict()).max(100),
    current: PromptOptionsSchema.optional(),
}).strict();
/** Validate against the source runtime's catalog, never an invented model list. */
export function validateOptions(controls, options) {
    if (!options || (!options.model && !options.reasoning))
        return;
    const model = controls.models.find(row => row.id === (options.model ?? controls.current?.model));
    if (!model || (options.reasoning && !model.efforts.includes(options.reasoning))) {
        throw new PreCallRejection('invalid-args', 'model or reasoning effort unavailable');
    }
}
export function attachmentText(text, files = []) {
    const documents = files.filter(file => !file.mime.startsWith('image/'));
    return documents.length ? text + '\n\n用户附加的文件（请按任务需要读取）：\n' + documents.map(file => JSON.stringify({ name: file.name, path: file.path })).join('\n') : text;
}
