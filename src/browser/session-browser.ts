/**
 * One session's browser: its process, its profile, its pages, its viewers.
 *
 * Every conversation that uses the browser gets one of these, and nothing it
 * does is visible to another session — a link opened in one conversation does
 * not appear in the next one's tabs, and neither does a login. The cost is the
 * one a browser charges for it: profiles are per session, so a site signed into
 * in one conversation starts signed out in another.
 *
 * Launch is lazy and single-flight: the first viewer or tool call starts the
 * process, and concurrent callers join the same start. Frame production follows
 * the viewer count — `Page.startScreencast` is repaint-driven and costs the
 * renderer every frame, so a mirror nobody watches keeps the browser alive but
 * stops streaming.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, CDPSession, Dialog, Page } from 'playwright-core'
import type { BrowserConfig } from '../config.ts'
import { listOf } from '../config.ts'
import type { BrowserSession, LaunchConfig } from './launch.ts'
import {
  formatAxTree,
  parseQuery,
  RefLabels,
  refTargetOf,
  centerOfQuad,
  type AxNode,
  type AxSnapshot,
  type Box,
  type RefTarget,
  type SnapshotOptions,
  type SnapshotTarget,
} from './aria.ts'
import { pageInfoFromMetrics, type PageInfo } from './page-info.ts'
import { PortAllocator } from './ports.ts'
import { profileDirFor } from './profile.ts'
import {
  entryInTree,
  locateAmbiguousError,
  locateInTree,
  locateMissError,
  locatorIsTreeShaped,
  type Locator,
  type Located,
} from './locate.ts'
import { startScreencast, type MirrorFrame } from './screencast.ts'
import { dispatchInput, scaleToViewport, type InputMessage, type MouseButton } from './input.ts'

/** Lifecycle of one session's browser as its viewers and tools see it. */
export type BrowserState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed'

/** One page the browser holds open, as a tool or a viewer describes it. */
export interface TabSummary {
  /** Position in the browser's own page list. */
  readonly index: number
  /** Address the page reports. */
  readonly url: string
  /** Whether this is the page the tools and the mirror act on. */
  readonly active: boolean
}

/** Everything a viewer needs to say what it is looking at. */
export interface BrowserStatus {
  /** The session this browser belongs to. */
  readonly sessionId: string
  readonly state: BrowserState
  /** External CDP port once the browser runs, else `undefined`. */
  readonly debugPort: number | undefined
  /** Browser version string reported by the CDP listener. */
  readonly version: string | undefined
  /** Address shown in the active page, when one is loaded. */
  readonly url: string | undefined
  /**
   * Window mode the running instance was started with, or `undefined` while
   * none runs. Read from the launch rather than from the current configuration,
   * so a pending restart never reports the mode of a browser that is not up.
   */
  readonly mode: string | undefined
  /** Open pages, in the browser's own order. */
  readonly tabs: readonly TabSummary[]
  /** Why the browser is unusable, when it is. */
  readonly error: string | undefined
}

/** Receives every mirrored frame while subscribed. */
export type FrameListener = (frame: MirrorFrame) => void

/** Starts a browser; the seam that keeps this class testable without one. */
export type Launcher = (config: LaunchConfig, userDataDir: string) => Promise<BrowserSession>

/** The logging this class needs, satisfied by a cordis logger. */
export interface Logger {
  /** Record something that happened. */
  info(message: string): void
  /** Record something that went wrong. */
  warn(error: Error): void
}

/** What a session browser is built from. */
export interface SessionBrowserDeps {
  /** Configuration the browser launches with. */
  readonly config: BrowserConfig
  /** Owner of the CDP port this browser listens on. */
  readonly ports: PortAllocator
  /** Starts the process. */
  readonly launch: Launcher
  /** Where launch outcomes are reported. */
  readonly logger: Logger
}

/** How long a measured viewport is trusted before it is read again, in milliseconds. */
const VIEWPORT_TTL_MS = 1_000

/** What a browser that vanished without being asked to is reported as. */
const DIED_REASON = 'the browser was closed or crashed'

/**
 * How long a page must stay still before an action is called settled.
 *
 * Short enough not to tax a page that is already done, long enough that a
 * client-rendered menu or a filtered list has drawn by the time the result is
 * written. This is Playwright MCP's default settle window, for the same reason.
 */
const SETTLE_QUIET_MS = 500

/**
 * How many of the changes one action caused are itemised, and how long anything
 * one of them says may be.
 *
 * An action result is read on every call, so its detail is bounded the way a
 * snapshot's is: the first few changes answer "what did my click do", and the
 * count of what was left out says whether there is more to look at. The same
 * bound is applied again on this side, because the summary arrives from the page
 * and a page is not the authority on how long a tool result may be.
 */
const CHANGE_LIMIT = 5
const CHANGE_TEXT_MAX = 60

/**
 * How many things one page may have said before the oldest are dropped.
 *
 * A page that logs in a loop — a progress ticker, a React warning per render —
 * would otherwise grow this buffer for as long as the tab is open, and this runs
 * on a page nobody is watching. The count of dropped entries is reported, so a
 * caller sees a filled buffer as a filled buffer rather than as a quiet page.
 */
const CONSOLE_LIMIT = 200

/** Longest one console message may be before it is clipped, in characters. */
const CONSOLE_TEXT_MAX = 500

/** Longest an action waits for a page to stop changing. */
const SETTLE_MAX_MS = 3_000

/**
 * How long one attempt to stop a cancelled call's page is given.
 *
 * A page that is answering stops its load or terminates its script within a
 * frame. One that has not answered by now is not going to, and waiting longer
 * only holds up the call that has already given up.
 */
const INTERRUPT_QUIET_MS = 1_000

/**
 * How long the mirror is given to attach before the browser is reported ready.
 *
 * The mirror is a view of the browser, not the browser: a page that will not
 * answer `Page.startScreencast` — a wedged renderer — must not hold up every
 * later call, because a start in flight is a start every caller joins.
 */
const START_MIRROR_MS = 5_000

/** Why a browser that did not answer a cancelled call is dropped. */
const UNREACHABLE_REASON = 'the browser did not answer after the call that was cancelled'

/** How long an action waits for a navigation it triggered to reach the document. */
const SETTLE_NAVIGATION_MS = 2_000

/**
 * Where an armed settle probe parks its promise on the page.
 *
 * A slot per action rather than one fixed name: two actions in flight on the
 * same page would otherwise read each other's record.
 */
const SETTLE_SLOT = '__dshSettle'

/** A settle probe installed before an action, and where to read what it saw. */
interface SettleWatch {
  /** The page the action began on. */
  readonly page: Page | undefined
  /** The session the probe was installed on. */
  readonly cdp: CDPSession
  /** The global the probe resolves into. */
  readonly slot: string
}

/** What a page looked like, for deciding whether an action changed it. */
interface PageState {
  /** Address shown in the active page. */
  readonly url: string
  /** Document title at the time. */
  readonly title: string
}

/** The element an action landed on, as the snapshot described it. */
export interface ElementRef {
  /** The element's role. */
  readonly role: string
  /** The element's accessible name. */
  readonly name: string
}

/**
 * One JavaScript dialog a page opened, and what this plugin answered it with.
 *
 * A dialog is invisible to everything else the plugin does: it is not in the
 * accessibility tree, `Runtime.evaluate` cannot see it, and a page waiting for
 * an answer runs no script at all. Reporting it is therefore the only way the
 * model can learn that one appeared — and a dismissed `confirm` that reads as
 * "the page did not change" is a wrong answer rather than a missing one.
 */
export interface DialogReport {
  /** `alert`, `confirm`, `prompt`, or `beforeunload`. */
  readonly type: string
  /** What the page asks. */
  readonly message: string
  /** What a prompt offers as its default answer, empty for the other kinds. */
  readonly defaultValue: string
  /** Which way the dialog was answered. */
  readonly handled: 'accepted' | 'dismissed'
  /** The text a prompt was answered with, once it has been. */
  readonly answer?: string
}

/**
 * How one call answers a dialog that opens while it runs.
 *
 * The answer has to be declared before the action rather than chosen after it:
 * a dialog blocks the page until it is answered, so there is no moment at which
 * a call could look at one and decide. Dismissing is the default because it is
 * the answer that changes nothing.
 */
export interface DialogPolicy {
  /** Whether to accept the dialog or dismiss it. */
  readonly action: 'accept' | 'dismiss'
  /** What to answer a prompt with; a prompt accepted without text takes its default. */
  readonly text?: string
}

/**
 * How often a wait asks the page whether the condition holds yet.
 *
 * Every ask of a tree-shaped condition is a whole accessibility tree, so this is
 * a compromise rather than a poll rate: a quarter of a second costs a handful of
 * reads over a realistic wait and still lands well inside the time a person
 * would call "as soon as it appeared".
 */
const WAIT_POLL_MS = 250

/** A condition one call waits for instead of acting immediately. */
export interface WaitCondition {
  /** Wait until an element this locator names is on the page. */
  readonly locator?: Locator
  /** Wait until the address the page shows contains this text, without regard to case. */
  readonly url?: string
  /** Wait this long with nothing to observe: the last resort, for a page that cannot be asked yet. */
  readonly timeMs?: number
}

/**
 * What a wait found, whether or not the condition held.
 *
 * A condition that has not held yet is an answer, not a failure: the caller
 * learns how long it waited, where the page is now, and what the page did in the
 * meantime — which together are what "judge an action by whether its expected
 * effect appeared" needs in order to decide the next step. Reporting it as an
 * error would make the ordinary "not yet" indistinguishable from a call that
 * broke, and inside a PTC program an uncaught error ends the whole program.
 */
export interface WaitReport {
  /** Whether the condition held before the deadline. */
  readonly matched: boolean
  /** How long the call waited, in milliseconds. */
  readonly waitedMs: number
  /** Address the active page shows when the wait ended. */
  readonly url: string
  /** Title the active page shows when the wait ended. */
  readonly title: string
  /** The element that satisfied an element condition, when one did. */
  readonly element?: ElementRef
  /** How many elements an element condition matched when the wait ended. */
  readonly matches?: number
  /** What the page changed while the wait ran, the first few of them. */
  readonly changes?: readonly DomChange[]
  /** How many further changes were seen and are not itemised here. */
  readonly changesOmitted?: number
}

/**
 * One thing the page or the browser said about itself.
 *
 * A page that fails without touching the document — a handler that threw, a
 * request that never arrived, a resource the deployment blocked — leaves nothing
 * in the accessibility tree and nothing in a change list, so the only trace is
 * what it said. The shape is the reference runtime's (`tab.dev.logs`): a level,
 * the rendered message, when it happened, and where it came from.
 *
 * The message is the browser's own rendering of the arguments, which means an
 * argument that is a plain object arrives as `Object`: the protocol describes a
 * logged value but does not serialize it, and reading it would cost a protocol
 * round trip per argument. A page that wants detail in its log has to put it in
 * the message, and a caller that wants a value has `browser_evaluate`.
 */
export interface ConsoleEntry {
  /** How loud it was, in the browser's own vocabulary, normalized. */
  readonly level: 'debug' | 'info' | 'log' | 'warn' | 'error'
  /** The rendered message. */
  readonly message: string
  /** When the browser recorded it, as an ISO 8601 instant. */
  readonly timestamp: string
  /** Where it came from, with the line when the browser knows one. */
  readonly url?: string
}

/**
 * What the page has said since the current document loaded.
 *
 * `total` and `dropped` are what make the list trustworthy: a page that logs in
 * a loop fills any buffer, and a caller told only the surviving entries would
 * read a truncated history as the whole one.
 */
export interface ConsoleReport {
  /** The entries, oldest first, after the caller's filters. */
  readonly entries: readonly ConsoleEntry[]
  /** How many entries survived this call's filters. */
  readonly matched: number
  /** How many entries the buffer held before this call's filters. */
  readonly total: number
  /** How many entries the buffer dropped because it was full. */
  readonly dropped: number
  /** Address of the page the entries came from. */
  readonly url: string
  /** Title of the page the entries came from. */
  readonly title: string
}

/**
 * One change the page made while an action settled.
 *
 * "The page changed" is not something a model can act on, and under PTC it is
 * not something a program can branch on usefully either: a click that made a
 * toast appear and a click that only re-rendered a spinner both report `dom`.
 * These are the first few facts behind that word, in the words the *page* used —
 * the element's own tag, the role it declares, and a short piece of what it says
 * (Codex's `ElementInfo` splits tag, role, and visible text the same way, and for
 * the same reason: they are three different facts and they disagree often
 * enough to matter).
 *
 * What is deliberately absent is Chrome's *computed* accessible role and name.
 * Reading those for a node that changed means asking the protocol again per
 * change, and the snapshot is where a page's roles and names belong; this says
 * where to look, and `browser_snapshot` says what the element is.
 */
export interface DomChange {
  /** What happened: the element appeared, went away, or says something new. */
  readonly kind: 'added' | 'removed' | 'attribute' | 'text'
  /** The element's tag name, lowercased. */
  readonly tag?: string
  /** The role the element declares in an attribute, when it declares one. */
  readonly role?: string
  /** A short piece of what the element says: its label, its text, or its value. */
  readonly preview?: string
  /** The attribute that changed, for an `attribute` change. */
  readonly attribute?: string
  /** What it said before; absent when there was nothing there before. */
  readonly from?: string
  /** What it says now; absent when it is gone. */
  readonly to?: string
}

/**
 * What an action did, as a tool result reports it.
 *
 * A tool that returned only its arguments left the model to guess what happened;
 * these are the facts the page can be asked for afterwards — where it ended up,
 * what the element was, and whether anything moved while it settled.
 */
export interface ActionReport {
  /** Address the active page shows after the action. */
  readonly url: string
  /** Title the active page shows after the action. */
  readonly title: string
  /** Which of `url`, `title`, `dom`, and `dialog` changed: the page either moved or it did not. */
  readonly changed: readonly string[]
  /** Mutation records observed while the page settled. */
  readonly mutations: number
  /** Whether the page stopped changing inside the settle budget. */
  readonly settled: boolean
  /** The first few things the page changed, when it changed anything. */
  readonly changes?: readonly DomChange[]
  /** How many further changes were seen and are not itemised here. */
  readonly changesOmitted?: number
  /** The element acted on, when the action named one. */
  readonly element?: ElementRef
  /** Whether an element that had been replaced was found again by role and name. */
  readonly recovered?: boolean
  /**
   * What was over the point a click used, when it was not the element itself.
   *
   * A click goes to coordinates, so an open menu's backdrop or a sticky header
   * takes it instead and the page answers that nothing changed; without this a
   * model can only conclude that the element does nothing.
   */
  readonly obstructed?: ElementRef
  /** Dialogs the pages opened during this call, and what was answered. */
  readonly dialogs?: readonly DialogReport[]
}

