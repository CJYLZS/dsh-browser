/**
 * The browsers this plugin runs, one per session.
 *
 * Isolation is the whole point: a conversation's tools, and the tab the user
 * watches it through, all address the browser belonging to that conversation's
 * session, and nothing else can reach it. The pool is what enforces that — it
 * is the only place a session browser is created, found, or thrown away.
 *
 * Browsers are created on first use and live until their session is disposed,
 * the user closes one deliberately, or the plugin unloads. That is deliberate:
 * a browser kept alive between tool calls is what makes a conversation feel
 * like it has a browser rather than a series of page loads.
 */
import type { BrowserConfig } from '../config.ts'
import { launchBrowser } from './launch.ts'
import { PortAllocator, portWindow, type PortProbe } from './ports.ts'
import { SessionBrowser, type BrowserStatus, type Launcher, type Logger } from './session-browser.ts'

/** What the plugin, its tools, and its settings page can see about the browsers. */
export interface PoolStatus {
  /** How many session browsers may run at once. */
  readonly maxInstances: number
  /** Every browser that exists, whether or not it has started. */
  readonly instances: readonly BrowserStatus[]
}

/**
 * Owns one {@link SessionBrowser} per session.
 */
export class BrowserPool {
  private readonly entries = new Map<string, SessionBrowser>()
  private readonly allocator: PortAllocator
  private readonly launch: Launcher
  private readonly logger: Logger
  private config: BrowserConfig

  /**
   * @param config - resolved plugin configuration.
   * @param logger - where launch outcomes are reported.
   * @param launch - starts a browser; replaced in tests.
   * @param probe - port availability test; replaced in tests.
   */
  constructor(config: BrowserConfig, logger: Logger, launch: Launcher = launchBrowser, probe?: PortProbe) {
    this.config = config
    this.logger = logger
    this.launch = launch
    this.allocator = new PortAllocator(portWindow(config.debugPortMin, config.debugPortMax), [], probe)
  }

  /** How many browsers exist. */
  get size(): number {
    return this.entries.size
  }

  /**
   * The browser belonging to a session, creating it if this is the first use.
   * @param sessionId - the session whose browser is wanted.
   * @returns the session's browser, not yet started.
   * @throws {Error} when the session id cannot name a profile directory, or when
   * the instance limit is already reached.
   */
  get(sessionId: string): SessionBrowser {
    if (sessionId === '') {
      throw new Error('dsh-browser: a browser cannot belong to an empty session id')
    }
    const existing = this.entries.get(sessionId)
    if (existing !== undefined) return existing
    if (this.entries.size >= this.config.maxInstances) {
      throw new Error(
        `dsh-browser: ${String(this.config.maxInstances)} session browsers are already running (maxInstances); `
        + 'close one from its Sidebar tab, or raise maxInstances',
      )
    }
    const created = new SessionBrowser(sessionId, {
      config: this.config,
      ports: this.allocator,
      launch: this.launch,
      logger: this.logger,
    })
    this.entries.set(sessionId, created)
    return created
  }

  /**
   * The browser belonging to a session, without creating one.
   * @param sessionId - the session whose browser is wanted.
   * @returns the browser, or `undefined` when this session has none.
   */
  peek(sessionId: string): SessionBrowser | undefined {
    return this.entries.get(sessionId)
  }

  /** Everything running, for the settings page and diagnostics. */
  status(): PoolStatus {
    return {
      maxInstances: this.config.maxInstances,
      instances: [...this.entries.values()].map(instance => instance.status()),
    }
  }

  /**
   * Adopt a new configuration, for the browsers that already exist and for
   * every one created afterwards.
   * @param next - the newly resolved configuration.
   * @returns after every live browser has been restarted, where one had to be.
   */
  async reconfigure(next: BrowserConfig): Promise<void> {
    this.config = next
    // A moved window only changes where the *next* browser may listen; the
    // browsers already running keep the ports the allocator is still holding for
    // them, which is why this is not a launch field.
    this.allocator.setWindow(portWindow(next.debugPortMin, next.debugPortMax))
    await Promise.all([...this.entries.values()].map(async instance => { await instance.reconfigure(next) }))
  }

  /**
   * Close one session's browser and forget it.
   *
   * Its port and temporary profile are released with it, so the next session to
   * start may reuse them.
   * @param sessionId - the session whose browser is going away.
   */
  async dispose(sessionId: string): Promise<void> {
    const instance = this.entries.get(sessionId)
    if (instance === undefined) return
    this.entries.delete(sessionId)
    await instance.close()
  }

  /** Close every browser, for plugin unload. */
  async closeAll(): Promise<void> {
    const instances = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(instances.map(async instance => { await instance.close() }))
  }
}
