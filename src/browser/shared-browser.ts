/**
 * One browser process, however many conversations are using it.
 *
 * Before this class existed, "a browser" and "a conversation" were the same
 * thing: one `SessionBrowser` owned one process and one profile, and disposing
 * the session closed it. That is still what `session` and `temp` profile modes
 * do — the pool hands each of them a browser of their own — but `workspace` mode
 * puts every conversation of one project on a single process, because the point
 * of the mode is that a site signed into in one of them is signed into in all.
 *
 * What that forces is a split:
 *
 * - **This class is the process half**: the context, the CDP port, the profile,
 *   the lifecycle state, the page registry (target ids and titles), the mirrors
 *   keyed by target id, and which conversation owns which page.
 * - **`SessionBrowser` is the conversation half**: the page its tools act on,
 *   the refs its snapshots handed out, its viewport cache, and the dialogs it is
 *   waiting on. Each conversation has one of those, and several of them point at
 *   one of these.
 *
 * The split is visible in the field names: a process-level value is a member
 * here and a `this.host.…` read there, while a conversation-level value stayed
 * exactly where it was.
 *
 * The reference count is of *conversations*, not pages. Releasing the last one
 * closes the process; the pages of the ones that remain are not touched, because
 * they belong to conversations that are still using them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import type { BrowserConfig } from '../config.ts'
import type { BrowserSession, LaunchConfig } from './launch.ts'
import { PortAllocator } from './ports.ts'
import { profileDirForUnit, type ProfileUnit } from './profile-choice.ts'
import type { MirrorFrame } from './screencast.ts'

/** Lifecycle of one browser process as its conversations see it. */
export type BrowserState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed'

/** Starts a browser; the seam that keeps this class testable without one. */
export type Launcher = (config: LaunchConfig, userDataDir: string) => Promise<BrowserSession>

/** The logging this class needs, satisfied by a cordis logger. */
export interface Logger {
  /** Record something that happened. */
  info(message: string): void
  /** Record something that went wrong. */
  warn(error: Error): void
}

/** One page's mirror: its screen cast, and everyone watching it. */
export interface PageMirror {
  /** The CDP session this mirror attached itself — never a view's own. */
  cdp: CDPSession
  /** Stops the screen cast. */
  stop: () => Promise<void>
  /** Everyone watching this page; frames go to each of them. */
  readonly viewers: Set<(frame: MirrorFrame) => void>
}

/** What a browser process is built from. */
export interface SharedBrowserDeps {
  /** Configuration the browser launches with. */
  readonly config: BrowserConfig
  /** Owner of the CDP port this browser listens on. */
  readonly ports: PortAllocator
  /** Starts the process. */
  readonly launch: Launcher
  /** Where launch outcomes are reported. */
  readonly logger: Logger
  /**
   * The identity this process serves, taken once when it was created.
   *
   * Held rather than re-derived because a process outlives the conversation that
   * created it: a `workspace` browser keeps serving the others after its creator
   * leaves, so asking the registry about that creator again would fail exactly
   * then (measured 2026-11-03). The *directory* is still resolved per start —
   * from this unit and the configuration then in force — so a settings change
   * reaches the next browser.
   */
  readonly unit: ProfileUnit
}

/**
 * How long the mirror is given to attach before the browser is reported ready.
 *
 * The mirror is a view of the browser, not the browser: a page that will not
 * answer `Page.startScreencast` — a wedged renderer — must not hold up every
 * later call, because a start in flight is a start every caller joins.
 */
export const START_MIRROR_MS = 5_000

/** What a browser that vanished without being asked to is reported as. */
export const DIED_REASON = 'the browser was closed or crashed'

/**
 * Wait for a promise, but only until a deadline.
 *
 * A rejection counts as settled — a browser that refused is a browser that
 * answered — and the abandoned promise's failure is swallowed here rather than
 * surfacing as an unhandled rejection.
 * @param work - the promise to wait for.
 * @param ms - how long it is given.
 * @returns whether it settled in time, and what it produced.
 */
