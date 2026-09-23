/**
 * What the settings page reads to answer "did my change take effect?".
 *
 * The page cannot see that by itself. A launch field closes the browsers and
 * the next request starts new ones, and frames travel over viewer sockets —
 * which the settings page does not hold. Without this route the only signal a
 * write produces is the field's own new value, which is the draft, not the
 * browsers.
 *
 * It reports every session's browser rather than the caller's, because the
 * settings page belongs to no session: it is the same page in every
 * conversation, and what it has to show is which browsers exist and what they
 * are running with.
 *
 * The route is owned by this plugin, so like the viewer route it carries its own
 * trust check: the webserver's ordinary route path runs none, and a route that
 * skipped it would report what the user is browsing to anything that can reach
 * the port.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserPool } from '../browser/pool.ts'

/** Path the settings page reads the live browser state from. */
export const STATUS_PATH = '/dsh-browser/status'

/**
 * Register the status route for the plugin's lifetime.
 * @param ctx - plugin context carrying `webServer` and `connection`.
 * @param pool - the browsers whose state is reported.
 */
export function registerStatus(ctx: Context, pool: BrowserPool): void {
  ctx.inject(['webServer', 'connection'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (request, response) => {
        const rejection = scoped.connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection, { 'Content-Type': 'text/plain' })
          response.end(rejection === 401 ? 'Unauthorized' : 'Forbidden')
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/json',
          // The whole point of the route is that a read is never the previous
          // browsers' answer.
          'Cache-Control': 'no-store',
        })
        response.end(JSON.stringify(pool.status()))
      },
    }), 'dsh-browser: status route')
  })
}
