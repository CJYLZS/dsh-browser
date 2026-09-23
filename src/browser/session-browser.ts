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
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import type { BrowserConfig } from '../config.ts'
import type { BrowserSession } from './launch.ts'
import { centerOfQuad, formatAxTree, type AxNode, type AxSnapshot } from './aria.ts'
import { PortAllocator } from './ports.ts'
import { profileDirFor } from './profile.ts'
import { startScreencast, type MirrorFrame } from './screencast.ts'
import { dispatchInput, scaleToViewport, type InputMessage } from './input.ts'

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
export type Launcher = (config: BrowserConfig, userDataDir: string) => Promise<BrowserSession>

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

/** Fields a running browser was launched from; changing one requires a new browser. */
const LAUNCH_FIELDS = [
  'channel', 'executablePath', 'headless', 'userDataDir', 'debugPort',
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

/** One captured page image. */
export interface Screenshot {
  /** Encoded JPEG bytes. */
  readonly jpeg: Buffer
  /** Page width at capture time, in CSS pixels. */
  readonly width: number
  /** Page height at capture time, in CSS pixels. */
  readonly height: number
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
  /** Refs the latest snapshot handed out, by label, for the next click or type. */
  private refs: ReadonlyMap<string, number> = new Map()
  /** Set while this class itself is closing the browser, so it is not a death. */
  private closing = false

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
   * Open an address in the active page.
   * @param url - absolute address to load.
   * @returns the address actually landed on.
   */
  async navigate(url: string): Promise<string> {
    await this.ensure()
    const page = this.requirePage()
    this.viewport = undefined
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.publish()
    return page.url()
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
   * Capture the active page.
   * @returns the encoded image and the page size it was taken at.
   */
  async screenshot(): Promise<Screenshot> {
    await this.ensure()
    const cdp = this.cdpSession()
    const captured = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: this.config.quality,
    }) as { data: string }
    const metrics = await cdp.send('Page.getLayoutMetrics') as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
    }
    return {
      jpeg: Buffer.from(captured.data, 'base64'),
      width: metrics.cssVisualViewport?.clientWidth ?? 0,
      height: metrics.cssVisualViewport?.clientHeight ?? 0,
    }
  }

  /**
   * Evaluate an expression in the active page and return its value.
   * @param expression - JavaScript source evaluated as an expression.
   * @returns the value, decoded when it is JSON-representable.
   * @throws {Error} when the page throws or the value cannot be decoded.
   */
  async evaluate(expression: string): Promise<unknown> {
    await this.ensure()
    return await this.evaluateIn(this.cdpSession(), expression)
  }

  /**
   * Read the active page as an accessibility tree.
   *
   * The refs it returns replace whatever the last snapshot handed out: a ref
   * names a DOM node, and a page that changed may have moved or removed it.
   * @returns the tree as text, with the refs it used.
   */
  async snapshot(): Promise<AxSnapshot> {
    await this.ensure()
    const tree = await this.cdpSession().send('Accessibility.getFullAXTree') as { nodes?: readonly AxNode[] }
    const snapshot = formatAxTree(tree.nodes ?? [], { maxNodes: this.config.snapshotNodes })
    this.refs = snapshot.refs
    return snapshot
  }

  /**
   * Click the element a ref names, with real mouse events.
   *
   * The events are dispatched through the same input channel a viewer's clicks
   * use, which is what makes them trusted: a site that ignores a synthetic
   * `element.click()` accepts these.
   * @param ref - a ref from the latest snapshot.
   * @throws {Error} when the ref is unknown, or the element has nothing to click.
   */
  async click(ref: string): Promise<void> {
    await this.ensure()
    const cdp = this.cdpSession()
    const { x, y } = await this.pointOf(cdp, ref)
    await dispatchInput(cdp, { type: 'mouse', action: 'move', x, y })
    await dispatchInput(cdp, { type: 'mouse', action: 'down', x, y })
    await dispatchInput(cdp, { type: 'mouse', action: 'up', x, y })
  }

  /**
   * Type into the element a ref names.
   *
   * Text arrives through `Input.insertText`, so it is inserted as characters
   * rather than replayed as keystrokes — which is what makes non-Latin input
   * work. A key is pressed afterwards for fields whose meaning is the Enter
   * that follows.
   * @param ref - a ref from the latest snapshot.
   * @param value - the text to insert.
   * @param options - whether to replace the current content, and a key to press after.
   * @throws {Error} when the ref is unknown.
   */
  async type(ref: string, value: string, options: { clear?: boolean; key?: string } = {}): Promise<void> {
    await this.ensure()
    const cdp = this.cdpSession()
    const backendNodeId = this.nodeFor(ref)
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
    await cdp.send('DOM.focus', { backendNodeId })
    if (options.clear !== false) {
      // Selection is the one part of this that is not a trusted event: what
      // follows is the insertion, which is.
      await this.evaluateIn(cdp, 'globalThis.document.activeElement?.select?.()').catch(() => {})
    }
    if (value !== '') await dispatchInput(cdp, { type: 'text', text: value })
    if (options.key !== undefined) await dispatchInput(cdp, { type: 'key', key: options.key })
  }

  /**
   * Where a ref's element is, in the coordinates CDP dispatches input in.
   * @param cdp - session attached to the active page.
   * @param ref - a ref from the latest snapshot.
   * @returns the centre of the element's first content quad, in viewport pixels.
   * @throws {Error} when the ref is unknown or the element is not rendered.
   */
  private async pointOf(cdp: CDPSession, ref: string): Promise<{ x: number; y: number }> {
    const backendNodeId = this.nodeFor(ref)
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
    const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId }) as { quads?: number[][] }
    const quad = quads?.[0]
    if (quad === undefined) {
      throw new Error(`dsh-browser: ${ref} has no visible box in the page; take a new snapshot and try again`)
    }
    // Content quads are in page coordinates, which include the scroll offset;
    // input is dispatched in viewport coordinates.
    const metrics = await cdp.send('Page.getLayoutMetrics') as {
      cssLayoutViewport?: { pageX?: number; pageY?: number }
    }
    const centre = centerOfQuad(quad)
    return {
      x: centre.x - (metrics.cssLayoutViewport?.pageX ?? 0),
      y: centre.y - (metrics.cssLayoutViewport?.pageY ?? 0),
    }
  }

  /**
   * The DOM node a ref names.
   * @param ref - a ref from the latest snapshot.
   * @returns the backend node id.
   * @throws {Error} when no snapshot on this page handed out that ref.
   */
  private nodeFor(ref: string): number {
    const backendNodeId = this.refs.get(ref)
    if (backendNodeId === undefined) {
      throw new Error(
        `dsh-browser: ${ref} is not a ref from a snapshot of the current page; `
        + 'call browser_snapshot and use a ref from its result',
      )
    }
    return backendNodeId
  }

  /**
   * Evaluate an expression over one CDP session.
   * @param cdp - session to evaluate on.
   * @param expression - JavaScript source evaluated as an expression.
   * @returns the value, decoded when it is JSON-representable.
   * @throws {Error} when the page throws.
   */
  private async evaluateIn(cdp: CDPSession, expression: string): Promise<unknown> {
    const outcome = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as {
      result?: { value?: unknown; unserializableValue?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (outcome.exceptionDetails !== undefined) {
      const detail = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? 'evaluation failed'
      throw new Error(detail)
    }
    return outcome.result?.value ?? outcome.result?.unserializableValue
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

  /** Start the browser, attach to its first page, and open the startup address. */
  private async start(): Promise<void> {
    this.setState('starting')
    try {
      this.port = await this.ports.allocate()
      const userDataDir = this.config.userDataDir === ''
        ? await mkdtemp(join(tmpdir(), 'dsh-browser-'))
        : profileDirFor(this.config.userDataDir, this.sessionId)
      if (this.config.userDataDir === '') this.temporaryProfile = userDataDir
      const session = await this.launch({ ...this.config, debugPort: this.port }, userDataDir)
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
      this.logger.info(
        `dsh-browser: session ${this.sessionId} is on ${await page.title().catch(() => '') || page.url()}`
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
    // node nor the same ones, so nothing from the last snapshot survives.
    this.refs = new Map()
    page.on('framenavigated', () => {
      this.refs = new Map()
      this.publish()
    })
    page.on('close', () => {
      if (this.page !== page) { this.publish(); return }
      void this.moveToSurvivingPage()
    })
    const cdp = await this.session?.context.newCDPSession(page)
    if (cdp === undefined) return
    this.viewport = undefined
    this.cdp = cdp
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