/** A snapshot plus where in the page it was taken. */
export interface PageSnapshot extends AxSnapshot {
  /** Viewport and scroll position at the time. */
  readonly info: PageInfo
}

/**
 * How one call names the element it acts on.
 *
 * A ref is an answer a snapshot gave about one document, so it is cheap to
 * check and goes stale when the page re-renders or navigates. A locator is the
 * question that answer came from, asked again at the moment of the action, so
 * it survives both — at the price of having to resolve, which is why an
 * ambiguous one refuses rather than picks.
 */
export type ElementTarget = string | Locator

/** One `DOM.describeNode` result, as far as this plugin reads it. */
interface DomNode {
  readonly backendNodeId?: number
  readonly children?: readonly DomNode[]
}

/**
 * Fields a running browser was launched from; changing one requires a new browser.
 *
 * The port window is deliberately absent. What a browser listens on is the port
 * the allocator handed it, not a configuration value, so moving the window only
 * decides where the *next* browser may listen — a settings tweak that should not
 * close browsers someone is watching. The ports already handed out stay held
 * until their browsers close.
 */
const LAUNCH_FIELDS = [
  'channel', 'executablePath', 'headless', 'userDataDir',
  'viewportWidth', 'viewportHeight', 'startupUrl', 'stealth',
] as const

/** Whether two configurations would start the same browser. */
export function sameLaunch(left: BrowserConfig, right: BrowserConfig): boolean {
  return LAUNCH_FIELDS.every(field => left[field] === right[field])
    && left.extraArgs.join('\u0000') === right.extraArgs.join('\u0000')
}

/** Whether two configurations encode frames the same way. */
export function sameEncoding(left: BrowserConfig, right: BrowserConfig): boolean {
  return left.quality === right.quality
    && left.maxWidth === right.maxWidth
    && left.maxHeight === right.maxHeight
    && left.everyNthFrame === right.everyNthFrame
}

/**
 * Pause for a moment, for the loops that have to keep asking a page something.
 *
 * There is no timer to clear: the longest anyone waits is one poll interval or
 * the remainder of a budget, and both are bounded by the call's own deadline —
 * a cancelled call stops waiting because the whole call is raced against the
 * caller's signal, not because this is interruptible on its own.
 * @param ms - how long to pause, in milliseconds.
 * @returns a promise that resolves after the pause.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Whether a CDP failure means the element behind a ref is no longer in the DOM.
 *
 * Chrome answers a call about a removed node in a few different ways depending
 * on the call, and each of them is worth one attempt to find the element again;
 * anything else — a page that threw, a browser that went away — is the caller's
 * error and is reported as it is.
 * @param error - what the protocol call rejected with.
 * @returns whether the element itself is gone.
 */
function elementGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no node with given id|node with given id|no node found|could not find node|detached|not attached/iu.test(message)
}

/**
 * Chrome's own words from a protocol failure.
 *
 * A transport wraps every protocol error as `cdpSession.send: Protocol error
 * (DOM.focus): Element is not focusable`, and only the last part is the browser
 * speaking. Quoting the wrapper at a model gives it a sentence about this
 * plugin's plumbing where the page's own reason belongs.
 * @param error - what the protocol call rejected with.
 * @returns the reason, without the transport's framing.
 */
function protocolReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const said = /Protocol error \([^)]*\):\s*([\s\S]+)$/u.exec(message)
  return said?.[1]?.trim() ?? message
}

/**
 * The in-page expression an action settles with.
 *
 * It reports how many mutation records the page produced while the observer was
 * installed, whether the page went quiet inside the budget, and a bounded
 * summary of what actually changed — which is what turns "the click returned"
 * into "the page stopped moving, and this is what appeared".
 *
 * The summary is written here rather than on this side because this is where the
 * changed nodes are: a mutation record hands over live nodes, and a node is gone
 * (or has already been re-rendered again) by the time anything outside the page
 * could ask about it. What it may say about a node is therefore limited to what
 * the DOM itself answers — the tag, a `role` attribute, and a short piece of
 * text — and the result is read as a *page's* description of itself: the
 * snapshot is still the authority on accessible roles and names.
 *
 * Everything in here is written defensively, because a page is arbitrary code:
 * a node that throws when read is skipped rather than allowed to end the
 * summary, and the promise resolves either way.
 * @returns the expression to evaluate in the page.
 */
export function settleProbe(): string {
  return `new Promise((resolve) => {
    const LIMIT = ${String(CHANGE_LIMIT)}
    const TEXT_MAX = ${String(CHANGE_TEXT_MAX)}
    // Elements that draw nothing. A stylesheet or a script landing in the page
    // is not something a reader of the page can see or act on, and CSS-in-JS
    // libraries rewrite one on nearly every render — left in, they would fill
    // the summary with the machinery instead of the page.
    const UNSEEN = ['script', 'style', 'link', 'meta', 'title', 'template', 'noscript', 'base']
    let mutations = 0
    let items = 0
    let quiet = 0
    let cap = 0
    const changes = []
    const seen = new Map()
    const clip = (value) => {
      const one = String(value === undefined || value === null ? '' : value).replace(/\\s+/gu, ' ').trim()
      return one.length > TEXT_MAX ? one.slice(0, TEXT_MAX) + '…' : one
    }
    const attributeOf = (element, name) => {
      try { return element.getAttribute === undefined ? null : element.getAttribute(name) } catch { return null }
    }
    const where = (node, fallback) => {
      const element = node !== null && node.nodeType === 1 ? node : (node !== null && node.parentElement) || fallback
      if (element === null || element === undefined) return {}
      const tag = String(element.tagName === undefined ? '' : element.tagName).toLowerCase()
      const change = tag === '' ? {} : { tag }
      const role = attributeOf(element, 'role')
      if (role) change.role = clip(role)
      return change
    }
    // What one node says for itself. A text node says its own text; an element
    // says the label the page gave it, then what it holds — and a container is
    // never asked on another node's behalf, because the container's whole text is
    // not what the change said.
    const saidBy = (node) => {
      let says = ''
      if (node !== null && node.nodeType === 1) {
        says = attributeOf(node, 'aria-label') || attributeOf(node, 'placeholder')
          || (node.textContent === undefined || node.textContent === null ? '' : node.textContent)
          || (node.value === undefined || node.value === null ? '' : node.value)
      } else if (node !== null && node.nodeType === 3 && node.data !== undefined) {
        says = node.data
      }
      const preview = clip(says)
      return preview === '' ? {} : { preview }
    }
    const unseen = (change) => UNSEEN.indexOf(change.tag === undefined ? '' : change.tag) !== -1
    const once = (node, key) => {
      let keys = seen.get(node)
      if (keys === undefined) { keys = new Set(); seen.set(node, keys) }
      if (keys.has(key)) return false
      keys.add(key)
      return true
    }
    const note = (kind, node, fallback, rest) => {
      const change = { kind, ...where(node, fallback), ...rest }
      if (unseen(change)) return
      items += 1
      if (changes.length < LIMIT) changes.push(change)
    }
    const finish = (settled) => {
      observer.disconnect()
      clearTimeout(quiet)
      clearTimeout(cap)
      resolve({ mutations, settled, changes, omitted: items - changes.length })
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        mutations += 1
        try {
          if (record.type === 'attributes') {
            const name = record.attributeName
            if (name && once(record.target, 'a:' + name)) {
              const now = attributeOf(record.target, name)
              note('attribute', record.target, undefined, {
                ...saidBy(record.target),
                attribute: name,
                ...record.oldValue === null || record.oldValue === undefined ? {} : { from: clip(record.oldValue) },
                ...now === null || now === undefined ? {} : { to: clip(now) },
              })
            }
          } else if (record.type === 'characterData') {
            if (once(record.target, 't')) {
              const now = record.target.data
              note('text', record.target, undefined, {
                ...record.oldValue === null || record.oldValue === undefined ? {} : { from: clip(record.oldValue) },
                ...now === null || now === undefined ? {} : { to: clip(now) },
              })
            }
          } else {
            // A record that only added or only removed children leaves the other
            // list out, and a page is free to hand over anything else besides.
            const added = record.addedNodes || []
            const removed = record.removedNodes || []
            // One text node replaced by another under the same parent is how the
            // browser reports an assignment to textContent, which is how most
            // pages rewrite a run of text. Read literally it is a node going and a
            // node arriving, and a page that changed "24.1k" to "24.2k" would
            // spend two of the few reported changes saying so twice.
            if (added.length === 1 && removed.length === 1
              && added[0].nodeType === 3 && removed[0].nodeType === 3) {
              if (once(record.target, 'text')) {
                note('text', record.target, undefined, {
                  from: clip(removed[0].data),
                  to: clip(added[0].data),
                })
              }
            } else {
              // A removed node has no parent left to be described by, so the
              // element that lost it is what the change is reported against —
              // and what it said is the node's own text, not the container's.
              for (const node of removed) {
                if (once(node, 'removed')) note('removed', node, record.target, saidBy(node))
              }
              for (const node of added) {
                if (once(node, 'added')) note('added', node, record.target, saidBy(node))
              }
            }
          }
        } catch {
          // A node this cannot read is not a reason to stop watching the page.
        }
      }
      clearTimeout(quiet)
      quiet = setTimeout(() => { finish(true) }, ${String(SETTLE_QUIET_MS)})
    })
    observer.observe(globalThis.document.documentElement ?? globalThis.document, {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true,
    })
    quiet = setTimeout(() => { finish(true) }, ${String(SETTLE_QUIET_MS)})
    cap = setTimeout(() => { finish(false) }, ${String(SETTLE_MAX_MS)})
  })`
}

/**
 * One change a page reported, as far as a result may carry it.
 *
 * The record arrives from the page, so this is a boundary and not a cast: a
 * field of the wrong type is dropped rather than passed on, an entry with a kind
 * this result does not declare is dropped with it, and anything said at greater
 * length than a result may be is cut at the same bound the page was given.
 * @param entry - one entry of the record a settle probe resolved with.
 * @returns the change, or `undefined` when the page did not describe one.
 */
function readChange(entry: unknown): DomChange | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const reported = entry as Record<string, unknown>
  const kind = reported['kind']
  if (kind !== 'added' && kind !== 'removed' && kind !== 'attribute' && kind !== 'text') return undefined
  /** One field, when the page said it as a non-empty string. */
  const said = (field: string): string | undefined => {
    const value = reported[field]
    if (typeof value !== 'string' || value === '') return undefined
    return value.length > CHANGE_TEXT_MAX ? `${value.slice(0, CHANGE_TEXT_MAX)}…` : value
  }
  const fields = Object.fromEntries(
    (['tag', 'role', 'preview', 'attribute', 'from', 'to'] as const)
      .map(field => [field, said(field)] as const)
      .filter(([, value]) => value !== undefined),
  ) as Pick<DomChange, 'tag' | 'role' | 'preview' | 'attribute' | 'from' | 'to'>
  return { kind, ...fields }
}

/**
 * Where a thing the browser reported came from.
 *
 * A line only when the protocol gave one: the same field carries a resource URL
 * for a failed request, where a line number would be invented.
 * @param url - the source the protocol named.
 * @param line - the zero-based line, when the protocol named one.
 * @returns the source with its line, or `undefined` when there is no source.
 */
function whereFrom(url: unknown, line: unknown): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined
  return typeof line === 'number' && Number.isFinite(line) && line >= 0
    ? `${url}:${String(Math.floor(line) + 1)}`
    : url
}

/**
 * When the browser recorded something.
 *
 * The timestamp is the browser's, not this process's, so the two differ when the
 * renderer is on another machine; the protocol's own instant is the one that
 * orders correctly against the events around it.
 * @param timestamp - the protocol's timestamp in milliseconds since the epoch.
 * @returns an ISO 8601 instant.
 */
function instantOf(timestamp: unknown): string {
  const ms = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  return new Date(ms).toISOString()
}

/**
 * One page argument as the browser rendered it.
 *
 * `value` is what a primitive logged as; `description` is all an object gets,
 * and it names the shape rather than the contents ("Object", "Array(3)",
 * "div#app"); `unserializableValue` is `NaN`, `Infinity`, or `-0`, which no JSON
 * form can carry. The object *preview* the protocol attaches is used when it is
 * there, which is what turns a logged `{a: 1}` into something worth reading.
 * @param arg - one `Runtime.RemoteObject` from a console call.
 * @returns the argument as text.
 */
function argumentText(arg: unknown): string {
  if (arg === null || typeof arg !== 'object') return String(arg)
  const remote = arg as {
    value?: unknown
    unserializableValue?: unknown
    description?: unknown
    type?: unknown
    preview?: unknown
  }
  if (remote.value !== undefined) {
    return typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value) ?? String(remote.value)
  }
  if (typeof remote.unserializableValue === 'string') return remote.unserializableValue
  const preview = previewText(remote.preview)
  if (preview !== undefined) return preview
  if (typeof remote.description === 'string') return remote.description
  return typeof remote.type === 'string' ? remote.type : '?'
}

/**
 * A logged object as far as the protocol's preview describes it.
 * @param preview - one `Runtime.ObjectPreview`, when the protocol sent one.
 * @returns the object in braces, or `undefined` when there is nothing to read.
 */
function previewText(preview: unknown): string | undefined {
  if (preview === null || typeof preview !== 'object') return undefined
  const record = preview as { description?: unknown; overflow?: unknown; properties?: unknown }
  if (!Array.isArray(record.properties)) return undefined
  const shown = record.properties.slice(0, 5)
  const parts = shown.map((property) => {
    const item = property as { name?: unknown; type?: unknown; value?: unknown }
    const name = typeof item.name === 'string' ? item.name : '?'
    if (item.type === 'string' && typeof item.value === 'string') return `${name}: ${JSON.stringify(item.value)}`
    if (item.value !== undefined) return `${name}: ${String(item.value)}`
    return `${name}: ${typeof item.type === 'string' ? item.type : '?'}`
  })
  if (record.overflow === true || record.properties.length > shown.length) parts.push('…')
  // "Object {…}" says the same thing twice; every other description names a shape
  // the braces cannot (`Array(3)`, `div#app`, `Map(2)`).
  const said = typeof record.description === 'string' && record.description !== 'Object'
    ? `${record.description} `
    : ''
  return `${said}{${parts.join(', ')}}`
}

