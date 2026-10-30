/**
 * Reloading the client half: what a second load in the same page meets.
 *
 * A plugin is not loaded once per page. Settings → Plugins → "retry page sync",
 * the HMR path (`reload(id, rev)`), and `reconcile()`'s `replace()` all re-run
 * the plugin body on the same page without a reload — and the Sidebar's
 * controller lives in a resident module, so its registrations outlive the
 * plugin's fiber. A registration whose cleanup is dropped therefore poisons
 * every following cycle: the second load throws, the entry goes `FAILED`, and
 * since `reconcile()` keeps re-applying the failed entry the client half is
 * dead for that page until a full reload.
 *
 * The contract is on the method: `registerCloseHandler` returns "an
 * effect-scoped unregister callback". These tests drive the real cordis fiber
 * lifecycle (`ctx.plugin` / `dispose`) against a controller that copies the
 * guard and the disposer from `@deepseek-ai/dsh-client-ui-sidebar-right`, so
 * "the callback was dropped" fails as a leak rather than being a style note.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { followPageCloses } from '../src/client/close.ts'
import { BROWSER_KIND } from '../src/client/definition.ts'
import { isClosing, PAGE_PREFIX } from '../src/client/pages.ts'

/**
 * The Sidebar's controller, reduced to the close-handler map and its
 * "one handler per kind" guard. Both the guard and the returned disposer are
 * copied verbatim from `SidebarRightController`, which is where the throw in
 * the issue comes from.
 */
class FakeSidebarRight {
  /** Registered close handlers, by tab kind. */
  readonly closeHandlers = new Map<string, unknown>()

  /**
   * Register resource cleanup before explicit removal. Failure preserves the tab.
   * @param kind - tab kind owned by the registering plugin.
   * @param handler - what the Sidebar calls before removing a tab of that kind.
   * @returns an effect-scoped unregister callback.
   */
  registerCloseHandler(kind: string, handler: unknown): () => void {
    if (this.closeHandlers.has(kind)) throw new Error(`sidebarRight: close handler already registered for ${kind}`)
    this.closeHandlers.set(kind, handler)
    return () => {
      if (this.closeHandlers.get(kind) === handler) this.closeHandlers.delete(kind)
    }
  }
}

/** One tab, as the Sidebar hands it to a close handler. */
interface Tab {
  readonly id: string
  readonly kind: string
  readonly contentId: string
  readonly title: string
}

/** The plugin entry the loader starts: the module's own body, on a real fiber. */
const plugin = {
  name: 'dsh-browser',
  inject: ['sidebarRight'],
  apply: (ctx: Context): void => { followPageCloses(ctx) },
}

/**
 * A page's Sidebar, provided on a fresh root context.
 * @returns the root and the controller it resolves `sidebarRight` to.
 */
function page(): { root: Context; sidebarRight: FakeSidebarRight } {
  const sidebarRight = new FakeSidebarRight()
  const root = new Context()
  root.provide('sidebarRight', sidebarRight)
  return { root, sidebarRight }
}

/**
 * Load the plugin once and unload it.
 * @param root - the page's context.
 */
async function cycle(root: Context): Promise<void> {
  const fiber = root.plugin(plugin)
  await fiber
  await fiber.dispose()
}

/**
 * Answer every request with a documented success, recording what was asked.
 * @returns the decoded bodies and a restore function.
 */
function recordingFetch(): { sent: { sessionId: string; targetId: string }[]; restore: () => void } {
  const realFetch = globalThis.fetch
  const sent: { sessionId: string; targetId: string }[] = []
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as { sessionId: string; targetId: string })
    return new Response('{"ok":true}', { status: 200 })
  }) as typeof fetch
  return { sent, restore: () => { globalThis.fetch = realFetch } }
}

test('loading the plugin a second time in one page does not throw', async () => {
  // The issue's reproduction: load → unload → load, three times over. Before
  // the fix the second cycle threw `sidebarRight: close handler already
  // registered for cdpBrowser`, and because the entry then stays failed,
  // repeating it never recovered.
  const { root, sidebarRight } = page()
  for (let cycleNumber = 1; cycleNumber <= 3; cycleNumber++) {
    try {
      await cycle(root)
    } catch (error) {
      assert.fail(`cycle ${cycleNumber} of load→unload threw: ${(error as Error).message}`)
    }
    assert.equal(
      sidebarRight.closeHandlers.size,
      0,
      `cycle ${cycleNumber} left a close handler registered after unload`,
    )
  }
})

test('a loaded plugin holds exactly one handler, and unloading it releases that handler', async () => {
  // The effect must actually run — a fix that registered nothing would also
  // pass the test above.
  const { root, sidebarRight } = page()
  const fiber = root.plugin(plugin)
  await fiber
  assert.ok(
    sidebarRight.closeHandlers.has(BROWSER_KIND),
    'the close handler was not registered while the plugin was loaded',
  )
  await fiber.dispose()
  assert.equal(sidebarRight.closeHandlers.size, 0, 'the close handler outlived its fiber')
})

test('the handler a reload leaves behind still closes the page it names', async () => {
  // Scoping the registration must not change what the handler does: after a
  // reload the new handler is the one the Sidebar calls, and it must still
  // name the page rather than the tab, and hold the tab back from the loop.
  const { root, sidebarRight } = page()
  const { sent, restore } = recordingFetch()
  try {
    await cycle(root)
    const fiber = root.plugin(plugin)
    await fiber
    const handler = sidebarRight.closeHandlers.get(BROWSER_KIND) as (sessionId: string, tab: Tab) => void
    const tab: Tab = { id: 't1', kind: BROWSER_KIND, contentId: `${PAGE_PREFIX}target-7`, title: 'A page' }
    handler('session-a', tab)
    assert.deepEqual(sent, [{ sessionId: 'session-a', targetId: 'target-7' }], 'the close named the wrong page')
    assert.equal(isClosing('session-a', 'target-7'), true, 'the closing ledger does not hold the tab back')
    await fiber.dispose()
  } finally {
    restore()
  }
})

test("closing the guide entry's tab sends nothing", async () => {
  // The guide entry's tab names no page, so there is nothing to close: that
  // tab is the one whose appearance must not close a browser.
  const { root, sidebarRight } = page()
  const { sent, restore } = recordingFetch()
  try {
    const fiber = root.plugin(plugin)
    await fiber
    const handler = sidebarRight.closeHandlers.get(BROWSER_KIND) as (sessionId: string, tab: Tab) => void
    handler('session-a', { id: 't0', kind: BROWSER_KIND, contentId: 'sidebar://cdpBrowser', title: 'Browser' })
    assert.deepEqual(sent, [], 'closing the guide entry asked the host to close something')
    await fiber.dispose()
  } finally {
    restore()
  }
})

test('the page body registers no close handler of its own', () => {
  // The handler's lifetime is `close.ts`'s to scope. A second registration in
  // the body is exactly the shape that broke: a bare call whose disposer has
  // nowhere to go. Index registers the plugin's other surfaces and delegates.
  const body = readFileSync('src/client/index.ts', 'utf8')
  assert.equal(
    body.includes('registerCloseHandler'),
    false,
    'index.ts registers a close handler directly; it must go through followPageCloses()',
  )
  assert.match(body, /followPageCloses\(ctx\)/u, 'index.ts no longer registers the close handler at all')
})
