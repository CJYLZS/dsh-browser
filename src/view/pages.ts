/**
 * The route a sidebar tab asks its page's open and close through.
 *
 * Neither ask can travel on the pane's own channel. A close arrives here because
 * the tab is going away in the same breath — its viewer socket, the channel a
 * pane normally drives its page through, is the thing being torn down. An open
 * arrives here because the tab that asks for one does not exist yet: the browser
 * entry's pane exists to hold the page the ask produces, and the ask is what
 * makes it. A plain POST is the one channel both have, and the same trust check
 * the other routes carry is what stands between it and anything that can reach
 * the port.
 *
 * What an ask means is the host's to decide, not the client's: one page among
 * several closes alone and the last one stops the browser — Chrome exits when
 * its last tab goes, so that close is the deliberate stop, the one a viewer must
 * not undo by coming back. An open is a page of its own: a browser already
 * running gets one more, and a browser that is not running comes up on the page
 * the ask answers with. The client never has to count pages it cannot see, and
 * `request` is what keeps one Sidebar tab's remount from asking twice.
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserPool } from '../browser/pool.ts'

/** Path a page is opened and closed through. */
export const PAGES_PATH = '/dsh-browser/pages'

/** One ask: a page to open, or one to close. */
export type PageRequest =
  | {
    readonly action: 'open'
    readonly sessionId: string
    /** Address to load in the new page; a blank page when absent. */
    readonly url?: string
    /** The record asking, so a repeated ask from it opens nothing new. */
    readonly request?: string
  }
  | {
    readonly action: 'close'
    readonly sessionId: string
    /** The page to close, by its CDP target id. */
    readonly targetId: string
  }

/**
 * Register the page route for the plugin's lifetime.
 * @param ctx - plugin context carrying `webServer` and `connection`.
 * @param pool - the browsers whose pages are opened and closed.
 */
export function registerPages(ctx: Context, pool: BrowserPool): void {
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
        if (asked.action === 'open') {
          // Asking for a page is asking for a browser. A browser that cannot
          // start is not this route's failure to report: its own state says so,
          // and the pane watching it draws the failure and the control that
          // recovers it.
          try {
            const page = await pool.get(asked.sessionId).openPage({
              ...asked.url === undefined ? {} : { url: asked.url },
              ...asked.request === undefined ? {} : { request: asked.request },
            })
            response.end(JSON.stringify({
              ok: true,
              ...page?.targetId === undefined ? {} : { targetId: page.targetId },
            }))
          } catch {
            response.end(JSON.stringify({ ok: false }))
          }
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
    }), 'dsh-browser: page route')
  })
}

/**
 * Read one JSON body.
 * @param request - the request carrying it.
 * @returns the ask, or `undefined` when the body names neither a page to open
 *   nor one to close.
 */
async function readBody(request: IncomingMessage): Promise<PageRequest | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      action?: unknown
      sessionId?: unknown
      targetId?: unknown
      url?: unknown
      request?: unknown
    }
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return undefined
    // A body that names a page and no action is the close the client has always
    // sent; an action is what a newer client adds.
    const action = parsed.action ?? (typeof parsed.targetId === 'string' ? 'close' : undefined)
    if (action === 'open') {
      return {
        action,
        sessionId: parsed.sessionId,
        ...typeof parsed.url !== 'string' || parsed.url === '' ? {} : { url: parsed.url },
        ...typeof parsed.request !== 'string' || parsed.request === '' ? {} : { request: parsed.request },
      }
    }
    if (action !== 'close' || typeof parsed.targetId !== 'string' || parsed.targetId === '') return undefined
    return { action, sessionId: parsed.sessionId, targetId: parsed.targetId }
  } catch {
    return undefined
  }
}
