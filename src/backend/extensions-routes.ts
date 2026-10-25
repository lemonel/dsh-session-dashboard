import type { Context } from '@deepseek-ai/cordis'
import type { ExtensionRegistry } from './extensions-store.js'

/** Minimal structural face of the Web carrier's authenticated route registry.
 *  The dashboard does not depend on the concrete Host type: a Host without the
 *  browser carrier simply gets no routes. */
interface RouteRequest extends Request { }
interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'stream'
  fetch(request: RouteRequest): Promise<Response>
}
interface ConnectionFace { fetch: { register(route: FetchRoute): unknown } }

export { EXTENSIONS_PATH, EXTENSION_MODULE_PATH, EXTENSION_ENABLED_PATH } from '../shared/extensions/routes.js'
import { EXTENSIONS_PATH, EXTENSION_MODULE_PATH, EXTENSION_ENABLED_PATH } from '../shared/extensions/routes.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const
const SCRIPT_HEADERS = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } as const

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** Register the extension routes inside the connection's authentication fence:
 *  the list, one module source, and the enable/disable write. Every response is
 *  `no-store` — the loader owns cache busting so a rebuild is never picked up
 *  behind the operator's back. */
export function registerExtensionRoutes(ctx: Context, registry: ExtensionRegistry): void {
  const connection = ctx.get('connection') as unknown as ConnectionFace | undefined
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') return
  connection.fetch.register({
    path: EXTENSIONS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    // `disabled` carries every switched-off id, built-ins included: the loader
    // needs it before it can decide which bundled extensions to mount.
    fetch: async () => json({ directory: registry.directory, features: null, entries: await registry.list(), disabled: await registry.disabled() }),
  })
  connection.fetch.register({
    path: EXTENSION_MODULE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const id = new URL(request.url, 'http://dsh.invalid').searchParams.get('id')
      if (id === null || id === '') return json({ error: 'id is required' }, 400)
      const result = await registry.readModule(id)
      if ('problem' in result) return json({ error: result.problem }, 404)
      return new Response(result.source, { headers: SCRIPT_HEADERS })
    },
  })
  connection.fetch.register({
    path: EXTENSION_ENABLED_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ error: 'body must be JSON' }, 400)
      }
      if (typeof body !== 'object' || body === null) return json({ error: 'body must be an object' }, 400)
      const { id, enabled } = body as { id?: unknown; enabled?: unknown }
      if (typeof id !== 'string' || id === '' || typeof enabled !== 'boolean') return json({ error: 'id and enabled are required' }, 400)
      try {
        const entries = await registry.setEnabled(id, enabled)
        return json({ entries, disabled: await registry.disabled() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 404)
      }
    },
  })
}

