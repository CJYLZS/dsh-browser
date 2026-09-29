/**
 * The viewer transport: one WebSocket carrying frames down and input up.
 *
 * A viewer names the session it wants to watch, and the route looks that
 * session's browser up in the pool. That parameter is the only thing standing
 * between two conversations, so it is required: a viewer that names no session
 * is refused rather than handed whichever browser happens to exist.
 *
 * A viewer may also name the page it wants, by the page's CDP target id — the
 * identity the sidebar's tabs carry, one tab per page. A viewer that names one
 * is sent that page's frames and drives that page, whether or not it is the one
 * the tools act on; a viewer that names none watches the active page, which is
 * what a pane did before tabs named their pages.
 *
 * The route is owned by this plugin, which means the webserver hands it the
 * upgraded socket before any Connection check runs — the webserver's own
 * upgrade path only looks the route up and calls it. A route owner that skipped
 * the check would let anything that can reach the port drive the user's
 * browser, so the handler applies Connection's own rejection first, the same
 * call the gateway makes on its route: `isTrustedApiRequest` for the Host and
 * Origin fences, then browser authentication.
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserPool } from '../browser/pool.ts'
import type { SessionBrowser } from '../browser/session-browser.ts'
import type { InputMessage } from '../browser/input.ts'

/** Path the Sidebar viewer connects to, with the session it watches as a query parameter. */
export const STREAM_PATH = '/dsh-browser/stream'

/** Query parameter naming the session whose browser the viewer wants. */
export const SESSION_PARAM = 'session'

/** Query parameter naming the page the viewer wants, by its CDP target id. */
export const PAGE_PARAM = 'page'

/**
 * The session — and, when named, the page — a viewer asked for.
 * @param request - the upgrade request.
 * @returns the session id, or `undefined` when it named none, and the page id when it named one.
 */
function viewerOf(request: IncomingMessage): { session?: string; page?: string } {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const session = url.searchParams.get(SESSION_PARAM)
  const page = url.searchParams.get(PAGE_PARAM)
  return {
    ...(session === null || session === '' ? {} : { session }),
    ...(page === null || page === '' ? {} : { page }),
  }
}

/**
 * Register the viewer route for the plugin's lifetime.
 * @param ctx - plugin context carrying `webServer` and `connection`.
 * @param pool - the browsers the route mirrors and drives.
 */
export function registerStream(ctx: Context, pool: BrowserPool): void {
  ctx.inject(['webServer', 'connection'], (scoped) => {
    const server = new WebSocketServer({ noServer: true })
    scoped.effect(() => {
      const unregister = scoped.webServer.registerUpgrade({
        path: STREAM_PATH,
        handler: (request, socket, head) => {
          const rejection = scoped.connection.requestRejection(request)
          if (rejection !== undefined) {
            socket.write(
              `HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\n`
              + 'Connection: close\r\nContent-Length: 0\r\n\r\n',
            )
            socket.destroy()
            return
          }
          const { session, page } = viewerOf(request)
          if (session === undefined) {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            socket.destroy()
            return
          }
          server.handleUpgrade(request, socket, head, (client) => {
            void attach(client, pool, session, page)
          })
        },
      })
      return () => {
        unregister()
        server.close()
      }
    }, 'dsh-browser: viewer stream')
  })
}

/**
 * Serve one viewer for its connection's lifetime.
 * @param client - the accepted socket.
 * @param pool - the browsers a session's viewer can address.
 * @param sessionId - the session this viewer named.
 * @param pageId - the page's CDP target id, when the viewer named one.
 */
