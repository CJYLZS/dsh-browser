/**
 * The viewer transport: one WebSocket carrying frames down and input up.
 *
 * A viewer names the session it wants to watch, and the route looks that
 * session's browser up in the pool. That parameter is the only thing standing
 * between two conversations, so it is required: a viewer that names no session
 * is refused rather than handed whichever browser happens to exist.
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

/**
 * The session a viewer named.
 * @param request - the upgrade request.
 * @returns the session id, or `undefined` when it named none.
 */
function sessionOf(request: IncomingMessage): string | undefined {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const named = url.searchParams.get(SESSION_PARAM)
  return named === null || named === '' ? undefined : named
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
          const sessionId = sessionOf(request)
          if (sessionId === undefined) {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            socket.destroy()
            return
          }
          server.handleUpgrade(request, socket, head, (client) => { attach(client, pool, sessionId) })
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
 */
function attach(client: WebSocket, pool: BrowserPool, sessionId: string): void {
  const send = (value: unknown): void => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(value))
  }
  let browser: SessionBrowser
  try {
    browser = pool.get(sessionId)
  } catch (error) {
    // The socket is already upgraded, so the refusal travels as a message the
    // pane can show rather than as a status code nobody will see.
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    client.close()
    return
  }
  const stopFrames = browser.addViewer((frame) => {
    if (client.readyState === client.OPEN) client.send(frame.jpeg, { binary: true })
  })
  const stopStatus = browser.watch(status => { send({ type: 'status', status }) })
  // The viewer renders before the browser has started, so the opening snapshot
  // is what tells it whether it is waiting, mirroring, or looking at a failure.
  send({ type: 'status', status: browser.status() })

  client.on('message', (raw, isBinary) => {
    if (isBinary) return
    void handleMessage(String(raw), browser).catch((error: unknown) => {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  })
  const release = (): void => {
    stopStatus()
    stopFrames()
  }
  client.on('close', release)
  client.on('error', release)
}

/**
 * Apply one viewer message.
 * @param raw - the received text frame.
 * @param browser - the session's browser to act on.
 * @throws {Error} when the message is malformed or names an unknown verb.
 */
async function handleMessage(raw: string, browser: SessionBrowser): Promise<void> {
  const parsed = JSON.parse(raw) as { readonly type?: unknown }
  switch (parsed.type) {
    case 'input':
      await browser.input((parsed as { message: InputMessage }).message)
      return
    case 'navigate':
      await browser.navigate(String((parsed as { url: unknown }).url))
      return
    case 'reload':
      await browser.reload()
      return
    // The pane's own two controls for a browser it cannot use: one throws away
    // a browser that is gone or broken, the other stops one that is fine — and
    // asking for it to stop is what keeps it stopped.
    case 'restart':
      await browser.restart()
      return
    case 'close':
      await browser.stop()
      return
    default:
      throw new Error(`dsh-browser: unknown viewer message ${JSON.stringify(parsed.type)}`)
  }
}
