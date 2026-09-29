/**
 * The route a closing sidebar tab asks its page's close through.
 *
 * Closing the tab is closing the page it mirrors, and the close arrives here
 * because the tab is going away in the same breath: its viewer socket — the
 * channel a pane normally drives its page through — is the thing being torn
 * down. A plain POST is the one channel left, and the same trust check the
 * other routes carry is what stands between it and anything that can reach the
 * port.
 *
 * What the close means is the host's to decide, not the client's: one page
 * among several closes alone, and the last one stops the browser — Chrome
 * exits when its last tab goes, so that close is the deliberate stop, the one
 * a viewer must not undo by coming back. The client never has to count pages
 * it cannot see.
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserPool } from '../browser/pool.ts'

/** Path a closing tab's page close is asked through. */
export const PAGES_PATH = '/dsh-browser/pages'

/**
 * Register the page-close route for the plugin's lifetime.
 * @param ctx - plugin context carrying `webServer` and `connection`.
 * @param pool - the browsers whose pages can be closed.
 */
export function registerPageClose(ctx: Context, pool: BrowserPool): void {
  ctx.inject(['webServer', 'connection'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: PAGES_PATH,
      handler: async (request, response) => {
        const rejection = scoped.connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection, { 'Content-Type': 'text/plain' })
          response.end(rejection === 401 ? 'Unauthorized' : 'Forbidden')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { 'Content-Type': 'text/plain' })
          response.end('Method Not Allowed')
          return
        }
        const asked = await readBody(request)
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        if (asked === undefined) {
          response.end(JSON.stringify({ ok: false }))
          return
        }
        // A browser that is not there has no page to close, and looking one up
        // never starts one: a close is not a request for a browser.
        const browser = pool.peek(asked.sessionId)
        if (browser === undefined) {
          response.end(JSON.stringify({ ok: false }))
          return
        }
        await browser.closePage(asked.targetId)
        response.end(JSON.stringify({ ok: true }))
      },
    }), 'dsh-browser: page close route')
  })
}

/**
 * Read one JSON body.
 * @param request - the request carrying it.
 * @returns the session and page named, or `undefined` when the body says neither.
 */
async function readBody(request: IncomingMessage): Promise<{ sessionId: string; targetId: string } | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      sessionId?: unknown
      targetId?: unknown
    }
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return undefined
    if (typeof parsed.targetId !== 'string' || parsed.targetId === '') return undefined
    return { sessionId: parsed.sessionId, targetId: parsed.targetId }
  } catch {
    return undefined
  }
}
