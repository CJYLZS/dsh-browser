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
