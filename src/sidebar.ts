import type { MarshalConfig } from './config.ts'
import type { MarshalContext } from './dsh-types.ts'
import { mountAccountConnection } from './node/account.ts'

/** The browser receives a public address only, never either authentication token. */
export function dashboardAddress(config: MarshalConfig): string {
  const url = new URL(config.role === 'hub' ? config.publicOrigin! : config.hubUrl!)
  url.protocol = 'https:'
  return `${url.origin}/marshal`
}

export function mountSidebarConnection(ctx: MarshalContext, config: MarshalConfig): void {
  mountAccountConnection(ctx, config)
  // Headless nodes need no web carrier. This optional child waits independently.
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer!.register({
      kind: 'exact', path: `/marshal/entry/${config.role}`,
      handler(req, res) {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ dashboardUrl: dashboardAddress(config), accountLogin: config.accountLogin }))
      },
    }), 'marshal: sidebar address')
  })
}
