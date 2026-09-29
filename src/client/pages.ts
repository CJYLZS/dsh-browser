/**
 * What the client half knows about a browser's pages, and the one rule that
 * keeps the Sidebar's tabs matched to them.
 *
 * A page's stable identity is its CDP target id — the same string external
 * DevTools sees — and a tab's address is built from it, so a tab keeps naming
 * its page across navigations, active-page changes, and client reloads. The
 * sync loop reads the host's report and reconciles: one tab per page the
 * browser holds, no tab for a page it does not.
 */

/** The address scheme a browser page's tab is recorded under. */
export const PAGE_PREFIX = 'dsh-resource://dsh-browser-page/'

/**
 * The address a page's tab carries.
 * @param targetId - the page's CDP target id.
 * @returns the address to open the tab with.
 */
export function pageAddressOf(targetId: string): string {
  return PAGE_PREFIX + encodeURIComponent(targetId)
}

/**
 * The page a tab address names.
 * @param address - the tab's content id.
 * @returns the page's CDP target id, or `undefined` for an address that is not a page's.
 */
export function targetIdOf(address: string): string | undefined {
  if (!address.startsWith(PAGE_PREFIX)) return undefined
  const rest = address.slice(PAGE_PREFIX.length)
  if (rest === '') return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    // A malformed tail is still an attempt at a name; hand it back as it came.
    return rest
  }
}

/** One tab the Sidebar already shows, as the reconciliation reads it. */
export interface ActualTab {
  /** The tab's own id, for closing it. */
  readonly id: string
  /** What the tab names: a page address, or a legacy page-type address. */
  readonly contentId: string
}

/**
 * The one rule: a tab for every page the browser holds, and none for a page it
 * does not.
 *
 * Tabs that name a page are closed the moment their page is gone. A tab that
 * names no page — the guide entry's, which exists to start a browser nobody is
 * watching yet — is kept until there are page tabs to hand the story to, so
 * picking the entry still opens a pane while the browser is starting.
 * @param desired - the page addresses the browser holds, in tab order.
 * @param actual - the tabs of this kind the Sidebar already shows.
 * @returns what to open and what to close.
 */
export function reconcile(
  desired: readonly string[],
  actual: readonly ActualTab[],
): { open: string[]; close: string[] } {
  const held = new Set(actual.map(tab => tab.contentId))
  const open: string[] = []
  for (const address of desired) {
    if (!held.has(address)) open.push(address)
  }
  const wanted = new Set(desired)
  const close: string[] = []
  for (const tab of actual) {
    const isPageTab = targetIdOf(tab.contentId) !== undefined
    if (isPageTab && !wanted.has(tab.contentId)) close.push(tab.id)
    // The un-named tab hands over once page tabs exist, and not before: while
    // the browser is starting it is the only pane there is.
    if (!isPageTab && desired.length > 0) close.push(tab.id)
  }
  return { open, close }
}

/**
 * Pages a close was asked for, so the loop does not open a tab for a page that
 * is on its way out.
 *
 * Closing a tab closes its page, and the host's report is a snapshot: for a
 * moment after the ask, the page is still listed. Without this the loop would
 * read that moment as "a page with no tab" and put the tab back.
 */
const closing = new Map<string, number>()

/** How long a close ask stands, when the report never stops listing the page. */
const CLOSING_TIMEOUT_MS = 15_000

/**
 * Record that a page's close was asked for.
 * @param sessionId - the session whose browser holds the page.
 * @param targetId - the page's CDP target id.
 * @param at - when the ask was made; defaults to now (tests hand a fixed one).
 */
export function markClosing(sessionId: string, targetId: string, at: number = Date.now()): void {
  closing.set(`${sessionId}\n${targetId}`, at)
}

/**
 * Whether a page's close was asked for and is not yet known to have happened.
 * @param sessionId - the session whose browser holds the page.
 * @param targetId - the page's CDP target id.
 */
export function isClosing(sessionId: string, targetId: string): boolean {
  return closing.has(`${sessionId}\n${targetId}`)
}

/**
 * Drop the asks that have answered.
 *
 * A page the report no longer lists is one the close reached; the rest expire,
 * which is what brings a tab back when a close could not be carried out — the
 * page is still there, so a tab for it is the honest picture.
 * @param listed - every page still reported, as `sessionId` and target id pairs.
 * @param now - the time to expire against.
 */
export function settleClosing(listed: Iterable<readonly [string, string]>, now: number): void {
  const stillThere = new Set([...listed].map(([sessionId, targetId]) => `${sessionId}\n${targetId}`))
  for (const [key, at] of [...closing]) {
    if (!stillThere.has(key) || now - at > CLOSING_TIMEOUT_MS) closing.delete(key)
  }
}

/** What the host said about one page, as the tab chip and the loop read it. */
export interface PageFacts {
  /** What the page says its title is. */
  readonly title: string
  /** The address the page is on. */
  readonly url: string
}

/** Page facts by tab address; replaced wholesale only when something changed. */
let facts: ReadonlyMap<string, PageFacts> = new Map()
const listeners = new Set<() => void>()

/**
 * Replace the page facts the report produced.
 *
 * Unchanged entries keep their object, so a reader that compares references
 * (React's snapshot contract) sees no change when nothing changed — a poll
 * that learned nothing must not re-render a chip.
 * @param entries - one address and its facts per page the host reported.
 */
export function publishPageFacts(entries: Iterable<readonly [string, PageFacts]>): void {
  const next = new Map<string, PageFacts>()
  let changed = false
  for (const [address, page] of entries) {
    const previous = facts.get(address)
    const same = previous !== undefined && previous.title === page.title && previous.url === page.url
    if (!same) changed = true
    next.set(address, same ? previous : page)
  }
  // A page the report stopped listing is a change the loop above cannot see.
  if (next.size !== facts.size) changed = true
  if (!changed) return
  facts = next
  for (const listener of [...listeners]) listener()
}

/**
 * The facts of one page's tab.
 * @param address - the tab's content id.
 * @returns the facts, or `undefined` before the first report named that page.
 */
export function pageFactsOf(address: string): PageFacts | undefined {
  return facts.get(address)
}

/**
 * Observe page facts.
 * @param listener - called when a fact changed.
 * @returns unsubscribe callback.
 */
export function subscribePageFacts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
