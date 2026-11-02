/**
 * The browsers this plugin runs, one per *shared unit*.
 *
 * The unit used to be the session, and for the `temp` and `session` profile modes
 * it still is: a conversation's tools, and the tab the user watches it through,
 * address the browser belonging to that conversation, and nothing else can reach
 * it. The `workspace` mode widens the unit to the workspace — every conversation
 * in one project shares one process, one profile, and one CDP port — because the
 * point of that mode is a site signed into once being signed into everywhere in
 * the project.
 *
 * Either way this class enforces it: it is the only place a browser process is
 * created, found, or thrown away, and it is where a session is turned into the
 * key of the process that serves it.
 *
 * Browsers are created on first use and live until the last conversation using
 * them is disposed, the user closes one deliberately, or the plugin unloads.
 * That is deliberate: a browser kept alive between tool calls is what makes a
 * conversation feel like it has a browser rather than a series of page loads.
 */
import type { BrowserConfig } from '../config.ts'
import { launchBrowser } from './launch.ts'
import { PortAllocator, portWindow, type PortProbe } from './ports.ts'
import { chooseProfile, type WorkspaceLookup } from './profile-choice.ts'
import { workspaceOf } from './workspace.ts'
import { SessionBrowser, type BrowserStatus } from './session-browser.ts'
import { SharedBrowser, type Launcher, type Logger } from './shared-browser.ts'
import type { Context } from '@deepseek-ai/cordis'

/** What the plugin, its tools, and its settings page can see about the browsers. */
export interface PoolStatus {
  /** How many session browsers may run at once. */
  readonly maxInstances: number
  /**
   * Every browser that exists, reported once per conversation using it.
   *
   * The settings page lists conversations, not processes, so a shared browser
   * appears once for each session on it — each with the same `browserId`, which
   * is what tells the reader those rows are one process.
   */
  readonly instances: readonly BrowserStatus[]
}

/**
 * Owns one {@link SharedBrowser} per shared unit, and one
 * {@link SessionBrowser} per conversation.
 */
export class BrowserPool {
  private readonly hosts = new Map<string, SharedBrowser>()
  private readonly views = new Map<string, SessionBrowser>()
  private readonly allocator: PortAllocator
  private readonly launch: Launcher
  private readonly logger: Logger
  private config: BrowserConfig
  private readonly ctx: Context | undefined
  /** How a session is resolved to its workspace; the context's registry by default. */
  private readonly workspaceOfSession: WorkspaceLookup

  /**
   * @param config - resolved plugin configuration.
   * @param logger - where launch outcomes are reported.
   * @param launch - starts a browser; replaced in tests.
   * @param probe - port availability test; replaced in tests.
   * @param ctx - the plugin context, for the workspace registry when the profile
   *   mode needs one.
   * @param lookup - how to resolve a session's workspace; replaced in tests.
   */
  constructor(
    config: BrowserConfig,
    logger: Logger,
    launch: Launcher = launchBrowser,
    probe?: PortProbe,
    ctx?: Context,
    lookup?: WorkspaceLookup,
  ) {
    this.config = config
    this.logger = logger
    this.launch = launch
    this.ctx = ctx
    this.workspaceOfSession = lookup ?? (sessionId =>
      this.ctx === undefined ? undefined : workspaceOf(this.ctx, sessionId))
    this.allocator = new PortAllocator(portWindow(config.debugPortMin, config.debugPortMax), [], probe)
  }

  /** How many processes exist. */
  get size(): number {
    return this.hosts.size
  }

  /** How many conversations have a browser view. */
  get sessionCount(): number {
    return this.views.size
  }