export async function until<T>(work: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(value => ({ settled: true, value }), () => ({ settled: true })),
      new Promise<{ settled: boolean; value?: T }>(done => {
        timer = setTimeout(() => { done({ settled: false }) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** What one conversation needs to hear from the browser that serves it. */
export interface SessionParticipant {
  /** The conversation this participant speaks for. */
  readonly sessionId: string
  /** The process started, or its state changed. */
  hostChanged(): void
  /** The process went away; `reason` says why. */
  hostGone(reason: string): void
  /**
   * A page the browser opened while this conversation was acting.
   * @param page - the new page, before anything has adopted it.
   */
  hostPage(page: Page): void
}

/** The fields the running browser was launched from. */
const LAUNCH_FIELDS = [
  'channel', 'executablePath', 'headless', 'userDataDir', 'profileMode',
  'viewportWidth', 'viewportHeight', 'startupUrl', 'stealth',
] as const

/**
 * One browser process, shared by every conversation the pool keyed to it.
 *
 * The process-level members are deliberately reachable: `SessionBrowser` is the
 * conversation half and reads and writes them for the one process it serves, and
 * a getter/setter pair for each would be indirection with nothing behind it.
 */
export class SharedBrowser {
  /** The pool key this browser answers to: a session id, or a workspace id. */
  readonly key: string
  /** The context, once a browser is running. */
  session: BrowserSession | undefined
  /** The external CDP port the running browser listens on. */
  port: number | undefined
  /** Whether the running browser has a window. */
  launchedHeadless: boolean | undefined
  /** The profile directory, when this class created a temporary one to remove. */
  temporaryProfile: string | undefined
  /** The lifecycle state every conversation on this browser shares. */
  state: BrowserState = 'idle'
  /** Why the browser is unusable, when it is. */
  reason: string | undefined
  /** Set while this class itself is closing the browser, so it is not a death. */
  closing = false
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
  userClosed = false
  /** The browser-level CDP session `Target.getTargets` is asked on, kept for the browser's life. */
  browserCdp: CDPSession | undefined
  /** Pages this browser holds, by their CDP target id. */
  readonly pageIds = new Map<Page, string>()
  /** What each page last said its title was, by target id. */
  readonly titles = new Map<string, string>()
  /** Which conversation owns each page, by target id. */
  readonly owners = new Map<string, string>()
  /** One mirror per page someone is watching, by target id. */
  readonly mirrors = new Map<string, PageMirror>()
  /** The conversations using this browser, by session id. */
  readonly participants = new Map<string, SessionParticipant>()
  /** How many conversations are using this browser. */
  private starting: Promise<void> | undefined
  private readonly ports: PortAllocator
  private readonly launch: Launcher
  private readonly logger: Logger
  private config: BrowserConfig
  /** The configuration the running browser was actually started from. */
  private launchConfigAtStart: BrowserConfig | undefined
  /**
   * The identity this process serves, taken when it was created.
   *
   * Held rather than re-derived because a process outlives the conversation that
   * created it: a `workspace` browser keeps serving the others after its creator
   * leaves, so asking the registry about that creator again would fail exactly
   * then (measured 2026-11-03). The directory is still resolved per start, from
   * this unit and the configuration then in force, so a settings change reaches
   * the next browser.
   */
  readonly unit: ProfileUnit
  /**
   * The profile directory the running browser opened, for diagnostics only.
   *
   * Where the *next* browser goes is derived from {@link unit} and the
   * configuration in force at that moment — never read from here. Holding the
   * answer in this field is what made a stopped-and-restarted browser open a
   * fresh temporary profile and lose every sign-in, because closing the process
   * cleared it (2026-11-03).
   */
  profileDir: string | undefined
  /** The conversations acting right now, so a page they opened is theirs. */
  private readonly acting = new Set<string>()

  /**
   * @param key - the pool key this browser answers to.
   * @param deps - configuration, port owner, launcher, logger, and the unit this
   *   process serves.
   */
  constructor(key: string, deps: SharedBrowserDeps) {
    this.key = key
    this.config = deps.config
    this.ports = deps.ports
    this.launch = deps.launch
    this.logger = deps.logger
    this.unit = deps.unit
  }

  /** How many conversations are using this browser. */
  get refCount(): number {
    return this.participants.size
  }

  /** The configuration in force. */
  get activeConfig(): BrowserConfig {
    return this.config
  }

  /** Whether anyone is using this browser. */
  get used(): boolean {
    return this.participants.size > 0
  }

  /** The browser's context, once one is running. */
  get context(): BrowserContext | undefined {
    return this.session?.context
  }

  /** The browser's own version string, once it has answered. */
  get version(): string | undefined {
    return this.session?.version
  }

  /**
   * Start serving one conversation.
   * @param participant - the conversation joining.
   */
  join(participant: SessionParticipant): void {
    this.participants.set(participant.sessionId, participant)
  }

  /** Whether a conversation is still on this browser. */
  has(sessionId: string): boolean {
    return this.participants.has(sessionId)
  }

  /**
   * Mark a conversation as acting, so pages it opens are its own.
   *
   * The protocol cannot say who opened a page: `Target.getTargets` carries no
   * "who", and `openerId` exists only for the `window.open` path. What is
   * attributable is the *action* — a click or a script that ran in one
   * conversation's call — so a page that appears while exactly one conversation
   * is acting is that conversation's, and one that appears while none is belongs
   * to nobody.
   * @param sessionId - the conversation whose call is running.
   */
  beginAction(sessionId: string): void {
    this.acting.add(sessionId)
  }

  /**
   * Mark a conversation as done acting.
   * @param sessionId - the conversation whose call finished.
   */
  endAction(sessionId: string): void {
    this.acting.delete(sessionId)
  }

  /** The conversation acting right now, when exactly one is. */
  private soleActor(): string | undefined {
    if (this.acting.size !== 1) return undefined
    for (const sessionId of this.acting) return sessionId
    return undefined
  }

  /**
   * Who a page the browser opened on its own belongs to.
   *
   * The action in flight wins, because it is the only fact the protocol lets us
   * attribute a `window.open` to. With no action running, a browser serving one
   * conversation is unambiguous — that conversation is the only one it could be
   * — while one serving several has no answer at all, and an unowned page is
   * better than a wrong owner.
   * @returns the session that owns the new page, or `undefined` when nobody can.
   */
  private pageOwner(): string | undefined {
    const actor = this.soleActor()
    if (actor !== undefined) return actor
    if (this.participants.size === 1) {
      for (const sessionId of this.participants.keys()) return sessionId
    }
    return undefined
  }

  /**
   * Stop serving one conversation, closing the browser if it was the last.
   *
   * This is where sharing becomes real: a conversation leaving takes its own
   * pages with it and leaves the process — and everyone else's pages — alone.
   * Only the last one out closes it.
   * @param sessionId - the conversation leaving.
   * @returns after the browser has been closed, when this was the last one.
   */
  async leave(sessionId: string): Promise<void> {
    if (!this.participants.delete(sessionId)) return
    if (this.participants.size > 0) return
    await this.close()
  }

  /**
   * Start the browser if it is not running, joining an in-flight start.
   *
   * A browser that died or failed is started again here, which is what makes any
   * later request — a tool call, a viewer reconnecting, the pane's restart —
   * recover without reloading the plugin.
   * @returns after the browser is ready.
   * @throws {Error} when the browser cannot start, including when the profile
   * mode needs a workspace and this deployment cannot resolve one.
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
    // Resolved here, per start, rather than remembered: the directory follows
    // the configuration in force now, and a remembered copy went stale on a
    // close, a crash, and a settings edit alike.
    const started = this.start(profileDirForUnit(this.config, this.unit))
    this.starting = started
    try {
      await started
    } finally {
      this.starting = undefined
    }
  }

  /** The pages the browser holds, in its own order. */
  pages(): Page[] {
    return this.session?.context.pages() ?? []
  }

  /** Start a new page, which Playwright announces the way it announces any. */
  async newPage(): Promise<Page | undefined> {
    const context = this.session?.context
    if (context === undefined) return undefined
    return await context.newPage()
  }

  /** A CDP session attached to one page. */
  async cdpFor(page: Page): Promise<CDPSession | undefined> {
    return await this.session?.context.newCDPSession(page)
  }

  /** The page that answers to a CDP target id, if the browser still holds it. */
  pageById(targetId: string): Page | undefined {
    for (const page of this.pages()) {
      if (this.pageIds.get(page) === targetId) return page
    }
    return undefined
  }

  /** The CDP target id of a page, when the browser has named it. */
  targetIdOf(page: Page): string | undefined {
    return this.pageIds.get(page)
  }

  /** Whether a conversation owns a page. */
  owns(sessionId: string, targetId: string): boolean {
    return this.owners.get(targetId) === sessionId
  }

  /** The conversation that owns a page, when one does. */
  ownerOf(targetId: string): string | undefined {
    return this.owners.get(targetId)
  }

  /**
   * Remember a page's identity, from the one call that answers it.
   * @param page - the page being named.
   * @param targetId - its CDP target id.
   * @param title - the title the target list reported, when it reported one.
   */
  remember(page: Page, targetId: string, title: string | undefined): void {
    this.pageIds.set(page, targetId)
    if (title !== undefined) this.titles.set(targetId, title)
  }

  /** The target ids one conversation owns. */
  ownedBy(sessionId: string): string[] {
    return [...this.owners].filter(([, owner]) => owner === sessionId).map(([targetId]) => targetId)
  }

  /**
   * Record that a conversation owns a page.
   * @param sessionId - the owner.
   * @param targetId - the page.
   */
  claim(sessionId: string, targetId: string): void {
    this.owners.set(targetId, sessionId)
  }

  /**
   * Drop every trace of a page that is gone.
   * @param page - the page.
   * @returns its target id, when it had one.
   */
  forgetPage(page: Page): string | undefined {
    const targetId = this.pageIds.get(page)
    this.pageIds.delete(page)
    if (targetId !== undefined) {
      this.titles.delete(targetId)
      this.owners.delete(targetId)
      this.dropMirror(targetId)
    }
    return targetId
  }

  /**
   * Every page's current title, from one browser-level `Target.getTargets`.
   * @param budgetMs - how long the browser is given to answer.
   * @returns titles by target id; empty when the list cannot be asked.
   */
  async targetTitles(budgetMs: number): Promise<Map<string, string>> {
    const browser = this.session?.context.browser()
    if (browser === null || browser === undefined) return new Map()
    try {
      if (this.browserCdp === undefined) this.browserCdp = await browser.newBrowserCDPSession()
      const answer = await until(this.browserCdp.send('Target.getTargets'), budgetMs) as {
        settled: boolean
        value?: { targetInfos?: { targetId?: unknown; type?: unknown; title?: unknown }[] }
      }
      const titles = new Map<string, string>()
      if (!answer.settled) return titles
      for (const info of answer.value?.targetInfos ?? []) {
        if (info.type !== 'page') continue
        if (typeof info.targetId === 'string' && typeof info.title === 'string') {
          titles.set(info.targetId, info.title)
        }
      }
      return titles
    } catch {
      // A browser that refuses the list is one the memory answers for.
      return new Map()
    }
  }

  /** Drop one page's mirror without ceremony: the page it watched is gone. */
  dropMirror(targetId: string | undefined): void {
    if (targetId === undefined) return
    const mirror = this.mirrors.get(targetId)
    if (mirror === undefined) return
    this.mirrors.delete(targetId)
    void mirror.stop().catch(() => {})
  }

  /**
   * Adopt a new configuration.
   *
   * A field the running browser was launched from closes it: viewers keep their
   * subscription, and the next frame request starts a browser built from the new
   * values. Frames are restarted in place, since only the stream's own encoding
   * changed — that half belongs to the conversations, which re-attach their own
   * mirrors.
   * @param next - the newly resolved configuration.
   * @returns whether the browser was closed, which the caller must replace.
   */
  async reconfigure(next: BrowserConfig): Promise<boolean> {
    this.config = next
    if (this.state !== 'ready' && this.state !== 'starting') return false
    if (!this.launchFieldsChanged(next)) return false
    this.logger.info('dsh-browser: launch configuration changed; restarting the browser')
    await this.close()
    return true
  }

  /** Whether the values the running browser was launched from still hold. */
  private launchFieldsChanged(next: BrowserConfig): boolean {
    const was = this.launchConfigAtStart
    if (was === undefined) return false
    return LAUNCH_FIELDS.some(field => was[field] !== next[field])
      || was.extraArgs.join('\u0000') !== next.extraArgs.join('\u0000')
  }

  /**
   * Stop the browser because the user asked, and keep it stopped.
   * @returns after the browser has stopped.
   */
  async stop(): Promise<void> {
    this.userClosed = true
    await this.close()
  }

  /**
   * Stop the browser and release its port and temporary profile.
   *
   * Every participant is told the browser is gone, because every one of them
   * just lost its pages: the process is the shared thing, and there is no
   * version of closing it that spares one conversation.
   * @returns after the browser has stopped.
   */
  async close(): Promise<void> {
    this.closing = true
    try {
      for (const targetId of [...this.mirrors.keys()]) this.dropMirror(targetId)
      this.pageIds.clear()
      this.titles.clear()
      this.owners.clear()
      void this.browserCdp?.detach().catch(() => {})
      this.browserCdp = undefined
      const session = this.session
      this.session = undefined
      this.launchedHeadless = undefined
      this.launchConfigAtStart = undefined
      // The directory the browser opened is not the answer for the next one:
      // each launch resolves its own, from the configuration in force then.
      this.profileDir = undefined
      this.reason = undefined
      this.setState('closed')
      // Every conversation just lost the pages this process held, so each one
      // drops its own pointer and its own stream. A view that kept either would
      // act on a page whose process is gone.
      for (const participant of this.participants.values()) participant.hostGone('the browser was closed')
      if (session !== undefined) await session.context.close().catch(() => {})
    } finally {
      this.closing = false
    }
    this.releasePort()
    await this.removeTemporaryProfile()
  }

  /** Start the browser, attach to its first page, and open the startup address. */
  private async start(configuredProfile: string | undefined): Promise<void> {
    this.setState('starting')
    this.launchConfigAtStart = this.config
    this.profileDir = configuredProfile
    try {
      this.port = await this.ports.allocate()
      // A caller that resolved a directory owns it — a workspace's or a
      // session's — and it is not this class's to delete.
      const profile = configuredProfile ?? await mkdtemp(join(tmpdir(), 'dsh-browser-'))
      if (configuredProfile === undefined) this.temporaryProfile = profile
      const launchConfig: LaunchConfig = { ...this.config, debugPort: this.port }
      const session = await this.launch(launchConfig, profile)
      this.session = session
      this.launchedHeadless = this.config.headless
      this.observe(session.context)
      const page = session.context.pages()[0] ?? await session.context.newPage()
      this.reason = undefined
      this.setState('ready')
      this.logger.info(
        `dsh-browser: browser ${this.key} is on ${page.url()}`
        + ` — CDP on 127.0.0.1:${String(this.port)} (${session.version})`,
      )
      // A conversation that joined before the process existed has no page yet;
      // the first one to ask adopts the page the browser came up on.
      for (const participant of this.participants.values()) participant.hostChanged()
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
   * A page the browser opens belongs to the conversation that was acting when it
   * appeared; see {@link beginAction}. A page nobody was acting for is offered
   * to nobody, which is the honest answer for a page no conversation asked for.
   * @param context - the launched browser's context.
   */
  private observe(context: BrowserContext): void {
    context.on('close', () => {
      // The close this class asked for is not a death; the process is going
      // away because its last conversation is, and the reason belongs to nobody.
      if (this.closing) return
      this.logger.warn(new Error(`dsh-browser: browser ${this.key} was lost: ${DIED_REASON}`))
      this.forget()
      this.reason = DIED_REASON
      this.setState('closed')
    })
    context.on('page', (page) => {
      const owner = this.pageOwner()
      if (owner === undefined) return
      this.participants.get(owner)?.hostPage(page)
    })
  }

  /** Tell the participants the process is gone, and drop what died with it. */
  private forget(): void {
    for (const targetId of [...this.mirrors.keys()]) this.dropMirror(targetId)
    this.pageIds.clear()
    this.titles.clear()
    this.owners.clear()
    void this.browserCdp?.detach().catch(() => {})
    this.browserCdp = undefined
    this.session = undefined
    this.launchedHeadless = undefined
    this.launchConfigAtStart = undefined
    this.profileDir = undefined
    this.releasePort()
    void this.removeTemporaryProfile()
    for (const participant of this.participants.values()) participant.hostGone(DIED_REASON)
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

  /** Record a state change and tell every conversation on this browser. */
  setState(state: BrowserState): void {
    this.state = state
    for (const participant of this.participants.values()) participant.hostChanged()
  }
}