export async function attach(
  client: WebSocket,
  pool: BrowserPool,
  sessionId: string,
  pageId?: string,
): Promise<void> {
  const send = (value: unknown): void => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(value))
  }
  let browser: SessionBrowser
  try {
    // A viewer that names a page is pointing at one the tab list reported, so
    // the browser must already be there; looking one up never starts one. A
    // viewer that names no page may arrive first — that is what starts a
    // browser the guide entry promised.
    browser = pageId === undefined ? pool.get(sessionId) : pool.peek(sessionId) ?? missing(sessionId)
  } catch (error) {
    // The socket is already upgraded, so the refusal travels as a message the
    // pane can show rather than as a status code nobody will see.
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    client.close()
    return
  }
  let release: () => void = () => {}
  try {
    const stopFrames = pageId === undefined
      ? browser.addViewer(frame => {
          if (client.readyState === client.OPEN) client.send(frame.jpeg, { binary: true })
        })
      : await browser.addPageViewer(frame => {
          if (client.readyState === client.OPEN) client.send(frame.jpeg, { binary: true })
        }, pageId)
    const stopStatus = browser.watch(status => {
      // A viewer that named a page is told about that page: its address is the
      // one it is looking at, and a page no longer listed is one that went
      // away — the pane learns that, and the tab closes with the socket.
      if (pageId !== undefined) {
        const tab = status.tabs.find(candidate => candidate.targetId === pageId)
        if (tab === undefined) {
          send({ type: 'status', status })
          client.close()
          return
        }
        send({ type: 'status', status: { ...status, url: tab.url } })
        return
      }
      send({ type: 'status', status })
    })
    release = () => {
      stopStatus()
      stopFrames()
    }
    client.on('close', release)
    client.on('error', release)
    client.on('message', (raw, isBinary) => {
      if (isBinary) return
      void handleMessage(String(raw), browser, pageId, (text) => { send({ type: 'clipboard', text }) })
        .catch((error: unknown) => {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
    })
    // The viewer renders before the browser has started, so the opening snapshot
    // is what tells it whether it is waiting, mirroring, or looking at a failure.
    const opening = browser.status()
    if (pageId !== undefined) {
      const tab = opening.tabs.find(candidate => candidate.targetId === pageId)
      if (tab === undefined) {
        // The page went away between the tab list the client read and this
        // socket: say so with the browser's own truth, and let the tab close.
        send({ type: 'status', status: opening })
        client.close()
        return
      }
      send({ type: 'status', status: { ...opening, url: tab.url } })
    } else {
      send({ type: 'status', status: opening })
    }
  } catch (error) {
    // A page the viewer named that turned out not to exist: the pane is told
    // rather than left waiting for frames that will never come.
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    release()
    client.close()
  }
}

/**
 * The refusal for a viewer that names a page of a browser that does not exist.
 * @param sessionId - the session the viewer named.
 * @returns an error carrying that sentence, typed as the browser it stands in for.
 */
function missing(sessionId: string): never {
  throw new Error(`dsh-browser: session ${sessionId} has no browser to watch`)
}

/**
 * Apply one viewer message.
 * @param raw - the received text frame.
 * @param browser - the session's browser to act on.
 * @param pageId - the page this viewer named, when it named one.
 * @param reply - how the one message that answers (`selection`) sends its answer.
 * @throws {Error} when the message is malformed or names an unknown verb.
 */
async function handleMessage(
  raw: string,
  browser: SessionBrowser,
  pageId: string | undefined,
  reply: (text: string) => void,
): Promise<void> {
  const parsed = JSON.parse(raw) as { readonly type?: unknown }
  switch (parsed.type) {
    case 'input':
      await browser.input((parsed as { message: InputMessage }).message, pageId)
      return
    // The pane's clipboard is the user's browser's; the selection is the
    // mirrored page's. Only the host can read the second one, so the pane asks.
    case 'selection':
      reply(await browser.selectionText(pageId))
      return
    case 'navigate':
      // A viewer that named a page navigates that page; the un-named one acts
      // on the active page, as it did before pages had names.
      if (pageId === undefined) await browser.navigate(String((parsed as { url: unknown }).url))
      else await browser.navigatePage(pageId, String((parsed as { url: unknown }).url))
      return
    case 'reload':
      if (pageId === undefined) await browser.reload()
      else await browser.reloadPage(pageId)
      return
    // The pane's own two controls for a browser it cannot use: one throws away
    // a browser that is gone or broken, the other stops one that is fine — and
    // asking for it to stop is what keeps it stopped.
    case 'restart':
      await browser.restart()
      return
    case 'close':
      // Closing the viewer's page is what closing its tab does; the un-named
      // viewer of an older pane stops the whole browser, as its button did.
      if (pageId === undefined) await browser.stop()
      else await browser.closePage(pageId)
      return
    default:
      throw new Error(`dsh-browser: unknown viewer message ${JSON.stringify(parsed.type)}`)
  }
}
