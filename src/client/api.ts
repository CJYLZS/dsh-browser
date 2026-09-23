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
  /** Whether this is the page the tools and the mirror act on. */
  readonly active: boolean
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
