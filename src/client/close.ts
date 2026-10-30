/**
 * Closing a tab closes the page it mirrors.
 *
 * The Sidebar asks a kind's close handler before it removes a tab, which is
 * what makes the rule hold no matter how the close arrived — the strip's ✕, a
 * menu, or the pane itself. The handler only records the ask and sends it on:
 * the tab is going away either way, and a close that never lands brings the
 * tab back on a later look at the host's report (`reveal.ts`).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { closePageRequest } from './api.ts'
import { BROWSER_KIND } from './definition.ts'
import { markClosing, targetIdOf } from './pages.ts'

/**
 * Register the close handler for the browser's tabs.
 *
 * The registration is scoped to the plugin's fiber: `registerCloseHandler`
 * returns the disposer that takes the entry out of the Sidebar's map, and a
 * resident controller's map outlives a plugin that is applied again in the same
 * page. Dropping that disposer makes the second apply throw "close handler
 * already registered", which leaves the client half dead for that page until a
 * full reload — every other registration in `index.ts` is effect-scoped for
 * exactly this reason.
 * @param ctx - client context carrying the Sidebar's registry.
 */
export function followPageCloses(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(BROWSER_KIND, (sessionId, tab) => {
    const targetId = targetIdOf(tab.contentId)
    // A tab that names no page (the guide entry's) has nothing to close.
    if (targetId === undefined) return
    markClosing(sessionId, targetId)
    // The tab is going away either way; the close travels on its own, and a
    // close that never lands brings the tab back on a later look.
    void closePageRequest(sessionId, targetId).catch(() => {})
  }), 'dsh-browser: close handler')
}
