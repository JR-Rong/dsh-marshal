import type { SessionControllerLike, SessionSummaryLike } from '../../dsh-types.ts'

export interface DshSurface {
  list(signal: AbortSignal): Promise<readonly SessionSummaryLike[]>
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<unknown>
  prompt(input: { sessionId: string; text: string; requestId: string }): Promise<unknown>
  cancel(sessionId: string): Promise<unknown>
}

/** DSH 升级导致签名变化时，只改这一个文件。 */
export function createDshSurface(controller: SessionControllerLike): DshSurface {
  return {
    async list(signal) {
      const page = await controller.list({}, signal)
      return page.items
    },
    follow(sessionId, signal) {
      return controller.follow({ address: { kind: 'session', sessionId } }, signal)
    },
    prompt({ sessionId, text, requestId }) {
      const abort = new AbortController()
      return controller.prompt({ requestId, sessionId, mode: 'steer', content: [{ type: 'text', text }] }, abort.signal)
    },
    async cancel(sessionId) {
      return controller.cancel({ sessionId })
    },
  }
}
