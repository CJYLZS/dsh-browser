/**
 * Browser-side read of the host's live browser state.
 *
 * Plain same-origin fetch against the plugin's own route, the way the other
 * plugin in this profile talks to its host half. The route applies the same
 * trust check as the viewer socket, so the browser's authentication cookie is
 * what makes this succeed.
 */

/** Lifecycle of one session's browser, as the settings page reports it. */
export type ClientBrowserState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed'

/** One page a session's browser holds open. */
export interface ClientTab {
  /** Position in the browser's own page list. */
  readonly index: number
  /** Address the page reports. */
  readonly url: string
  /** Whether this is the page the tools act on. */
  readonly active: boolean
  /**
   * The page's CDP target id — its stable identity, and what the sidebar's own
   * tab for it is addressed by. Absent only in the moment between a page
   * existing and its session answering for it.
   */
  readonly targetId?: string
  /** What the page last said its title was, when that is known. */
  readonly title?: string
}

/** What the host says about one session's browser. */
export interface ClientBrowserStatus {
  /** The session this browser belongs to. */
  readonly sessionId: string
  /**
   * The session's title, when the host could read one.
   *
   * A session id is not a name: every id starts with `session-` and the rest is
   * hexadecimal. What a person recognizes is the title, and the harness has one
   * for every conversation that has said anything.
   */
  readonly title?: string | undefined
  readonly state: ClientBrowserState
  /** External CDP port once the browser runs. */
  readonly debugPort?: number | undefined
  /** State the current instance was started through, e.g. `headless`. */
  readonly mode?: string | undefined
  /** Address the active page is on. */
  readonly url?: string | undefined
  /** Open pages, in the browser's own order. */
  readonly tabs?: readonly ClientTab[] | undefined
  /** Why the browser is unusable, when it is. */
  readonly error?: string | undefined
}

/** Every browser the plugin is running. */
export interface ClientBrowserReport {
  /** How many session browsers may run at once. */
  readonly maxInstances: number
  /** One entry per session that has a browser. */
  readonly instances: readonly ClientBrowserStatus[]
}

/**
 * Read the live browser state.
 * @returns every session's browser, as the host sees it.
 * @throws {Error} when the route refuses or the answer is not a report.
 */
export async function browserStatus(): Promise<ClientBrowserReport> {
  const response = await fetch('/dsh-browser/status', { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as ClientBrowserReport
}

/**
 * Ask the host for a new page in one session's browser.
 *
 * The Sidebar's browser entry is the caller: the pane that asks exists to hold
 * the page this produces, and one ask is one page — a browser already running
 * gets another blank one rather than the tab that is already there.
 * `request` is the asking tab's own id, so a pane remounted by a tab switch, a
 * Session change, or a client reload is the same ask and opens nothing new.
 * @param sessionId - the session whose browser should open a page.
 * @param request - the asking tab's id.
 * @param url - address to load in the new page; a blank page when absent.
 * @returns the new page's CDP target id, when the host named it.
 * @throws {Error} when the route refuses or the browser cannot start.
 */
export async function openPageRequest(sessionId: string, request: string, url?: string): Promise<string | undefined> {
  const response = await fetch('/dsh-browser/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'open',
      sessionId,
      request,
      ...url === undefined ? {} : { url },
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const answer = await response.json() as { targetId?: unknown }
  return typeof answer.targetId === 'string' ? answer.targetId : undefined
}

/**
 * Ask the host to close one browser page.
 *
 * This is what closing a sidebar tab does to the page it mirrored: the tab's
 * own close handler fires here, before the tab is removed. The host decides
 * what the close means — one page among several closes alone, the last one
 * stops the browser — so the client never has to count pages it cannot see.
 * @param sessionId - the session whose browser holds the page.
 * @param targetId - the page's CDP target id.
 * @throws {Error} when the route refuses.
 */
export async function closePageRequest(sessionId: string, targetId: string): Promise<void> {
  const response = await fetch('/dsh-browser/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, targetId }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/**
 * Ask the host to stop one session's browser, and every page it holds.
 *
 * This is the settings page's control, and it is the one ask in the plugin that
 * means "this conversation does not want a browser" rather than "close the page
 * I am looking at". The host decides what that costs: it stops the browser, and
 * a viewer coming back does not start another.
 * @param sessionId - the session whose browser should stop.
 * @throws {Error} when the route refuses.
 */
export async function closeBrowserRequest(sessionId: string): Promise<void> {
  const response = await fetch('/dsh-browser/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'close', sessionId, all: true }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/** What the pane's restart control has to do to get a browser back. */
export type RestartRoute =
  /** A viewer socket is up: the host already holds this viewer, so ask there. */
  | { readonly via: 'socket' }
  /** No socket: watch never starts a browser, so the page ask is the only path. */
  | { readonly via: 'http' }
  /** No socket and no tab to ask under; there is nothing this pane can start. */
  | { readonly via: 'none' }

/**
 * Decide how the restart control reaches the host.
 *
 * The control exists for a browser the pane cannot use, and the pane loses its
 * socket in exactly the case that matters: watching never starts a browser, so
 * after a close from the settings page the host refuses the subscription and
 * closes the socket. A message sent then is dropped in silence, which is how
 * this control came to do nothing when it was most needed. The page ask over
 * HTTP is the one path that does start a browser.
 * @param socketOpen - whether the viewer socket is open right now.
 * @param tabId - the asking tab's id, which the HTTP ask must carry.
 * @returns the route the caller should take.
 */
export function restartRoute(socketOpen: boolean, tabId: string | undefined): RestartRoute {
  if (socketOpen) return { via: 'socket' }
  if (tabId !== undefined && tabId !== '') return { via: 'http' }
  return { via: 'none' }
}

