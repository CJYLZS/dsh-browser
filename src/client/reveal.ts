/**
 * Bring the browser's pane forward when a browser starts for the Session on
 * screen.
 *
 * The browser belongs to the Session, not to the pane. An agent that starts one
 * while nobody is watching drives a page the user cannot see, and its results
 * ("Clicked link …", a screenshot) land in a conversation beside an empty
 * column. So the client half watches the host's own status route and, the moment
 * the mounted Session's browser goes from not running to running, opens the pane
 * for it — and opening a tab expands the column in the same step, so the
 * Sidebar comes up already showing the page.
 *
 * What it watches for is a *change*, not a state. A browser that was already
 * running when the pane was closed stays closed: closing the observer is not a
 * request to open it again, and neither is switching Sidebar tabs. A browser the
 * user stopped comes back only when something asks for one — the next tool call,
 * or the restart control — and that is a change again, so the pane returns with
 * it.
 *
 * The route is polled rather than pushed because this half has no channel of its
 * own to the host: the viewer socket exists only once the pane is open, which is
 * exactly the case this is about.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { browserStatus, type ClientBrowserState } from './api.ts'
import { BROWSER_KIND } from './definition.ts'

/** How long the pane waits between looks at the host's browser state. */
const POLL_MS = 1500

/**
 * Whether a browser is up and asking to be watched.
 * @param state - the reported state, or `undefined` while the Session has no browser.
 * @returns whether a browser is starting or running.
 */
function running(state: ClientBrowserState | undefined): boolean {
  return state === 'starting' || state === 'ready'
}

/**
 * Whether a status change is the moment to bring the pane forward.
 *
 * A Session the route has never reported counts as not running, which is what
 * makes the first tool call of a conversation reveal the browser: the instance
 * appears in the report the moment a tool asks the pool for it. The cost of that
 * choice is that a browser already running when the client loads — a page reload
 * during a long turn — reveals itself too, which is the same story told late.
 * @param previous - the state last reported for this Session.
 * @param next - the state reported now.
 * @returns whether a browser that was not running is running now.
 */
export function justStarted(
  previous: ClientBrowserState | undefined,
  next: ClientBrowserState | undefined,
): boolean {
  return !running(previous) && running(next)
}

/**
 * Follow the host's browser state for the mounted Session, and open the browser's
 * pane when a browser starts.
 * @param ctx - client context carrying the Sidebar's navigation face.
 */
export function revealOnBrowserStart(ctx: ClientContext): void {
  ctx.effect(() => {
    /** The state last reported for each Session, so a start is visible as a change. */
    const seen = new Map<string, ClientBrowserState | undefined>()
    let timer: ReturnType<typeof setInterval> | undefined
    let looking = false
    let stopped = false

    /** Whether the mounted Session already shows this browser in its pane. */
    const watched = (sessionId: SessionId): boolean =>
      ctx.sidebarRight.tabsIn(sessionId).some(tab => tab.kind === BROWSER_KIND)

    /** Read the host's state once, and open the pane if a browser just started. */
    const look = async (): Promise<void> => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      // A pane that is already open needs nothing, and looking while it is open
      // would only spend a request: what this watches for is a browser starting
      // behind a closed pane.
      if (sessionId === undefined || looking || stopped || watched(sessionId)) return
      looking = true
      try {
        const report = await browserStatus()
        if (stopped) return
        for (const instance of report.instances) {
          const previous = seen.get(instance.sessionId)
          seen.set(instance.sessionId, instance.state)
          if (instance.sessionId !== sessionId) continue
          if (justStarted(previous, instance.state)) ctx.sidebarRight.openTabIn(sessionId, BROWSER_KIND)
        }
      } catch {
        // An unanswered read is not a browser event; the next look tries again.
      } finally {
        looking = false
      }
    }

    const follow = (): void => {
      if (timer !== undefined) clearInterval(timer)
      timer = setInterval(() => { void look() }, POLL_MS)
      void look()
    }
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(follow)
    follow()
    return () => {
      stopped = true
      unsubscribe()
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'dsh-browser: reveal the pane when a browser starts')
}