  /**
   * The browser belonging to a session, creating it if this is the first use.
   *
   * The session's profile resolution decides which process serves it: on a
   * `workspace` deployment two conversations of one project get the same one and
   * the second gets a view of the first's browser rather than a process of its
   * own.
   * @param sessionId - the session whose browser is wanted.
   * @returns the session's view of its browser, not yet started.
   * @throws {Error} when the session id cannot name a profile directory, when
   * the workspace mode cannot resolve a workspace, or when the instance limit is
   * already reached.
   */
  get(sessionId: string): SessionBrowser {
    if (sessionId === '') {
      throw new Error('dsh-browser: a browser cannot belong to an empty session id')
    }
    const existing = this.views.get(sessionId)
    if (existing !== undefined) return existing
    const choice = chooseProfile(this.config, sessionId, this.workspaceOfSession)
    let host = this.hosts.get(choice.key)
    if (host === undefined) {
      if (this.hosts.size >= this.config.maxInstances) {
        throw new Error(
          `dsh-browser: ${String(this.config.maxInstances)} session browsers are already running (maxInstances); `
          + 'close one from its Sidebar tab, or raise maxInstances',
        )
      }
      host = new SharedBrowser(choice.key, {
        config: this.config,
        ports: this.allocator,
        launch: this.launch,
        logger: this.logger,
      })
      host.profileDir = choice.dir
      this.hosts.set(choice.key, host)
    }
    const view = new SessionBrowser(sessionId, { host, logger: this.logger })
    this.views.set(sessionId, view)
    return view
  }

  /**
   * The browser belonging to a session, without creating one.
   * @param sessionId - the session whose browser is wanted.
   * @returns the view, or `undefined` when this session has none.
   */
  peek(sessionId: string): SessionBrowser | undefined {
    return this.views.get(sessionId)
  }

  /** Everything running, for the settings page and diagnostics. */
  status(): PoolStatus {
    return {
      maxInstances: this.config.maxInstances,
      instances: [...this.views.values()].map(instance => instance.status()),
    }
  }

  /**
   * Everything running, with each browser's tab list read fresh.
   *
   * The tab list is what the sidebar's own tabs are built from, so it carries
   * the titles the pages carry now rather than the ones adoption remembered.
   * @returns the report, awaiting every browser's answer.
   */
  async statusAsync(): Promise<PoolStatus> {
    return {
      maxInstances: this.config.maxInstances,
      instances: await Promise.all([...this.views.values()].map(instance => instance.statusAsync())),
    }
  }

  /**
   * Adopt a new configuration, for the browsers that already exist and for
   * every one created afterwards.
   *
   * A process is reconfigured once, however many conversations look at it: the
   * launch fields it was started from are the process's, and a second
   * conversation's view has nothing of its own to restart.
   * @param next - the newly resolved configuration.
   * @returns after every live browser has been restarted, where one had to be.
   */
  async reconfigure(next: BrowserConfig): Promise<void> {
    const previous = this.config
    this.config = next
    // A moved window only changes where the *next* browser may listen; the
    // browsers already running keep the ports the allocator is still holding for
    // them, which is why this is not a launch field.
    this.allocator.setWindow(portWindow(next.debugPortMin, next.debugPortMax))
    // One reconfigure per process, driven by whichever view is first: the rest of
    // the conversations on it only need their own mirrors re-attached.
    const reconfigured = new Set<string>()
    await Promise.all([...this.views.values()].map(async (view) => {
      const key = view.host.key
      const first = !reconfigured.has(key)
      reconfigured.add(key)
      if (first) {
        await view.reconfigure(next)
        return
      }
      // This view's mirror was running with the configuration the process had
      // before the first view rewrote it, which is the one to compare against.
      await view.reconfigureMirrors(next, previous)
    }))
  }

  /**
   * Close one session's use of its browser and forget it.
   *
   * On a shared browser this is "this conversation does not want a browser": its
   * own pages go with it, and the process stays up for the conversations still
   * on it. The last one out closes the process, which is what releases its port
   * and temporary profile.
   * @param sessionId - the session whose browser is going away.
   */
  async dispose(sessionId: string): Promise<void> {
    const view = this.views.get(sessionId)
    if (view === undefined) return
    this.views.delete(sessionId)
    const host = view.host
    // The conversation's own pages are closed, and only its own: a shared process
    // that stays up must not lose somebody else's page because this one left.
    for (const targetId of host.ownedBy(sessionId)) {
      await host.pageById(targetId)?.close().catch(() => {})
    }
    await view.close()
    await host.leave(sessionId)
    if (!host.used) this.hosts.delete(host.key)
  }

  /** Close every browser, for plugin unload. */
  async closeAll(): Promise<void> {
    const hosts = [...this.hosts.values()]
    this.hosts.clear()
    this.views.clear()
    await Promise.all(hosts.map(async host => { await host.close() }))
  }
}