/**
 * The level a console call's own kind maps to.
 *
 * The protocol says `warning` where the console says `warn`, and it has kinds
 * this plugin does not have levels for (`dir`, `table`, `count`); those are
 * ordinary output and read as `log`.
 * @param kind - the protocol's `type`.
 * @returns the normalized level.
 */
function consoleLevelOf(kind: unknown): ConsoleEntry['level'] {
  if (kind === 'debug') return 'debug'
  if (kind === 'info') return 'info'
  if (kind === 'warning' || kind === 'warn') return 'warn'
  if (kind === 'error' || kind === 'assert') return 'error'
  return 'log'
}

/** Clip one message to the length a console result may carry. */
function clipped(message: string): string {
  return message.length > CONSOLE_TEXT_MAX ? `${message.slice(0, CONSOLE_TEXT_MAX)}…` : message
}

/**
 * Read one `Runtime.consoleAPICalled` event.
 * @param event - the event payload.
 * @returns the entry, or `undefined` when the event carries nothing readable.
 */
function readConsoleCall(event: unknown): ConsoleEntry | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const record = event as { type?: unknown; args?: unknown; timestamp?: unknown; stackTrace?: unknown }
  const args = Array.isArray(record.args) ? record.args : []
  const message = clipped(args.map(argumentText).join(' '))
  if (message === '') return undefined
  const frames = (record.stackTrace as { callFrames?: unknown } | undefined)?.callFrames
  const frame = Array.isArray(frames) ? frames[0] as { url?: unknown; lineNumber?: unknown } | undefined : undefined
  const url = whereFrom(frame?.url, frame?.lineNumber)
  return {
    level: consoleLevelOf(record.type),
    message,
    timestamp: instantOf(record.timestamp),
    ...url === undefined ? {} : { url },
  }
}

/**
 * Read one `Runtime.exceptionThrown` event.
 * @param event - the event payload.
 * @returns the entry, or `undefined` when the event carries nothing readable.
 */
function readExceptionThrown(event: unknown): ConsoleEntry | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const record = event as { timestamp?: unknown; exceptionDetails?: unknown }
  const details = record.exceptionDetails as {
    text?: unknown
    url?: unknown
    lineNumber?: unknown
    exception?: { description?: unknown }
  } | undefined
  if (details === null || typeof details !== 'object') return undefined
  const described = details.exception?.description
  const message = typeof described === 'string' && described !== ''
    ? described
    : typeof details.text === 'string' ? details.text : 'an uncaught error'
  const url = whereFrom(details.url, details.lineNumber)
  return {
    level: 'error',
    message: clipped(message),
    timestamp: instantOf(record.timestamp),
    ...url === undefined ? {} : { url },
  }
}

/**
 * Read one `Log.entryAdded` event: what the browser itself reported, which is
 * where a failed request or a blocked resource shows up.
 * @param event - the event payload.
 * @returns the entry, or `undefined` when the event carries nothing readable.
 */
function readLogEntry(event: unknown): ConsoleEntry | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const entry = (event as { entry?: unknown }).entry as {
    level?: unknown
    text?: unknown
    timestamp?: unknown
    url?: unknown
    lineNumber?: unknown
  } | undefined
  if (entry === null || typeof entry !== 'object') return undefined
  if (typeof entry.text !== 'string' || entry.text === '') return undefined
  const url = whereFrom(entry.url, entry.lineNumber)
  return {
    // The browser log has one level this plugin has no word for: `verbose` is
    // everything the network layer says when nothing is wrong.
    level: entry.level === 'verbose' ? 'debug' : consoleLevelOf(entry.level),
    message: clipped(entry.text),
    timestamp: instantOf(entry.timestamp),
    ...url === undefined ? {} : { url },
  }
}

/**
 * Where a press on a ref's element would land, as the page itself reports it.
 *
 * `moved` says the box was still changing while the page's next two frames were
 * waited for; the coordinates are from the later reading either way. `outside`
 * says the page put the point outside the viewport a press can be dispatched in,
 * which is a refusal rather than a press at nothing.
 */
interface PressPoint {
  /** X in the pixels input is dispatched in, in the top frame. */
  readonly x: number
  /** Y in the pixels input is dispatched in, in the top frame. */
  readonly y: number
  /** Whether the box moved while the next two frames were awaited. */
  readonly moved: boolean
  /** Whether the point is outside the outermost viewport this plugin can see. */
  readonly outside: boolean
  /** What the page says is at the point, when it is not the element. */
  readonly over?: ElementRef
}

/**
 * The in-page question a press asks about itself.
 *
 * The page is the authority on both halves: `getBoundingClientRect` is already
 * in the pixels input is dispatched in, and `elementFromPoint` is the same
 * question a real press asks. A shadow host is followed into its own tree so it
 * cannot be mistaken for something lying over the target, a `StaticText` ref is
 * answered by the element around it, and the box is read twice so an element
 * that is still moving is not pressed where it used to be.
 * @returns the function to call on the element a click is about to press.
 */
function pressProbe(): string {
  return `async function () {
    const element = this.nodeType === 1 ? this : this.parentElement
    if (element === null || typeof element.getBoundingClientRect !== 'function') return { ok: false }
    const box = () => element.getBoundingClientRect()
    const view = element.ownerDocument.defaultView
    const first = box()
    await new Promise((done) => {
      let waited = false
      const finish = () => { if (!waited) { waited = true; done() } }
      if (view !== null && typeof view.requestAnimationFrame === 'function') {
        view.requestAnimationFrame(() => view.requestAnimationFrame(finish))
      }
      // A page that never paints — a background tab — must not hold the press up.
      if (view !== null && typeof view.setTimeout === 'function') view.setTimeout(finish, 50)
    })
    const settled = box()
    const moved = Math.abs(settled.left - first.left) > 1 || Math.abs(settled.top - first.top) > 1
    if (settled.width === 0 && settled.height === 0) return { ok: false }
    const localX = settled.left + settled.width / 2
    const localY = settled.top + settled.height / 2
    // A press is dispatched in the top frame's pixels, so the point walks out of
    // every frame this element sits in.
    let x = localX
    let y = localY
    let outer = view
    let frame = view === null ? null : view.frameElement
    for (let hop = 0; frame !== null && hop < 32; hop += 1) {
      const frameBox = frame.getBoundingClientRect()
      x += frameBox.left
      y += frameBox.top
      const parent = frame.ownerDocument.defaultView
      outer = parent
      frame = parent === null ? null : parent.frameElement
    }
    const inView = outer !== null && x >= 0 && y >= 0 && x < outer.innerWidth && y < outer.innerHeight
    if (!inView) return { ok: true, x, y, moved, inView, mine: false, over: null }
    // What the page says is at the point, and whether that is the element or
    // something inside it: a press on either one reaches the element.
    const within = (node) => {
      let current = node
      for (let hop = 0; current !== null && hop < 64; hop += 1) {
        if (current === element) return true
        const parent = current.parentNode
        const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null
        current = parent !== null ? parent : (root !== null && root.host !== undefined ? root.host : null)
      }
      return false
    }
    let top = element.ownerDocument.elementFromPoint(localX, localY)
    while (top !== null && top.shadowRoot !== null) {
      const inner = top.shadowRoot.elementFromPoint(localX, localY)
      if (inner === null || inner === top) break
      top = inner
    }
    const mine = top !== null && (top === element || element.contains(top) || within(top))
    if (mine || top === null) return { ok: true, x, y, moved, inView, mine, over: null }
    const name = top.getAttribute('aria-label') ?? top.textContent ?? ''
    return {
      ok: true, x, y, moved, inView, mine,
      over: {
        role: top.getAttribute('role') ?? top.tagName.toLowerCase(),
        name: String(name).replace(/\\s+/g, ' ').trim().slice(0, 80),
      },
    }
  }`
}

/**
 * Read what a page answered about a press.
 *
 * The answer is another program's output, so every field is checked before it is
 * believed; `'boxless'` is the page saying the element has no box at all, and
 * `undefined` is the page saying nothing this code can use.
 * @param value - the value `Runtime.callFunctionOn` returned.
 * @returns the point, `'boxless'`, or `undefined` when there was no usable answer.
 */
function readPress(value: unknown): PressPoint | 'boxless' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const said = value as Record<string, unknown>
  if (said['ok'] === false) return 'boxless'
  if (said['ok'] !== true) return undefined
  const x = said['x']
  const y = said['y']
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  const over = said['over']
  const described = typeof over === 'object' && over !== null ? over as Record<string, unknown> : undefined
  const role = described?.['role']
  const name = described?.['name']
  return {
    x,
    y,
    moved: said['moved'] === true,
    outside: said['inView'] === false,
    ...typeof role === 'string'
      ? { over: { role, name: typeof name === 'string' ? name : '' } }
      : {},
  }
}

/**
 * An element as an error names it.
 *
 * A nameless element is named by its role alone rather than as `svg ""`: the
 * quoted empty string reads as a bug in the message and tells the caller
 * nothing, and the role is the only fact there is to go on.
 * @param element - the role and name of an element.
 * @returns the role, followed by the quoted name when it has one.
 */
function elementName(element: { readonly role: string; readonly name: string }): string {
  return element.name === '' ? element.role : `${element.role} ${JSON.stringify(element.name)}`
}

/**
 * The error a ref gets when its element has no box to press.
 * @param target - the element the ref names.
 * @returns the error to throw.
 */
function boxlessError(target: { readonly role: string; readonly name: string }): Error {
  return new Error(`dsh-browser: ${elementName(target)} has no visible box in the page; take a new snapshot and try again`)
}

/**
 * What the page says about typing into the element a ref names.
 *
 * `accepts` is the answer; `why` is the page's own reason when it is no.
 */
interface TypedAnswer {
  /** Whether the focused control will take the text. */
  readonly accepts: boolean
  /** Why it will not, when it will not. */
  readonly why?: string
}

/**
 * The in-page question asked after a focus and before any text.
 *
 * `DOM.focus` succeeding is not the same as the characters landing in the
 * element: measured 2026-09-24 in real Chrome, `Input.insertText` into a
 * read-only input inserted nothing while the report still said the text had been
 * typed. Only the page knows whether the control it focused can hold text, so it
 * is asked — and asked about its own `activeElement`, because a focus that
 * landed somewhere else is the other way text goes missing.
 * @returns the function to call on the element a type is about to write into.
 */
function typedProbe(): string {
  return `function () {
    const element = this.nodeType === 1 ? this : this.parentElement
    if (element === null) return { accepts: false, why: 'it is not an element' }
    const active = element.ownerDocument.activeElement
    const focused = active !== null && (active === element || element.contains(active))
    // What would take the text is the control the page focused; when the focus
    // never landed, the element itself is all there is to ask, and its own state
    // is why the focus was refused — a disabled control rejects the focus before
    // any question about typing can be answered.
    const target = focused ? active : element
    if (target.disabled === true) return { accepts: false, why: 'it is disabled' }
    if (target.readOnly === true) return { accepts: false, why: 'it is read-only' }
    const tag = String(target.tagName === undefined ? '' : target.tagName).toLowerCase()
    const type = String(target.type === undefined ? '' : target.type).toLowerCase()
    const textless = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
    const takes = tag === 'textarea'
      || (tag === 'input' && textless.indexOf(type) === -1)
      || target.isContentEditable === true
    if (!takes) return { accepts: false, why: 'it takes no typed text' }
    if (!focused) return { accepts: false, why: 'the page did not focus it' }
    return { accepts: true }
  }`
}

/**
 * Read what a page answered about typing.
 * @param value - the value `Runtime.callFunctionOn` returned.
 * @returns the answer, or `undefined` when the page said nothing this code can use.
 */
function readTyped(value: unknown): TypedAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const said = value as Record<string, unknown>
  if (said['accepts'] === true) return { accepts: true }
  if (said['accepts'] !== false) return undefined
  const why = said['why']
  return { accepts: false, why: typeof why === 'string' ? why : 'the page would not take it' }
}

/**
 * The error a ref gets when the page says the text would not land in it.
 * @param target - the element the ref names.
 * @param why - the page's reason.
 * @returns the error to throw.
 */
function untypableError(target: { readonly role: string; readonly name: string }, why: string): Error {
  return new Error(
    `dsh-browser: ${elementName(target)} would not take the text because ${why}; nothing was typed, `
    + 'so take a new snapshot and check the element',
  )
}

/**
 * One call's source, wrapped so its declarations belong to that call.
 *
 * The page's global scope keeps what an earlier call declared: a `const` or
 * `class` of the same name is a syntax error before anything runs. A block is
 * enough to give the source a scope of its own, and the block's completion value
 * is what the call would have produced unwrapped.
 * @param expression - the caller's source.
 * @returns the source as one block statement.
 */
function scopedBlock(expression: string): string {
  return `{\n${expression}\n}`
}

/**
 * One call's source, as the body of an async function.
 *
 * `return` is a statement, not an expression, so a caller that ends its code
 * with one gets a compile error from the page instead of a value — even though
 * "run this and give me what it returns" is exactly what the tool promises, and
 * exactly what the reference runtime's program form allows. The body of an
 * async function is where that statement belongs, and it is the same scope the
 * `await` retry already needs, so the two are one change rather than two.
 * @param expression - the caller's source.
 * @returns the source as an immediately-invoked async function's body.
 */
function asyncBody(expression: string): string {
  return `(async () => {\n${expression}\n})()`
}

/** What waiting for one promise until a deadline produced. */
interface Until<T> {
  /** Whether it settled — either way — before the deadline. */
  readonly settled: boolean
  /** What it produced, when it produced one. */
  readonly value?: T
}

/**
 * Wait for a promise, but only until a deadline.
 *
 * For the work this class can afford to give up on: a page being told to stop,
 * a mirror being attached. A rejection counts as settled — a browser that
 * refused is a browser that answered — and the abandoned promise's failure is
 * swallowed here rather than surfacing as an unhandled rejection.
 * @param work - the promise to wait for.
 * @param ms - how long it is given.
 * @returns whether it settled in time, and what it produced.
 */
