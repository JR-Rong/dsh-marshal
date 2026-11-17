import { request } from 'node:https'
import { readFileSync } from 'node:fs'
import { dshAccountHash, DSH_ACCOUNT_ORIGIN } from '../hub/account.ts'
import type { MarshalConfig } from '../config.ts'
import type { MarshalContext } from '../dsh-types.ts'

const CODES = new Set(['account-required', 'account-mismatch', 'account-unavailable', 'rate-limited', 'revoked', 'duplicate-id', 'invalid'])
const fail = (code = 'account-unavailable') => new Error(code)

export function accountCloudRequest(config: Pick<MarshalConfig, 'hubUrl' | 'publicOrigin' | 'hubCaFile'>, path: 'exchange' | 'enroll', body: unknown): Promise<Record<string, any>> {
  const url = new URL(config.hubUrl ?? config.publicOrigin!); url.protocol = 'https:'; url.pathname = '/marshal/account/' + path; url.search = ''; url.hash = ''
  url.username = ''; url.password = ''
  const ca = config.hubCaFile === undefined ? undefined : readFileSync(config.hubCaFile)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }),
      headers: { 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', data => {
        size += data.length
        if (size > 16_384) { res.destroy(); reject(fail()); return }
        chunks.push(data)
      })
      res.on('error', () => reject(fail()))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (res.statusCode !== 200 || !data.ok) throw fail(CODES.has(data.code) ? data.code : undefined)
          resolve(data)
        } catch (error) { reject(error instanceof Error && CODES.has(error.message) ? error : fail()) }
      })
    })
    req.setTimeout(12_000, () => { req.destroy(); reject(fail()) })
    req.on('error', () => reject(fail()))
    req.end(JSON.stringify(body))
  })
}

/** Native dsh-app requests are proxied over loopback without an Origin header.
 * The non-simple header and refusal of OPTIONS prevent cross-site browser calls. */
export function isDesktopRequest(req: import('node:http').IncomingMessage, origin: string, header: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    && req.method === 'POST' && req.headers[header] === '1'
    && (req.headers.origin === undefined || req.headers.origin === 'dsh-app://app' || req.headers.origin === origin)
}
export function mountAccountConnection(ctx: MarshalContext, config: MarshalConfig): void {
  if (!config.accountLogin) return
  ctx.inject(['webServer', 'deepseekAccount'], scoped => {
    for (const action of ['status', 'login'] as const) scoped.effect(() => scoped.webServer!.register({
      kind: 'exact', path: '/marshal/account/' + action,
      async handler(req, res) {
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify(data))
        }
        if (!isDesktopRequest(req, scoped.webServer!.getOrigin(), 'x-marshal-account')) {
          json(403, { ok: false, code: 'forbidden' }); return
        }
        let observedHash: string | null = null
        try {
          const account = scoped.deepseekAccount!
          const session = await account.getPlatformSession()
          if (!session || !session.userId) { json(200, { ok: false, code: 'account-required', accountHash: null }); return }
          if (session.origin !== DSH_ACCOUNT_ORIGIN) throw fail('account-mismatch')
          const accountHash = dshAccountHash(session.userId)
          observedHash = accountHash
          if (action === 'status') { json(200, { ok: true, accountHash }); return }
          const result = await accountCloudRequest(config, 'exchange', { grant: session.token })
          if (typeof result.ticket !== 'string' || !/^[\w-]{43}$/.test(result.ticket) || typeof result.expiresAt !== 'number') throw fail()
          const current = await account.getPlatformSession()
          if (!current || current.origin !== session.origin || current.token !== session.token || current.userId !== session.userId) throw fail('account-required')
          json(200, { ok: true, accountHash, ticket: result.ticket, expiresAt: result.expiresAt })
        } catch (error) {
          json(503, { ok: false, accountHash: observedHash, code: error instanceof Error && CODES.has(error.message) ? error.message : 'account-unavailable' })
        }
      },
    }), 'marshal: DSH account ' + action)
  })
}
