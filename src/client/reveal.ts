/**
 * Keep the Sidebar's browser tabs matched to the browser's pages.
 *
 * The browser belongs to the Session; its pages belong to the user's eyes. A
 * link that opens a tab, a `window.open`, a page that closes itself — each one
 * changes a page set the user cannot see anywhere else, and a sidebar that
 * stayed as it was would show a browser the user cannot recognize: tabs for
 * pages that are gone, no tab for the page that just came up. So the client
 * half reads the host's report on a fixed beat and reconciles every session it
 * names: one tab per page the browser holds, named by the page's CDP target id,
 * and none for a page it does not.
 *
 * Closing follows the same rule in reverse, and it is why the match can be
 * unconditional: closing a tab closes that tab's page (the close handler asks
 * the host), so a tab the user closed is a page that is gone — there is no
 * state where the sidebar shows less than the browser and something must put
 * it back. The one race — the report still listing a page whose close was just
 * asked for — is what the closing ledger is for.
 *
 * The route is polled rather than pushed because this half has no channel of
 * its own to the host: the viewer socket exists only once a pane is open, and
 * most of the changes this follows happen with every pane closed.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { browserStatus, type ClientBrowserStatus } from './api.ts'
import { BROWSER_KIND } from './definition.ts'
import {
  isClosing,
  pageAddressOf,
  publishPageFacts,
  reconcile,
  settleClosing,
  targetIdOf,
  type ActualTab,
} from './pages.ts'

/** How long the loop waits between looks at the host's browser state. */
const POLL_MS = 1500

/**
 * Read the host's report once and bring every named session's tabs in line
 * with its pages.
 * @param ctx - client context carrying the Sidebar's navigation face.
 * @param report - what the host last answered.
 */
export function followOneReport(ctx: ClientContext, report: { readonly instances: readonly ClientBrowserStatus[] }): void {
  // The chips' facts are for every session the host named: a tab in a session
  // the user is only about to visit shows its page's title all the same.
  const facts: [string, { title: string; url: string }][] = []
  /** The pages each session holds, by session id. */
  const wanted = new Map<string, string[]>()
  for (const instance of report.instances) {
    const addresses: string[] = []
    for (const tab of instance.tabs ?? []) {
      if (tab.targetId === undefined) continue
      const address = pageAddressOf(tab.targetId)
      addresses.push(address)
      facts.push([address, { title: tab.title ?? '', url: tab.url }])
    }
    wanted.set(instance.sessionId, addresses)
  }
  publishPageFacts(facts)
  // A close that has answered is no longer a reason to hold a tab back.
  const listed: (readonly [string, string])[] = []
  for (const instance of report.instances) {
    for (const tab of instance.tabs ?? []) {
      if (tab.targetId !== undefined) listed.push([instance.sessionId, tab.targetId])
    }
  }
  settleClosing(listed, Date.now())

  for (const [sessionId, addresses] of wanted) {
    const actual: ActualTab[] = ctx.sidebarRight.openTabs.getSnapshot()
      .filter(tab => tab.kind === BROWSER_KIND && tab.sessionId === sessionId)
      .map(tab => ({ id: tab.tabId, contentId: tab.contentId }))
    const plan = reconcile(addresses, actual)
    for (const tabId of plan.close) {
      // A tab that names a page which is gone closes quietly; the close
      // handler fires for it too, and the host answers "no such page" — which
      // is exactly the truth, and changes nothing.
      ctx.sidebarRight.closeIn(sessionId as SessionId, tabId as TabId)
    }
    for (const address of plan.open) {
      const targetId = targetIdOf(address)
      if (targetId === undefined || isClosing(sessionId, targetId)) continue
      ctx.sidebarRight.openResourceIn(sessionId as SessionId, address)
    }
  }
}

/**
 * Follow the host's browser state for as long as the plugin is loaded, and keep
 * every session's browser tabs matched to its pages.
 * @param ctx - client context carrying the Sidebar's navigation face.
 */
export function followBrowserPages(ctx: ClientContext): void {
  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let looking = false
    let stopped = false

    /** Read the host's state once, and reconcile every session it named. */
    const look = async (): Promise<void> => {
      if (looking || stopped) return
      looking = true
      try {
        const report = await browserStatus()
        if (stopped) return
        followOneReport(ctx, report)
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
    follow()
    return () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'dsh-browser: keep sidebar tabs matched to the browser pages')
}