async function until<T>(work: Promise<T>, ms: number): Promise<Until<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(value => ({ settled: true, value }), () => ({ settled: true })),
      new Promise<Until<T>>(done => {
        timer = setTimeout(() => { done({ settled: false }) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The box a content quad describes.
 *
 * The quad's corners are averaged into nothing here: a box is the smallest
 * upright rectangle around every corner, which is what a reader comparing two
 * elements' positions wants, while the click path uses the corners themselves
 * so that a rotated element is still pressed inside itself.
 * @param quad - eight numbers, `x1 y1 x2 y2 x3 y3 x4 y4`, in CSS pixels.
 * @returns the box, or `undefined` when there was no usable quad.
 */
function boundingBoxOf(quad: readonly number[] | undefined): Box | undefined {
  if (quad === undefined) return undefined
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index + 1 < quad.length; index += 2) {
    xs.push(quad[index] ?? 0)
    ys.push(quad[index + 1] ?? 0)
  }
  if (xs.length === 0) return undefined
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(...xs) - left),
    height: Math.round(Math.max(...ys) - top),
  }
}

/** One captured page image. */
export interface Screenshot {
  /** Encoded JPEG bytes. */
  readonly jpeg: Buffer
  /** Page width at capture time, in CSS pixels. */
  readonly width: number
  /** Page height at capture time, in CSS pixels. */
  readonly height: number
  /** The element captured, when the caller named one. */
  readonly element?: ElementRef
}

/** A rectangle in the page's own CSS pixels, which is what a capture clip takes. */
interface PageBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The in-page question a screenshot asks about an element.
 *
 * `Page.captureScreenshot`'s clip is in page pixels, not viewport pixels —
 * measured 2026-09-29 in `.prove/clip-space-probe.mjs`: with
 * `captureBeyondViewport: true` a clip at page y=1200 captured a striped block
 * that sat below a 400 px viewport, identically at scroll 0 and at scroll 900,
 * while the same rectangle read as viewport coordinates captured blank paper.
 * That is why nothing here scrolls the element into view: the coordinates are
 * the page's, so an element below the fold is captured where it is rather than
 * after the page has been moved — and moving the page is itself a change the
 * page can react to.
 *
 * A frame is walked out the same way a press walks one, adding each frame
 * element's own offset, so an embedded element is captured where the top
 * document shows it.
 * @returns the function to call on the element a screenshot is about to capture.
 */
function clipProbe(): string {
  return `function () {
    const element = this.nodeType === 1 ? this : this.parentElement
    if (element === null || typeof element.getBoundingClientRect !== 'function') return { ok: false }
    const box = element.getBoundingClientRect()
    const view = element.ownerDocument.defaultView
    if (box.width <= 0 || box.height <= 0) return { ok: false }
    let x = box.left + (view === null ? 0 : view.scrollX)
    let y = box.top + (view === null ? 0 : view.scrollY)
    let inner = view
    let frame = view === null ? null : view.frameElement
    for (let hop = 0; frame !== null && hop < 32; hop += 1) {
      const outer = frame.ownerDocument.defaultView
      const frameBox = frame.getBoundingClientRect()
      x += frameBox.left + (outer === null ? 0 : outer.scrollX)
      y += frameBox.top + (outer === null ? 0 : outer.scrollY)
      inner = outer
      frame = outer === null ? null : outer.frameElement
    }
    return { ok: true, x, y, width: box.width, height: box.height }
  }`
}

/**
 * Read the rectangle the page says an element occupies.
 * @param answer - what the page answered the clip probe with.
 * @returns the rectangle, or `undefined` when the page named no box.
 */
function readClip(answer: unknown): PageBox | undefined {
  if (answer === null || typeof answer !== 'object') return undefined
  const said = answer as { ok?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (said.ok !== true) return undefined
  const numbers = [said.x, said.y, said.width, said.height]
  if (!numbers.every(value => typeof value === 'number' && Number.isFinite(value))) return undefined
  return {
    x: Math.floor(said.x as number),
    y: Math.floor(said.y as number),
    width: Math.max(1, Math.ceil(said.width as number)),
    height: Math.max(1, Math.ceil(said.height as number)),
  }
}

/**
 * Replace the user agent a headless build reports with the one its headful
 * build reports.
 *
 * Headless Chrome spells itself `HeadlessChrome/…`; the rest of the string is
 * byte-for-byte what the same build sends with a window, so the reported value
 * is edited rather than composed — no build number is guessed. `Network`'s
 * override is what makes the change reach requests; editing `navigator` alone
 * would leave the header intact.
 * @param cdp - session attached to the page.
 * @param page - page whose user agent is being replaced.
 */
async function hideHeadlessUserAgent(cdp: CDPSession, page: Page): Promise<void> {
  const reported = await page.evaluate(() => navigator.userAgent).catch(() => '')
  if (!reported.includes('Headless')) return
  await cdp.send('Network.setUserAgentOverride', { userAgent: reported.replace('Headless', '') })
}

/**
 * One session's browser, from its first use to its disposal.
 */
export class SessionBrowser {
  /** Pages the browser holds open, for the tab list a tool result carries. */
  private readonly viewers = new Set<FrameListener>()
  private readonly watchers = new Set<(status: BrowserStatus) => void>()
  private readonly sessionId: string
  private readonly ports: PortAllocator
  private readonly launch: Launcher
  private readonly logger: Logger
  private config: BrowserConfig
  private state: BrowserState = 'idle'
  private reason: string | undefined
  private session: BrowserSession | undefined
  private page: Page | undefined
  private cdp: CDPSession | undefined
  private port: number | undefined
  private temporaryProfile: string | undefined
  private launchedHeadless: boolean | undefined
  private starting: Promise<void> | undefined
  private stream: (() => Promise<void>) | undefined
  private viewport: { at: number; size: { width: number; height: number } } | undefined
  /**
   * Labels this page has handed out, by ref.
   *
   * It belongs to the page rather than to a snapshot: a ref taken before a menu
   * opened still names the element it named then, and re-printing the page does
   * not renumber the ones already handed out. A page that goes away takes its
   * labels with it, because a backend node id means nothing on another page.
   */
  private labels = new RefLabels()
  /** Set while this class itself is closing the browser, so it is not a death. */
  private closing = false
  /**
   * Set while the user has stopped this browser and nothing has asked for one
   * since.
   *
   * A browser that died is one the next request should bring back; a browser the
   * user closed is not. A viewer is not a request: re-subscribing to the pane —
   * a Sidebar tab switched away and back, the column hidden and shown, a reloaded
   * client — used to start a fresh `about:blank` over the close the user had just
   * asked for. Everything else that reaches {@link ensure} is asking for a
   * browser and clears this.
   */
  private userClosed = false
  /** How many settle probes this browser has armed, for a slot no two share. */
  private settleSeq = 0
  /**
   * Dialogs answered since a tool last read them.
   *
   * Held until a result can carry them: a dialog cannot be in a snapshot or in
   * the accessibility tree, so a tool result is the only place the model ever
   * learns that one appeared.
   */
  private dialogs: DialogReport[] = []
  /**
   * What the current document has said about itself, oldest first.
   *
   * Filled by the page's own CDP session from the moment this class attaches to
   * it, because the failures worth explaining happen before a tool could ask:
   * a script that throws while loading has already thrown by the time anybody
   * thinks to listen. Cleared when the document is replaced — a message belongs
   * to the document that produced it, the same way a ref does.
   */
  private said: ConsoleEntry[] = []
  /** How many console entries were dropped because the buffer was full. */
  private dropped = 0
  /**
   * The dialog policies of the calls in flight, newest last.
   *
   * A dialog belongs to the call whose input caused it, and the newest call is
   * that call: two calls in flight on one page can only have arrived in the
   * order they are stacked. A dialog nobody announced is answered by the
   * default, which is to dismiss it.
   */
  private readonly policies: DialogPolicy[] = []

  /**
   * @param sessionId - the session this browser belongs to.
   * @param deps - configuration, port owner, launcher, and logger.
   */
  constructor(sessionId: string, deps: SessionBrowserDeps) {
    this.sessionId = sessionId
    this.config = deps.config
    this.ports = deps.ports
    this.launch = deps.launch
    this.logger = deps.logger
  }

  /**
   * Adopt a new configuration.
   *
   * A field the running browser was launched from closes it: viewers keep their
   * subscription, and the next frame request starts a browser built from the
   * new values. Frames are restarted in place, since only the stream's own
   * encoding changed.
   * @param next - the newly resolved configuration.
   * @returns after the browser has been restarted, when it had to be.
   */
  async reconfigure(next: BrowserConfig): Promise<void> {
    const previous = this.config
    this.config = next
    if (this.state !== 'ready' && this.state !== 'starting') return
    if (!sameLaunch(previous, next)) {
      this.logger.info('dsh-browser: launch configuration changed; restarting the browser')
      await this.close()
      await this.openStreamForViewers()
      return
    }
    if (!sameEncoding(previous, next) && this.viewers.size > 0) {
      await this.closeStream()
      await this.openStream()
    }
  }

  /** The current status snapshot. */
  status(): BrowserStatus {
    const pages = this.session?.context.pages() ?? []
    return {
      sessionId: this.sessionId,
      state: this.state,
      debugPort: this.port,
      version: this.session?.version,
      url: this.page?.url(),
      mode: this.launchedHeadless === undefined
        ? undefined
        : this.launchedHeadless ? 'headless' : 'headful',
      tabs: pages.map((page, index) => ({
        index,
        url: page.url(),
        active: page === this.page,
      })),
      error: this.reason,
    }
  }

  /**
   * Observe status changes.
   * @param listener - called on every change, not on subscription.
   * @returns unsubscribe callback.
   */
  watch(listener: (status: BrowserStatus) => void): () => void {
    this.watchers.add(listener)
    return () => { this.watchers.delete(listener) }
  }

  /** Whether anyone is watching this browser's frames. */
  hasViewers(): boolean {
    return this.viewers.size > 0
  }

  /**
   * Start the browser if it is not running, joining an in-flight start.
   *
   * A browser that died or failed is started again here, which is what makes
   * any later request — a tool call, a viewer reconnecting, the pane's restart
   * — recover without reloading the plugin.
   * @returns after the browser is ready.
   * @throws {Error} when the browser cannot start.
   */
  async ensure(): Promise<void> {
    // Everything that gets here — a tool, a restart, a configuration change —
    // is asking for a browser, so a close the user made earlier no longer
    // stands. The one path that is not a request checks the flag itself.
    this.userClosed = false
    if (this.state === 'ready') return
    if (this.starting !== undefined) {
      await this.starting
      return
    }
    this.starting = this.start()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /**
   * Stop what the page is doing, for a call that was cancelled.
   *
   * A navigation still in flight is stopped and a script still executing is
   * terminated, because the call that started them has given up: left alone,
   * the page stays busy and the next call inherits work nobody is waiting for.
   * A browser that answers neither is not one the next call can use either, so
   * it is dropped and the call after it starts a fresh one — the alternative is
   * a browser that hangs every call from here on, which is what closing the
   * window by hand was the only way out of.
   * @returns after the browser has been told to stop, or has been dropped.
   */
  async interrupt(): Promise<void> {
    const cdp = this.cdp
    if (cdp === undefined) return
    const [loading, script] = await Promise.all([
      until(cdp.send('Page.stopLoading'), INTERRUPT_QUIET_MS),
      until(cdp.send('Runtime.terminateExecution'), INTERRUPT_QUIET_MS),
    ])
    if (loading.settled || script.settled) return
    this.logger.warn(new Error(
      `dsh-browser: session ${this.sessionId}'s browser did not answer after a cancelled call; dropping it`,
    ))
    this.forget()
    this.reason = UNREACHABLE_REASON
    this.setState('closed')
  }

  /**
   * Subscribe a viewer. The first subscriber starts the stream, the last one
   * leaving stops it.
   * @param listener - receives every frame while subscribed.
   * @returns unsubscribe callback.
   */
  addViewer(listener: FrameListener): () => void {
    this.viewers.add(listener)
    if (this.viewers.size === 1) void this.openStreamForViewers()
    return () => {
      this.viewers.delete(listener)
      if (this.viewers.size === 0) void this.closeStream()
    }
  }

  /**
   * Answer a dialog a page opened, and remember what it asked.
   *
   * Nothing is left open. A page waiting on an answer runs no script, renders
   * nothing, and answers no protocol call that needs its main thread, so an
   * unanswered dialog is a browser that looks wedged for every call behind it —
   * which is why Playwright dismisses unhandled dialogs on its own, silently.
   * This does the same thing, in the open: the answer is the one the call
   * declared when it declared one, the answer that changes nothing otherwise,
   * and either way the result says a dialog appeared.
   * @param dialog - the dialog the page opened.
   */
  private answerDialog(dialog: Dialog): void {
    const policy = this.policies.at(-1)
    const accepted = policy?.action === 'accept'
    const opening = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
    }
    const answer = accepted ? policy?.text ?? opening.defaultValue : ''
    // The page is blocked until this lands, and it is the page's to receive
    // rather than this code's to wait for: a rejection here is the dialog
    // having been taken away by something else, which the report still names.
    void (accepted ? dialog.accept(policy?.text) : dialog.dismiss()).catch(() => {})
    this.dialogs.push({
      ...opening,
      handled: accepted ? 'accepted' : 'dismissed',
      // Only a prompt is answered *with* something; an accepted alert or
      // confirm carries no text, and printing one would invent it.
      ...accepted && opening.type === 'prompt' ? { answer } : {},
    })
  }

  /**
   * The dialogs the pages have answered since this was last called.
   * @returns what each page asked and how it was answered, in the order they came.
   */
  takeDialogs(): readonly DialogReport[] {
    const taken = this.dialogs
    this.dialogs = []
    return taken
  }

  /**
   * What the current document has said about itself.
   *
   * The reading half of the console listener: the entries were already collected
   * as they happened, so this is a filter and a page identity rather than a
   * protocol call — and it never starts a browser, because the question is about
   * a page that exists.
   *
   * The newest entries are the ones kept when a caller asks for fewer than
   * matched, because the last thing a page said before it went quiet is what
   * explains the quiet.
   * @param options - which levels to keep, a substring to match, and how many entries to return.
   * @returns the entries, how much of the buffer they are, and which page they came from.
   * @throws {Error} when nothing is open to read.
   */
  async pageConsole(options: {
    levels?: readonly string[]
    filter?: string
    limit?: number
  } = {}): Promise<ConsoleReport> {
    const page = this.page
    if (page === undefined) {
      throw new Error(
        'dsh-browser: nothing is open to read a console from; open an address with browser_navigate first',
      )
    }
    const wanted = options.levels === undefined || options.levels.length === 0
      ? undefined
      : new Set(options.levels.map(level => level.toLowerCase()))
    const needle = options.filter === undefined ? undefined : options.filter.toLowerCase()
    const matched = this.said.filter((entry) => {
      if (wanted !== undefined && !wanted.has(entry.level)) return false
      return needle === undefined || entry.message.toLowerCase().includes(needle)
    })
    const limit = Math.max(1, Math.floor(options.limit ?? CONSOLE_LIMIT))
    const state = await this.stateOf(page)
    return {
      entries: matched.slice(-limit),
      matched: matched.length,
      total: this.said.length,
      dropped: this.dropped,
      url: state.url,
      title: state.title,
    }
  }

  /**
   * Start collecting what the page says about itself.
   *
   * Subscribed rather than asked: these events have to be caught as they happen,
   * because the failure worth explaining is the one that leaves no other trace —
   * a script that throws while the document loads has already thrown by the time
   * any tool could ask about it. The protocol only sends them to a client that
   * enabled the domains first, so both enables happen here, at attach time.
   *
   * Neither enable is awaited into the caller's path: a page that does not answer
   * one is a page with an empty console, which is exactly what a page that said
   * nothing looks like.
   * @param cdp - the session attached to the page.
   */
  private async listenToConsole(cdp: CDPSession): Promise<void> {
    this.forgetSaid()
    cdp.on('Runtime.consoleAPICalled', (event: unknown) => { this.keep(readConsoleCall(event)) })
    cdp.on('Runtime.exceptionThrown', (event: unknown) => { this.keep(readExceptionThrown(event)) })
    cdp.on('Log.entryAdded', (event: unknown) => { this.keep(readLogEntry(event)) })
    await Promise.all([
      cdp.send('Runtime.enable').catch(() => undefined),
      cdp.send('Log.enable').catch(() => undefined),
    ])
  }

  /** Forget what the page said: a new document has its own console. */
  private forgetSaid(): void {
    this.said = []
    this.dropped = 0
  }

  /**
   * Keep one entry, and count what the buffer could not hold.
   * @param entry - the entry to keep, or `undefined` when the event said nothing readable.
   */
  private keep(entry: ConsoleEntry | undefined): void {
    if (entry === undefined) return
    this.said.push(entry)
    if (this.said.length <= CONSOLE_LIMIT) return
    this.said.shift()
    this.dropped += 1
  }

  /**
   * Run one call under the dialog policy it declared.
   * @param policy - the answer to give a dialog that opens while the call runs.
   * @param work - the call itself, from its first protocol call to its report.
   * @returns what the call produced.
   */
  private async underPolicy<T>(policy: DialogPolicy | undefined, work: () => Promise<T>): Promise<T> {
    this.policies.push(policy ?? { action: 'dismiss' })
    try {
      return await work()
    } finally {
      this.policies.pop()
    }
  }

  /**
   * Open an address in the active page and report what the page became.
   * @param url - absolute address to load.
   * @param options - how to answer a dialog the navigation opens, such as the
   * `beforeunload` a page about to be left shows.
   * @returns where the page landed, and what changed to get there.
   */
  async navigate(url: string, options: { dialog?: DialogPolicy } = {}): Promise<ActionReport> {
    return await this.underPolicy(options.dialog, async () => {
      await this.ensure()
      const before = await this.stateOf()
      const page = this.requirePage()
      this.viewport = undefined
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      this.publish()
      return await this.settle(before, {})
    })
  }

  /** Reload the active page. */
  async reload(): Promise<void> {
    await this.ensure()
    this.viewport = undefined
    await this.requirePage().reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.publish()
  }

  /**
   * Replace the browser with a freshly started one.
   *
   * This is what a viewer asks for when the browser it was watching is gone or
   * unusable: the session keeps its browser slot, the process is new, and the
   * pages of the old one are not carried over.
   * @throws {Error} when the new browser cannot start.
   */
  async restart(): Promise<void> {
    await this.close()
    await this.ensure()
  }

  /**
   * Capture the active page, the whole of it, or one element.
   *
   * A viewport capture is what a person looking at the window sees. `fullPage`
   * is the document, which is what a page taller than the window needs — the
   * reference runtime offers the same option (`screenshot({ fullPage })`), and
   * for the same reason: judging a layout from the part of it that happens to be
   * on screen is guesswork. A `target` captures the element itself, addressed
   * the same way an action addresses one, which is the feature its own
   * coordinate-only element capture lacks.
   *
   * Every capture is a page-space clip with `captureBeyondViewport`, because
   * that is what the protocol needs to reach anything below the fold and it does
   * so without scrolling: measured 2026-09-29, the clip is in page pixels and is
   * taken at the same bytes whatever the current scroll is.
   * @param options - the whole document instead of the viewport, or one element.
   * @returns the encoded image, the size it was taken at, and the element when one was named.
   * @throws {Error} when a target names no element or several, or has no box.
   */
  async screenshot(options: { fullPage?: boolean; target?: ElementTarget } = {}): Promise<Screenshot> {
    await this.ensure()
    const cdp = this.cdpSession()
    if (options.target !== undefined) {
      const found = await this.resolveElement(options.target)
      const box = await this.boxOf(cdp, found)
      const jpeg = await this.capture(cdp, box)
      return {
        jpeg,
        width: box.width,
        height: box.height,
        element: { role: found.role, name: found.name },
      }
    }
    const metrics = await cdp.send('Page.getLayoutMetrics') as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssContentSize?: { width?: number; height?: number }
    }
    if (options.fullPage === true) {
      const size = {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(metrics.cssContentSize?.width ?? 0)),
        height: Math.max(1, Math.ceil(metrics.cssContentSize?.height ?? 0)),
      }
      return { jpeg: await this.capture(cdp, size), width: size.width, height: size.height }
    }
    const view = {
      width: metrics.cssVisualViewport?.clientWidth ?? 0,
      height: metrics.cssVisualViewport?.clientHeight ?? 0,
    }
    const captured = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: this.config.quality,
    }) as { data: string }
    return { jpeg: Buffer.from(captured.data, 'base64'), width: view.width, height: view.height }
  }

  /**
   * Capture one rectangle of the page.
   * @param cdp - session attached to the active page.
   * @param clip - the rectangle, in the page's own CSS pixels.
   * @returns the encoded image.
   */
  private async capture(cdp: CDPSession, clip: PageBox): Promise<Buffer> {
    const captured = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: this.config.quality,
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: true,
    }) as { data: string }
    return Buffer.from(captured.data, 'base64')
  }

  /**
   * The rectangle the page says an element occupies.
   * @param cdp - session attached to the active page.
   * @param target - the element to measure.
   * @returns the rectangle in page pixels.
   * @throws {Error} when the element has no box in the page.
   */
  private async boxOf(cdp: CDPSession, target: RefTarget): Promise<PageBox> {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: target.backendNodeId })
      .catch(() => undefined) as { object?: { objectId?: string } } | undefined
    const objectId = resolved?.object?.objectId
    if (objectId === undefined) throw boxlessError(target)
    const answer = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: clipProbe(),
      returnByValue: true,
    }).catch(() => undefined) as { result?: { value?: unknown } } | undefined
    const box = readClip(answer?.result?.value)
    if (box === undefined) throw boxlessError(target)
    return box
  }

  /**
   * Evaluate an expression in the active page and return its value.
   * @param expression - JavaScript source evaluated as an expression.
   * @param options - how to answer a dialog the expression opens, which a
   * script that clicks a button on `confirm`-guarded page does.
   * @returns the value, decoded when it is JSON-representable.
   * @throws {Error} when the page throws or the value cannot be decoded.
   */
  async evaluate(expression: string, options: { dialog?: DialogPolicy } = {}): Promise<unknown> {
    return await this.underPolicy(options.dialog, async () => {
      await this.ensure()
      return await this.evaluateIn(this.cdpSession(), expression)
    })
  }

  /**
   * Wait for the page to reach a state, then report whether it did.
   *
   * A page that is starting an engine, connecting a socket, or loading a
   * scenario takes seconds to become ready, and nothing about that is a
   * mutation of the document the caller just touched — so this asks the page the
   * same question repeatedly instead of guessing a length of time. Each ask is
   * the locator resolution an action uses, which is why the words are the same:
   * what a wait can match is what a click can name.
   *
   * The page is watched from before the first ask, so the changes a wait reports
   * are the page's own answer to "what happened while I waited".
   * @param condition - an element to appear, an address to contain something, or
   * plainly a length of time.
   * @param options - the budget, how often to ask, and how to answer a dialog the
   * page opens while waiting.
   * @returns whether the condition held, and what the page looked like either way.
   * @throws {Error} when nothing is open to wait on, or the page refuses a selector.
   */
  async wait(
    condition: WaitCondition,
    options: { timeoutMs: number; pollMs?: number; dialog?: DialogPolicy },
  ): Promise<WaitReport> {
    return await this.underPolicy(options.dialog, async () => {
      const page = this.page
      if (page === undefined) {
        throw new Error(
          'dsh-browser: nothing is open to wait on; open an address with browser_navigate first',
        )
      }
      const pollMs = Math.max(1, options.pollMs ?? WAIT_POLL_MS)
      const started = Date.now()
      const watch = this.cdp === undefined ? undefined : await this.armSettle(this.cdp, page)
      let matched = false
      let element: ElementRef | undefined
      let matches: number | undefined
      if (condition.timeMs !== undefined) {
        await sleep(Math.min(condition.timeMs, options.timeoutMs))
        matched = true
      } else {
        const deadline = started + options.timeoutMs
        for (;;) {
          const answered = await this.conditionHolds(condition)
          matches = answered.matches
          if (answered.held) {
            matched = true
            element = answered.element
            break
          }
          // The condition is asked before the deadline is read, so one that
          // becomes true at the last moment is still reported as matched.
          if (Date.now() >= deadline) break
          await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
        }
      }
      const record = watch === undefined ? undefined : await this.readSettle(watch)
      const after = await this.stateOf(page)
      const changes = record?.changes ?? []
      const omitted = record?.omitted ?? 0
      return {
        matched,
        waitedMs: Date.now() - started,
        url: after.url,
        title: after.title,
        ...element === undefined ? {} : { element },
        ...matches === undefined ? {} : { matches },
        ...changes.length === 0 ? {} : { changes },
        ...omitted === 0 ? {} : { changesOmitted: omitted },
      }
    })
  }

  /**
   * Whether a wait's condition holds right now.
   * @param condition - an element to appear, or an address to contain something.
   * @returns whether it holds, the element that satisfied it, and how many did.
   * @throws {Error} when the page refuses a selector.
   */
  private async conditionHolds(
    condition: WaitCondition,
  ): Promise<{ held: boolean; element?: ElementRef; matches?: number }> {
    if (condition.url !== undefined) {
      const url = this.requirePage().url()
      return { held: url.toLowerCase().includes(condition.url.toLowerCase()) }
    }
    // A condition with neither an address nor a locator is a fixed wait, which
    // the caller never reaches here.
    if (condition.locator === undefined) return { held: true }
    const candidates = await this.locate(condition.locator)
    const first = candidates[0]
    return {
      held: candidates.length > 0,
      matches: candidates.length,
      ...first === undefined ? {} : { element: { role: first.role, name: first.name } },
    }
  }

  /**
   * Read the active page as an accessibility tree.
   *
   * Refs keep whatever label the page already gave them, so a ref from an
   * earlier snapshot of this page still names the same element; only a page that
   * goes away clears them. The budget, the depth limit, and a target subtree are
   * what keep a large page from spending the conversation's context on itself,
   * and a query is the sharper form of the same thing: printing the paths to the
   * lines that answer a question instead of the whole page.
   * @param options - a subtree to print, how deep to print it, a query to keep
   * only what answers it, and whether to print each element's box.
   * @returns the tree as text, the refs it used, and the page geometry.
   * @throws {Error} when a target names nothing on the page, or a query is not
   * a usable expression.
   */
  async snapshot(options: {
    target?: string
    depth?: number
    find?: string
    boxes?: boolean
  } = {}): Promise<PageSnapshot> {
    await this.ensure()
    const cdp = this.cdpSession()
    const ignore = await this.ignoredNodes(cdp)
    const target: SnapshotTarget | undefined = options.target === undefined
      ? undefined
      : await this.resolveTarget(cdp, options.target)
    const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes?: readonly AxNode[] }
    const attributes = listOf(this.config.snapshotAttributes)
    const query = options.find === undefined ? undefined : parseQuery(options.find)
    const shared: SnapshotOptions = {
      ...attributes.length === 0 ? {} : { attributes },
      ...target === undefined ? {} : { target },
      ...options.depth === undefined ? {} : { depth: options.depth },
      ...ignore.size === 0 ? {} : { ignore },
      ...query === undefined ? {} : { find: query },
    }
    const nodes = tree.nodes ?? []
    const boxes = options.boxes === true ? await this.boxesFor(cdp, nodes, shared) : undefined
    const snapshot = formatAxTree(nodes, {
      maxNodes: this.config.snapshotNodes,
      labels: this.labels,
      ...shared,
      ...boxes === undefined ? {} : { boxes },
    })
    const metrics = await cdp.send('Page.getLayoutMetrics')
    return { ...snapshot, info: pageInfoFromMetrics(metrics) }
  }

  /**
   * Where the elements a snapshot will print sit in the viewport.
   *
   * Which elements print is decided by the same rules as the text is, so it is
   * asked of the formatter rather than guessed again here — with a throwaway
   * label registry, because a question about geometry must not spend the page's
   * refs on itself. The box comes from `DOM.getContentQuads`, the call the click
   * path measured as returning the frame's viewport pixels, so a line's numbers
   * and a click's point are in the same space.
   * @param cdp - session attached to the active page.
   * @param nodes - the accessibility tree the snapshot will print.
   * @param plan - the rest of the options the snapshot was asked for.
   * @returns a box per DOM node that reported one.
   */
  private async boxesFor(
    cdp: CDPSession,
    nodes: readonly AxNode[],
    plan: SnapshotOptions,
  ): Promise<ReadonlyMap<number, Box>> {
    const planned = formatAxTree(nodes, { ...plan, labels: new RefLabels() })
    const boxes = new Map<number, Box>()
    await Promise.all([...new Set(planned.refs.values())].map(async (backendNodeId) => {
      const answer = await cdp.send('DOM.getContentQuads', { backendNodeId })
        .catch(() => undefined) as { quads?: readonly (readonly number[])[] } | undefined
      const box = boundingBoxOf(answer?.quads?.[0])
      if (box !== undefined) boxes.set(backendNodeId, box)
    }))
    return boxes
  }

  /**
   * The elements the page asked to keep out of a snapshot.
   *
   * A site can mark what is decoration, or what the plugin should never print,
   * with a selector the configuration names; those DOM nodes are resolved to the
   * accessibility nodes behind them once per snapshot, which costs two protocol
   * calls when nothing matches and one per match when something does.
   * @param cdp - session attached to the active page.
   * @returns the backend node ids to drop.
   */
  private async ignoredNodes(cdp: CDPSession): Promise<ReadonlySet<number>> {
    const ignored = new Set<number>()
    const selectors = listOf(this.config.snapshotIgnore)
    if (selectors.length === 0) return ignored
    const document = await cdp.send('DOM.getDocument', { depth: 0 }).catch(() => undefined) as
      { root?: { nodeId?: number } } | undefined
    const rootNodeId = document?.root?.nodeId
    if (rootNodeId === undefined) return ignored
    for (const selector of selectors) {
      const found = await cdp.send('DOM.querySelectorAll', { nodeId: rootNodeId, selector })
        .catch(() => undefined) as { nodeIds?: readonly number[] } | undefined
      for (const nodeId of found?.nodeIds ?? []) {
        const described = await cdp.send('DOM.describeNode', { nodeId, depth: -1, pierce: false })
          .catch(() => undefined) as { node?: DomNode } | undefined
        const walk = (node: DomNode | undefined): void => {
          if (node === undefined) return
          if (node.backendNodeId !== undefined) ignored.add(node.backendNodeId)
          for (const child of node.children ?? []) walk(child)
        }
        walk(described?.node)
      }
    }
    return ignored
  }

  /**
   * Resolve what a snapshot's `target` names.
   * @param cdp - session attached to the active page.
   * @param target - a ref this page handed out, or a CSS selector.
   * @returns the DOM node to print from.
   * @throws {Error} when the ref is unknown or the selector matches nothing.
   */
  private async resolveTarget(cdp: CDPSession, target: string): Promise<SnapshotTarget> {
    const known = this.labels.targetOf(target)
    if (known !== undefined) return { backendNodeId: known.backendNodeId, described: target }
    // A ref-shaped name that this page never handed out is a stale ref, not a
    // selector; saying so is more use than "no element matches e9".
    if (/^e\d+$/.test(target)) {
      throw new Error(
        `dsh-browser: ${target} is not a ref from a snapshot of the current page; `
        + 'call browser_snapshot and use a ref from its result',
      )
    }
    const document = await cdp.send('DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: number } }
    const rootNodeId = document.root?.nodeId
    if (rootNodeId === undefined) throw new Error(`dsh-browser: could not read the page to look up ${target}`)
    const found = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: target }) as { nodeId?: number }
    if (found.nodeId === undefined || found.nodeId === 0) {
      throw new Error(`dsh-browser: no element matches ${target}; check the selector, or take a full snapshot and use a ref`)
    }
    const described = await cdp.send('DOM.describeNode', { nodeId: found.nodeId }) as { node?: DomNode }
    if (described.node?.backendNodeId === undefined) {
      throw new Error(`dsh-browser: no element matches ${target}; check the selector, or take a full snapshot and use a ref`)
    }
    return { backendNodeId: described.node.backendNodeId, described: target }
  }

  /**
   * Click the element a ref names, with real mouse events.
   *
   * The events are dispatched through the same input channel a viewer's clicks
   * use, which is what makes them trusted: a site that ignores a synthetic
   * `element.click()` accepts these. The page is asked where the element is and
   * what a press there would reach, and a press the page says would be received
   * by something else is refused rather than sent — a click that lands on an
   * overlay changes nothing and used to be reported as a success.
   * @param target - a ref from a snapshot of the current page, or a locator to
   * resolve now.
   * @param options - `force` presses even when the page says something else
   * would receive it; `button` picks which button presses; `double` sends the
   * two press-release pairs a page reads as one double click; `dialog` answers
   * a dialog the click opens.
   * @returns the element that was clicked, where the page ended up, and what changed.
   * @throws {Error} when the target names no element or several, the element has
   * nothing to click, or (without `force`) the press would be received by
   * something other than the element.
   */
  async click(
    target: ElementTarget,
    options: { force?: boolean; button?: MouseButton; double?: boolean; dialog?: DialogPolicy } = {},
  ): Promise<ActionReport> {
    return await this.underPolicy(options.dialog, async () => {
      await this.ensure()
      const started = this.page
      const before = await this.stateOf(started)
      const cdp = this.cdpSession()
      const { target: resolved, recovered, result } = await this.actOn(target, async (found) => {
        const point = await this.pressPoint(cdp, found)
        if (point.outside) {
          throw new Error(
            `dsh-browser: ${elementName(found)} is outside the viewport even after scrolling it into view, `
            + 'so the click has nowhere to land; take a new snapshot and try again',
          )
        }
        if (point.over !== undefined && options.force !== true) {
          throw new Error(
            `dsh-browser: the click would be received by ${elementName(point.over)}, not ${elementName(found)}; `
            + 'pass force: true to click anyway, or take a new snapshot of what is over it',
          )
        }
        // Armed after the point is known and before the events are dispatched:
        // a page that reacts inside its handler has nothing left to do by the
        // time the protocol call returns.
        const watch = await this.armSettle(cdp, started)
        const button = options.button ?? 'left'
        // A double click is not two clicks: the second pair carries click count
        // 2, which is the only thing that tells the page the two are one gesture.
        const presses = options.double === true ? 2 : 1
        await dispatchInput(cdp, { type: 'mouse', action: 'move', x: point.x, y: point.y })
        for (let count = 1; count <= presses; count += 1) {
          await dispatchInput(cdp, { type: 'mouse', action: 'down', x: point.x, y: point.y, button, clickCount: count })
          await dispatchInput(cdp, { type: 'mouse', action: 'up', x: point.x, y: point.y, button, clickCount: count })
        }
        return { watch, obstructed: point.over }
      })
      return await this.settle(before, {
        element: { role: resolved.role, name: resolved.name },
        recovered,
        ...result.obstructed === undefined ? {} : { obstructed: result.obstructed },
      }, result.watch)
    })
  }

  /**
   * Press a key on whatever the page has focused.
   *
   * This is the keyboard gesture that is not typing: Escape closing a menu that
   * is not in the snapshot, a shortcut a site only answers to by keyboard, Tab
   * walking the focus. Naming no element is the point — moving the focus to type
   * would change which element the page considers active, and that is exactly
   * what the caller is not asking for.
   * @param key - a key name or a chord such as `Escape`, `Tab`, or `Control+A`.
   * @param options - how to answer a dialog the key opens.
   * @returns where the page ended up and what changed.
   * @throws {Error} when the key has no dispatch mapping.
   */
  async press(key: string, options: { dialog?: DialogPolicy } = {}): Promise<ActionReport> {
    return await this.type(undefined, '', { key, ...options })
  }

  /**
   * Type into the element a ref names, or into whatever the page has focused.
   *
   * Text arrives through `Input.insertText`, so it is inserted as characters
   * rather than replayed as keystrokes — which is what makes non-Latin input
   * work. A key is pressed afterwards for fields whose meaning is the Enter
   * that follows. The page is asked after the focus and before the first
   * character whether it will take the text at all, because a control that
   * cannot hold it takes nothing while the report used to say it had been typed.
   *
   * A call with no target types where the focus already is and replaces nothing:
   * there is no element to select the old value of, and guessing one from the
   * document's `activeElement` would be a claim about which element the caller
   * meant.
   * @param target - a ref from a snapshot of the current page, a locator to
   * resolve now, or `undefined` to leave the focus where it is.
   * @param value - the text to insert; empty inserts none.
   * @param options - whether to replace the current content, a key to press
   * after, and how to answer a dialog either one opens.
   * @returns the element that was typed into, where the page ended up, and what changed.
   * @throws {Error} when the target names no element or several, or the page says
   * the text would not land in it.
   */
  async type(
    target: ElementTarget | undefined,
    value: string,
    options: { clear?: boolean; key?: string; dialog?: DialogPolicy } = {},
  ): Promise<ActionReport> {
    return await this.underPolicy(options.dialog, async () => {
      await this.ensure()
      const started = this.page
      const before = await this.stateOf(started)
      const cdp = this.cdpSession()
      /**
       * Write the text and press the key, watching the page from before either.
       * @returns where to read what the page did about it.
       */
      const write = async (): Promise<SettleWatch> => {
        // Watching starts before the text does: a field that reacts by rewriting
        // itself — a filter redrawing its list — does it in the input event.
        const watch = await this.armSettle(cdp, started)
        if (value !== '') await dispatchInput(cdp, { type: 'text', text: value })
        if (options.key !== undefined) await dispatchInput(cdp, { type: 'key', key: options.key })
        return watch
      }
      if (target === undefined) return await this.settle(before, {}, await write())
      const { target: resolved, recovered, result } = await this.actOn(target, async (found) => {
        await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: found.backendNodeId }).catch(() => {})
        // The focus is not taken on trust: a control that cannot be focused —
        // measured 2026-09-29, a disabled input — makes `DOM.focus` itself
        // reject, which is a protocol failure the page has a reason for. The
        // page is asked anyway, so the refusal names the element and the reason
        // rather than the transport's framing of the call.
        const refused = await cdp.send('DOM.focus', { backendNodeId: found.backendNodeId })
          .then(() => undefined, (error: unknown) => error)
        const answer = await this.assertTyped(cdp, found)
        if (refused !== undefined && answer?.accepts !== false) {
          throw new Error(
            `dsh-browser: the page would not focus ${elementName(found)} (${protocolReason(refused)}); `
            + 'nothing was typed, so take a new snapshot and check the element',
          )
        }
        if (options.clear !== false) {
          // Selection is the one part of this that is not a trusted event: what
          // follows is the insertion, which is.
          await this.evaluateIn(cdp, 'globalThis.document.activeElement?.select?.()').catch(() => {})
        }
        return await write()
      })
      return await this.settle(before, {
        element: { role: resolved.role, name: resolved.name },
        recovered,
      }, result)
    })
  }

  /**
   * Act on a ref, finding the element again if the DOM replaced it.
   *
   * A single-page app re-renders an element by removing the old node and
   * inserting a new one, which leaves the ref pointing at nothing while the
   * element the model asked for is still on the page. The role and name the
   * snapshot recorded are enough to find it again, and a failed action is only
   * retried when exactly one element matches, so a retry can never land
   * somewhere the model did not name.
   * @param target - a ref from a snapshot, or a locator to resolve now.
   * @param run - the action, given the element it should act on.
   * @returns what the action acted on, whether it had to be found again, and
   * whatever the action itself produced.
   * @throws {Error} when the target names no element, names several, or when the
   * action fails for a reason other than the element having gone.
   */
  private async actOn<T>(
    target: ElementTarget,
    run: (found: RefTarget) => Promise<T>,
  ): Promise<{ target: RefTarget; recovered: boolean; result: T }> {
    const resolved = await this.resolveElement(target)
    try {
      return { target: resolved, recovered: false, result: await run(resolved) }
    } catch (error) {
      if (!elementGone(error)) throw error
      const healed = await this.healTarget(target, resolved)
      if (healed === undefined) throw error
      return { target: healed, recovered: true, result: await run(healed) }
    }
  }

  /**
   * The one element a target names, or a refusal naming the others.
   *
   * A ref is looked up in the registry the snapshot filled. A locator is asked
   * of the page as it is now, and an answer of zero or several elements is an
   * error rather than a guess: acting on the first of several would press an
   * element the caller did not name, and reporting none would describe a page
   * that is not empty as empty.
   * @param target - a ref from a snapshot, or a locator.
   * @returns the element to act on.
   * @throws {Error} when the ref is unknown, or the locator is not exactly one element.
   */
  private async resolveElement(target: ElementTarget): Promise<RefTarget> {
    if (typeof target === 'string') return this.nodeFor(target)
    const candidates = await this.locate(target)
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only !== undefined) return only
    throw candidates.length === 0
      ? locateMissError(target)
      : locateAmbiguousError(target, candidates)
  }

  /**
   * Every element the page currently answers a locator with.
   *
   * A selector is resolved against the document and mapped back by node id, so
   * a caller can reach an element the accessibility tree does not describe —
   * `role`/`name`/`text` read the tree, because that is where a name lives. A
   * locator that says both is narrowed by both, which is what a caller writing
   * both would expect; the tool layer does not offer that combination.
   * @param locator - what the caller asked for.
   * @returns the candidates, in tree order.
   * @throws {Error} when the page refuses the selector itself.
   */
  private async locate(locator: Locator): Promise<Located[]> {
    const tree = await this.cdpSession().send('Accessibility.getFullAXTree')
      .catch(() => undefined) as { nodes?: readonly AxNode[] } | undefined
    const nodes = tree?.nodes ?? []
    if (locator.selector === undefined) return locateInTree(nodes, locator)
    const bySelector = await this.locateBySelector(locator.selector, nodes)
    if (!locatorIsTreeShaped(locator)) return bySelector
    const allowed = new Set(bySelector.map(candidate => candidate.backendNodeId))
    return locateInTree(nodes, locator).filter(candidate => allowed.has(candidate.backendNodeId))
  }

  /**
   * The elements a CSS selector matches, read through the DOM.
   *
   * The tree is consulted for each match so a candidate carries the role and
   * name a message needs; an element the tree does not describe is reported by
   * its tag, which is a worse name than a role and a much better one than
   * nothing at all.
   * @param selector - the CSS selector.
   * @param nodes - the accessibility tree, for naming what was matched.
   * @returns the candidates.
   * @throws {Error} when the page refuses the selector.
   */
  private async locateBySelector(selector: string, nodes: readonly AxNode[]): Promise<Located[]> {
    const cdp = this.cdpSession()
    const document = await cdp.send('DOM.getDocument', { depth: 0 })
      .catch(() => undefined) as { root?: { nodeId?: number } } | undefined
    const root = document?.root?.nodeId
    if (root === undefined) return []
    let matched: readonly number[]
    try {
      const answer = await cdp.send('DOM.querySelectorAll', { nodeId: root, selector }) as { nodeIds?: readonly number[] }
      matched = answer.nodeIds ?? []
    } catch (error) {
      // A selector the page cannot parse is a question that was never asked,
      // and reporting it as "no element matches" would send the caller looking
      // for another element instead of at its own typo.
      throw new Error(
        `dsh-browser: the page refused the selector ${JSON.stringify(selector)}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const found: Located[] = []
    for (const nodeId of matched) {
      const answer = await cdp.send('DOM.describeNode', { nodeId })
        .catch(() => undefined) as { node?: { backendNodeId?: number; nodeName?: string } } | undefined
      const backendNodeId = answer?.node?.backendNodeId
      if (backendNodeId === undefined) continue
      // The tree names the match when it describes it, which is what a refusal
      // lists; when it does not, the element stays described by nothing, and the
      // absence of a trail is reported as exactly that rather than as an answer.
      found.push(entryInTree(nodes, backendNodeId) ?? {
        backendNodeId,
        role: (answer?.node?.nodeName ?? 'element').toLowerCase(),
        name: '',
      })
    }
    return found
  }

  /**
   * Find the element a target named, after the DOM node behind it went away.
   * @param target - the target to re-point.
   * @param stale - what the target named when it was resolved.
   * @returns the element's new DOM node, or `undefined` when the page no longer
   * answers the target with exactly one element.
   */
  private async healTarget(target: ElementTarget, stale: RefTarget): Promise<RefTarget | undefined> {
    if (typeof target === 'string') return await this.findAgain(target, stale)
    const candidates = await this.locate(target).catch(() => [])
    // Only a single answer is safe to retry on: acting on the first of several
    // would land somewhere the caller did not name, which is the trade the
    // refusal in `resolveElement` already made.
    return candidates.length === 1 ? candidates[0] : undefined
  }

  /**
   * Find the element a ref named, after the DOM node behind it went away.
   * @param ref - the ref to re-point.
   * @param stale - what the ref named when the snapshot recorded it.
   * @returns the element's new DOM node, or `undefined` when the page has no
   * single element matching it.
   */
  private async findAgain(ref: string, stale: RefTarget): Promise<RefTarget | undefined> {
    const tree = await this.cdpSession().send('Accessibility.getFullAXTree')
      .catch(() => undefined) as { nodes?: readonly AxNode[] } | undefined
    const matches: RefTarget[] = []
    for (const node of tree?.nodes ?? []) {
      const candidate = refTargetOf(node)
      if (candidate !== undefined && candidate.role === stale.role && candidate.name === stale.name) {
        matches.push(candidate)
      }
    }
    const found = matches.length === 1 ? matches[0] : undefined
    if (found === undefined) return undefined
    this.labels.rebind(ref, found)
    return found
  }

  /** What the active page shows right now. */
  private async stateOf(page: Page | undefined = this.page): Promise<PageState> {
    if (page === undefined) return { url: '', title: '' }
    return { url: page.url(), title: await page.title().catch(() => '') }
  }

  /**
   * Wait for a page to stop changing, then describe what it became.
   *
   * A click on a client-rendered control returns from the protocol before the
   * page has drawn the result, and a click on a link returns before the next
   * document exists. Waiting for the document and then for a quiet moment is
   * what makes the reported address and title the ones the model will act on.
   * @param before - the page state the action started from.
   * @param detail - the element acted on, whether it had to be found again, and
   * what was over the point it was clicked at.
   * @param armed - the probe a caller installed before dispatching its input.
   * @returns the report a tool result is rendered from.
   */
  private async settle(
    before: PageState,
    detail: { element?: ElementRef; recovered?: boolean; obstructed?: ElementRef },
    armed?: SettleWatch,
  ): Promise<ActionReport> {
    const started = armed?.page ?? this.page
    if (started !== undefined) {
      await started.waitForLoadState('domcontentloaded', { timeout: SETTLE_NAVIGATION_MS }).catch(() => {})
    }
    // An action that armed a probe before its input is watched by that probe,
    // as long as it stayed on the page it began on. An action that moved to
    // another page — a link that opened a tab — has its own document, and that
    // document is what gets watched instead; so does a caller that dispatched
    // no input at all, which has nothing to watch for but the navigation.
    const watch = armed !== undefined && armed.page === this.page
      ? armed
      : this.cdp === undefined || this.page === undefined ? undefined : await this.armSettle(this.cdp, this.page)
    let mutations = 0
    let settled = true
    let changes: readonly DomChange[] = []
    let omitted = 0
    if (watch !== undefined) {
      const record = await this.readSettle(watch)
      mutations = record.mutations
      settled = record.settled
      changes = record.changes
      omitted = record.omitted
    }
    const after = await this.stateOf(this.page ?? started)
    const changed: string[] = []
    if (after.url !== before.url) changed.push('url')
    if (after.title !== before.title) changed.push('title')
    if (mutations > 0) changed.push('dom')
    // A dialog is a change of its own: the page may have drawn nothing at all
    // while it asked its question, and "the page did not change" would then be
    // the report for a click that a site stopped to confirm.
    const dialogs = this.takeDialogs()
    if (dialogs.length > 0) changed.push('dialog')
    return {
      url: after.url,
      title: after.title,
      changed,
      mutations,
      settled,
      ...changes.length === 0 ? {} : { changes },
      ...omitted === 0 ? {} : { changesOmitted: omitted },
      ...detail.element === undefined ? {} : { element: detail.element },
      ...detail.recovered === undefined ? {} : { recovered: detail.recovered },
      ...detail.obstructed === undefined ? {} : { obstructed: detail.obstructed },
      ...dialogs.length === 0 ? {} : { dialogs },
    }
  }

  /**
   * Start watching a page for changes, before the action that causes them.
   *
   * The observer has to be installed first. A page that reacts inside its own
   * handler — a `<details>` opening, a class toggled by a script — has finished
   * by the time the protocol call returns, and a probe started after that sees
   * a page that never moved: measured 2026-09-25 on github.com/trending, where
   * clicking a disclosure reported "did not change" while its menu opened. Only
   * a reaction that is deferred to a later task was ever seen.
   * @param cdp - session attached to the page being acted on.
   * @param page - the page the action is about to act on.
   * @returns where to read what the probe saw.
   */
  private async armSettle(cdp: CDPSession, page: Page | undefined): Promise<SettleWatch> {
    this.settleSeq += 1
    const slot = `${SETTLE_SLOT}${String(this.settleSeq)}`
    // The comma expression installs the promise without awaiting it, which is
    // the whole point: the observer has to be running before the events go out.
    await this.evaluateIn(cdp, `(globalThis.${slot} = ${settleProbe()}, 0)`).catch(() => {})
    return { page, cdp, slot }
  }

  /**
   * Read what an armed probe saw, and let the page drop it.
   *
   * The record comes from the page, so it is read as data rather than trusted:
   * an entry is kept only when it is one of the kinds a result declares and its
   * fields are the types it declares, each field is cut at the bound the page was
   * given as well, and the cap is applied on this side too — a page that ignores
   * the limit it was handed cannot make a tool result grow.
   * @param watch - the page and slot the probe was installed with.
   * @returns what the page made, and what it changed while it settled.
   */
  private async readSettle(watch: SettleWatch): Promise<{
    mutations: number
    settled: boolean
    changes: readonly DomChange[]
    omitted: number
  }> {
    const none = { mutations: 0, settled: true, changes: [], omitted: 0 }
    // A page that navigated during the action has no slot to read, and one that
    // answered with something else is a page this cannot be read from; either
    // way the address and title are what carry the change.
    const observed = await this.evaluateIn(
      watch.cdp,
      `(async () => { const record = await globalThis.${watch.slot}; globalThis.${watch.slot} = undefined; return record })()`,
    ).catch(() => undefined)
    if (typeof observed !== 'object' || observed === null) return none
    const record = observed as { mutations?: unknown; settled?: unknown; changes?: unknown; omitted?: unknown }
    const reported: readonly unknown[] = Array.isArray(record.changes) ? record.changes : []
    const changes: DomChange[] = []
    let beyond = 0
    for (const entry of reported) {
      const change = readChange(entry)
      if (change === undefined) continue
      if (changes.length < CHANGE_LIMIT) changes.push(change)
      else beyond += 1
    }
    const said = typeof record.omitted === 'number' && Number.isFinite(record.omitted)
      ? Math.max(0, Math.floor(record.omitted))
      : 0
    return {
      mutations: typeof record.mutations === 'number' ? record.mutations : 0,
      settled: typeof record.settled === 'boolean' ? record.settled : true,
      changes,
      omitted: said + beyond,
    }
  }

  /**
   * Where a press on a ref's element would land, and what the page says about it.
   *
   * The page is asked rather than the protocol, because the protocol's answer has
   * to be interpreted: measured 2026-09-24 on a scrolled Google result page,
   * `DOM.getContentQuads` returned the frame's viewport pixels (433 for a box
   * 2471 px down the document), so translating them by
   * `cssLayoutViewport.pageY` — as this used to — put the press at y = -1589,
   * outside the viewport, where it reached nothing while the report still called
   * the click a success. `getBoundingClientRect` needs no interpretation and
   * answers for nested scroll containers too.
   * @param cdp - session attached to the active page.
   * @param target - the element a ref names.
   * @returns the point to press, and what would receive it when that is not the element.
   * @throws {Error} when the element has no box in the page.
   */
  private async pressPoint(cdp: CDPSession, target: RefTarget): Promise<PressPoint> {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }).catch(() => {})
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: target.backendNodeId })
      .catch(() => undefined) as { object?: { objectId?: string } } | undefined
    const objectId = resolved?.object?.objectId
    if (objectId !== undefined) {
      // An element still moving gets one more reading rather than a press on a
      // box it has already left. Bounded at two: the second answer is used as it
      // comes, and the hit test it carries is what says whether it is right.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: pressProbe(),
          awaitPromise: true,
          returnByValue: true,
        }).catch(() => undefined) as { result?: { value?: unknown } } | undefined
        const said = readPress(answer?.result?.value)
        if (said === 'boxless') throw boxlessError(target)
        if (said === undefined) break
        if (!said.moved || attempt === 1) return said
      }
    }
    // The page would not describe the point at all — a node it has already
    // replaced, or a document this plugin cannot run in. The box CDP reports is
    // still an answer, and it is already in the pixels input is dispatched in,
    // so it is used exactly as it comes; what is lost with it is the hit test.
    const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId: target.backendNodeId }) as { quads?: number[][] }
    const quad = quads?.[0]
    if (quad === undefined) throw boxlessError(target)
    const centre = centerOfQuad(quad)
    return { x: centre.x, y: centre.y, moved: false, outside: false }
  }

  /**
   * Ask the page whether the element it just focused will take typed text.
   *
   * Called before the old value is selected and before any character is
   * inserted, so a control that cannot hold text is refused instead of reported
   * as typed into. A page that says nothing this code can read does not block
   * the text: this is a question the page answers, not a requirement it has to
   * satisfy, and the same shape of answer — a node CDP has already replaced —
   * leaves the old behaviour in place.
   * @param cdp - session attached to the active page.
   * @param target - the element a ref names.
   * @returns the page's answer, or `undefined` when the page said nothing usable.
   * @throws {Error} when the page says the text would not land in the element.
   */
  private async assertTyped(cdp: CDPSession, target: RefTarget): Promise<TypedAnswer | undefined> {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: target.backendNodeId })
      .catch(() => undefined) as { object?: { objectId?: string } } | undefined
    const objectId = resolved?.object?.objectId
    if (objectId === undefined) return undefined
    const answer = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: typedProbe(),
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => undefined) as { result?: { value?: unknown } } | undefined
    const said = readTyped(answer?.result?.value)
    if (said !== undefined && !said.accepts) {
      throw untypableError(target, said.why ?? 'the page would not take it')
    }
    return said
  }

  /**
   * The DOM node a ref names, and what it was when the snapshot labelled it.
   * @param ref - a ref from a snapshot of the current page.
   * @returns the element the ref names.
   * @throws {Error} when this page never handed out that ref.
   */
  private nodeFor(ref: string): RefTarget {
    const target = this.labels.targetOf(ref)
    if (target === undefined) {
      throw new Error(
        `dsh-browser: ${ref} is not a ref from a snapshot of the current page; `
        + 'call browser_snapshot and use a ref from its result',
      )
    }
    return target
  }

  /**
   * Evaluate an expression over one CDP session.
   *
   * A top-level `await` is a syntax error in the plain form and a valid REPL
   * expression in the other, so the REPL form is the retry rather than the
   * default: measured 2026-09-24, `replMode` also stops `awaitPromise` from
   * unwrapping a returned promise, which would turn `fetch(...)` into `{}`.
   *
   * A declaration the page already has is the second thing worth retrying. The
   * page keeps what an earlier call declared, so a caller that edits one snippet
   * and runs it again is told `Identifier 'el' has already been declared` —
   * a syntax error about the page's scope, not about the snippet. Retried inside
   * a block, the declaration belongs to that call, and everything else about the
   * source behaves the same.
   *
   * The third is a top-level `return`: the same snippet, as a function body,
   * produces the value the caller was asking for.
   * @param cdp - session to evaluate on.
   * @param expression - JavaScript source.
   * @param repl - whether to use the REPL form that accepts top-level await.
   * @param scoped - whether the source is already wrapped in a block of its own.
   * @param bodied - whether the source is already wrapped in a function body.
   * @returns the value, decoded when it is JSON-representable.
   * @throws {Error} when the page throws.
   */
  private async evaluateIn(
    cdp: CDPSession,
    expression: string,
    repl = false,
    scoped = false,
    bodied = false,
  ): Promise<unknown> {
    /** Whether the failure is the plain form rejecting a top-level await. */
    const retryable = (message: string): boolean => !repl && expression.includes('await')
      && /await is only valid|Unexpected (?:token|reserved word) '?await/iu.test(message)
    /** Whether the page refused the source because its scope already has the name. */
    const redeclared = (message: string): boolean => !scoped && /has already been declared/u.test(message)
    /** Whether the page refused a `return` that was not inside a function. */
    const returned = (message: string): boolean => !bodied && /Illegal return statement/u.test(message)
    let outcome: {
      result?: { value?: unknown; unserializableValue?: string; type?: string; objectId?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    try {
      outcome = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...repl ? { replMode: true } : {},
      }) as typeof outcome
    } catch (error) {
      // A compile error reaches the caller either as a protocol error or as an
      // exception detail, depending on where Chrome noticed it.
      const message = error instanceof Error ? error.message : String(error)
      if (redeclared(message)) return await this.evaluateIn(cdp, scopedBlock(expression), repl, true)
      if (returned(message)) return await this.evaluateIn(cdp, asyncBody(expression), repl, scoped, true)
      if (retryable(message)) return await this.evaluateIn(cdp, expression, true, scoped)
      throw error
    }
    if (outcome.exceptionDetails !== undefined) {
      const detail = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? 'evaluation failed'
      if (redeclared(detail)) return await this.evaluateIn(cdp, scopedBlock(expression), repl, true)
      if (returned(detail)) return await this.evaluateIn(cdp, asyncBody(expression), repl, scoped, true)
      if (retryable(detail)) return await this.evaluateIn(cdp, expression, true, scoped)
      throw new Error(detail)
    }
    const result = outcome.result
    if (result?.type === 'function') return await this.callResult(cdp, expression, result, repl, scoped, bodied)
    return result?.value ?? result?.unserializableValue
  }

  /**
   * Call a function the caller's expression produced.
   *
   * `() => 1` is a function, not a call, and a function has no value to send
   * back: it arrives as `{}`, which reads as an empty object and hides the fact
   * that nothing ran — including from a model that wrote `history.back()` and
   * was told the page returned nothing.
   * @param cdp - session the expression was evaluated on.
   * @param expression - the source that produced the function.
   * @param result - the remote object the evaluation answered with.
   * @param repl - whether the answer came from the REPL form.
   * @param scoped - whether the source was wrapped in a block of its own.
   * @param bodied - whether the source was wrapped in a function body.
   * @returns whatever calling the function produced.
   * @throws {Error} when the call throws.
   */
  private async callResult(
    cdp: CDPSession,
    expression: string,
    result: { objectId?: string },
    repl: boolean,
    scoped: boolean,
    bodied: boolean,
  ): Promise<unknown> {
    // A handle on the function is the shortest way to it, and the only one that
    // cannot run the caller's expression a second time.
    if (result.objectId !== undefined) {
      const called = await cdp.send('Runtime.callFunctionOn', {
        objectId: result.objectId,
        functionDeclaration: 'function () { return this() }',
        awaitPromise: true,
        returnByValue: true,
      }) as {
        result?: { value?: unknown; unserializableValue?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }
      if (called.exceptionDetails !== undefined) {
        throw new Error(
          called.exceptionDetails.exception?.description ?? called.exceptionDetails.text ?? 'evaluation failed',
        )
      }
      return called.result?.value ?? called.result?.unserializableValue
    }
    // No handle: the expression is the only way back to the function. Writing
    // it as a call is safe here because the expression already evaluated to a
    // function, which is a value the page handed over rather than an action.
    return await this.evaluateIn(cdp, `(${expression})()`, repl, scoped, bodied)
  }

  /**
   * Apply viewer input to the active page.
   * @param message - the decoded viewer message.
   */
  async input(message: InputMessage): Promise<void> {
    await this.ensure()
    const cdp = this.cdpSession()
    const size = await this.viewportSize(cdp)
    await dispatchInput(cdp, scaleToViewport(message, size))
  }

  /**
   * The page's CSS viewport, cached briefly so a pointer move is not a round trip.
   * @param cdp - session attached to the active page.
   * @returns the viewport in CSS pixels.
   */
  async viewportSize(cdp: CDPSession): Promise<{ width: number; height: number }> {
    const now = Date.now()
    if (this.viewport !== undefined && now - this.viewport.at < VIEWPORT_TTL_MS) return this.viewport.size
    const metrics = await cdp.send('Page.getLayoutMetrics') as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
    }
    const size = {
      width: metrics.cssVisualViewport?.clientWidth ?? 0,
      height: metrics.cssVisualViewport?.clientHeight ?? 0,
    }
    this.viewport = { at: now, size }
    return size
  }

  /**
   * The text the page has selected, for the pane's own clipboard.
   *
   * A copy or a cut is a trusted keystroke in the browser the *user* is in — the
   * mirrored page never receives one, so the pane cannot let the page do the
   * copying. The selection, however, lives in the mirrored page, and this is what
   * asks it for the text.
   *
   * The focused control's own selection comes first: in a text field the
   * document selection is usually collapsed, and the field's range is what a
   * copy would take there.
   * @returns the selected text, empty when nothing is selected.
   */
  async selectionText(): Promise<string> {
    await this.ensure()
    const text = await this.evaluateIn(this.cdpSession(), `(() => {
      const active = document.activeElement
      if (active !== null && typeof active.selectionStart === 'number'
        && active.selectionStart !== active.selectionEnd) {
        return String(active.value).slice(active.selectionStart, active.selectionEnd)
      }
      return window.getSelection()?.toString() ?? ''
    })()`)
    return typeof text === 'string' ? text : ''
  }

  /** Stop the browser and release its port and temporary profile. */
  async close(): Promise<void> {
    this.closing = true
    try {
      await this.closeStream()
      const session = this.session
      this.session = undefined
      this.page = undefined
      this.cdp = undefined
      this.launchedHeadless = undefined
      this.reason = undefined
      this.setState('closed')
      if (session !== undefined) await session.context.close().catch(() => {})
    } finally {
      this.closing = false
    }
    this.releasePort()
    await this.removeTemporaryProfile()
  }

  /**
   * Stop the browser because the user asked, and keep it stopped.
   *
   * The pane's own close control lands here rather than on {@link close},
   * because the two differ in what happens next: this one makes the close stand
   * until something genuinely needs a browser, so a viewer that comes back finds
   * a stopped browser instead of a fresh blank page.
   * @returns after the browser has stopped.
   */
  async stop(): Promise<void> {
    this.userClosed = true
    await this.close()
  }

  /** Start the browser, attach to its first page, and open the startup address. */
  private async start(): Promise<void> {
    this.setState('starting')
    try {
      this.port = await this.ports.allocate()
      const userDataDir = this.config.userDataDir === ''
        ? await mkdtemp(join(tmpdir(), 'dsh-browser-'))
        : profileDirFor(this.config.userDataDir, this.sessionId)
      if (this.config.userDataDir === '') this.temporaryProfile = userDataDir
      const launchConfig: LaunchConfig = { ...this.config, debugPort: this.port }
      const session = await this.launch(launchConfig, userDataDir)
      this.session = session
      this.launchedHeadless = this.config.headless
      this.observe(session.context)
      const page = session.context.pages()[0] ?? await session.context.newPage()
      // Attached before the first request: a headless build spells its user
      // agent `HeadlessChrome/…`, which no real install ever sends.
      await this.adopt(page)
      if (this.config.startupUrl !== '' && this.config.startupUrl !== 'about:blank') {
        await page.goto(this.config.startupUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      }
      this.reason = undefined
      this.setState('ready')
      // A viewer that stayed subscribed while this browser was being replaced
      // is still watching, and the screen cast died with the old browser: it
      // belongs to the CDP session that just went away. Nothing else re-attaches
      // it — a viewer only starts one when it arrives — so a pane that was open
      // across a restart or a crash would sit on its last frame forever.
      const mirror = await until(this.openStream(), START_MIRROR_MS)
      if (!mirror.settled) {
        this.logger.warn(new Error(
          `dsh-browser: session ${this.sessionId}'s page did not answer the mirror request; `
          + 'the browser is ready without it',
        ))
      }
      this.logger.info(
        `dsh-browser: session ${this.sessionId} is on ${page.url()}`
        + ` — CDP on 127.0.0.1:${String(this.port)} (${session.version})`,
      )
    } catch (error) {
      // Release whatever started before the failure, then keep the reason: the
      // close path resets state, and the failure must outlive it.
      const reason = error instanceof Error ? error.message : String(error)
      await this.close()
      this.reason = reason
      this.setState('failed')
      throw error
    }
  }

  /**
   * Follow the browser's own lifecycle: a context that closes without being
   * asked to, and pages it opens on its own.
   *
   * The mirror follows the newest page, which is what a person would see: a
   * link that opens a tab puts that tab in front, and the tools act on what is
   * in front rather than on a page that scrolled away behind it.
   * @param context - the launched browser's context.
   */
  private observe(context: BrowserContext): void {
    context.on('close', () => {
      // The close this class asked for is not a death; the process is going
      // away because the session is, and the reason belongs to nobody.
      if (this.closing) return
      this.logger.warn(new Error(`dsh-browser: session ${this.sessionId} lost its browser: ${DIED_REASON}`))
      this.forget()
      this.reason = DIED_REASON
      this.setState('closed')
    })
    context.on('page', (page) => {
      this.logger.info(`dsh-browser: session ${this.sessionId} opened a new tab`)
      void this.adopt(page).catch((error: unknown) => {
        this.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * Make one page the page tools and the mirror act on.
   *
   * A page carries its own CDP session, so following one means attaching to it
   * and restarting the mirror from the new attachment; the old attachment is
   * detached afterwards, once nothing is reading it.
   * @param page - the page to adopt.
   */
  private async adopt(page: Page): Promise<void> {
    const previous = this.cdp
    this.page = page
    // A ref names a DOM node on one page; the next page may have neither the
    // node nor the same ones, so nothing from the last page's refs survives —
    // and the labels do not start over, so the ones just forgotten cannot be
    // taken for the new page's own.
    this.labels.forgetPage()
    page.on('framenavigated', (frame) => {
      this.labels.forgetPage()
      // A new document has its own console: keeping the old one would report the
      // previous page's failures as if this one had made them. Only the main
      // frame counts — a page that embeds an iframe which navigates on its own
      // has not replaced the document the caller is reading.
      if (frame === page.mainFrame()) this.forgetSaid()
      this.publish()
    })
    // Every page gets this, not only the one the tools act on: a popup that
    // asks its question is still a question the model asked for by clicking.
    page.on('dialog', (dialog) => { this.answerDialog(dialog) })
    page.on('close', () => {
      if (this.page !== page) { this.publish(); return }
      void this.moveToSurvivingPage()
    })
    const cdp = await this.session?.context.newCDPSession(page)
    if (cdp === undefined) return
    this.viewport = undefined
    this.cdp = cdp
    await this.listenToConsole(cdp)
    if (this.config.stealth) await hideHeadlessUserAgent(cdp, page)
    if (this.stream !== undefined) {
      await this.closeStream()
      await this.openStream()
    }
    if (previous !== undefined && previous !== cdp) await previous.detach().catch(() => {})
    this.publish()
  }

  /** Move the mirror to a page that still exists after the active one closed. */
  private async moveToSurvivingPage(): Promise<void> {
    const context = this.session?.context
    if (context === undefined) return
    try {
      const survivor = context.pages()[0] ?? await context.newPage()
      await this.adopt(survivor)
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Attach the screencast for the current viewers, starting the browser if needed. */
  private async openStreamForViewers(): Promise<void> {
    // A viewer arriving is not a request for a browser: the pane that
    // re-subscribes here shows the closed state, with the restart control it
    // already draws for one. Measured on 2026-09-24: a viewer that re-subscribed
    // after the pane's own close button started a browser nobody asked for.
    if (this.userClosed) return
    try {
      await this.ensure()
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // Viewers may have left while the browser was starting.
    await this.openStream()
  }

  /** Attach the screencast to the active page's CDP session. */
  private async openStream(): Promise<void> {
    if (this.viewers.size === 0 || this.stream !== undefined || this.cdp === undefined) return
    this.stream = await startScreencast(
      this.cdp,
      {
        quality: this.config.quality,
        maxWidth: this.config.maxWidth,
        maxHeight: this.config.maxHeight,
        everyNthFrame: this.config.everyNthFrame,
      },
      frame => { for (const viewer of this.viewers) viewer(frame) },
      (error: unknown) => {
        // A refused acknowledgement is the one failure that silently ends the
        // stream; nothing else observes it, so it is reported here.
        this.logger.warn(error instanceof Error ? error : new Error(String(error)))
      },
    )
  }

  /** Detach the screencast. */
  private async closeStream(): Promise<void> {
    const stop = this.stream
    this.stream = undefined
    if (stop !== undefined) await stop().catch(() => {})
  }

  /** Drop everything the dead browser owned, keeping the viewers subscribed. */
  private forget(): void {
    void this.closeStream()
    this.session = undefined
    this.page = undefined
    this.cdp = undefined
    this.launchedHeadless = undefined
    this.releasePort()
    void this.removeTemporaryProfile()
  }

  /** Give the CDP port back, so a later browser may take it. */
  private releasePort(): void {
    if (this.port !== undefined) this.ports.release(this.port)
    this.port = undefined
  }

  /** Remove a temporary profile; a configured one is the user's to keep. */
  private async removeTemporaryProfile(): Promise<void> {
    const profile = this.temporaryProfile
    this.temporaryProfile = undefined
    if (profile === undefined) return
    // A profile directory can stay locked for a moment after the process
    // exits, and a leftover directory in the OS temp area is not a failure.
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }

  /** The CDP session, or a failure naming the browser state. */
  private cdpSession(): CDPSession {
    if (this.cdp === undefined) throw new Error(this.unusable())
    return this.cdp
  }

  /** The active page, or a failure naming the browser state. */
  private requirePage(): Page {
    if (this.page === undefined) throw new Error(this.unusable())
    return this.page
  }

  /** Why there is nothing to act on, naming the state and its cause. */
  private unusable(): string {
    return `dsh-browser: session ${this.sessionId}'s browser is ${this.state}`
      + `${this.reason === undefined ? '' : ` (${this.reason})`}`
  }

  /** Record a state change and tell the watchers. */
  private setState(state: BrowserState): void {
    this.state = state
    this.publish()
  }

  /** Tell the watchers the status moved. */
  private publish(): void {
    const status = this.status()
    for (const watcher of this.watchers) watcher(status)
  }
}
