/**
 * A launcher that hands out recordable browsers instead of starting Chrome.
 *
 * The pool's whole job is deciding which session gets which browser and when
 * that browser goes away, and none of that needs a real process. These fakes
 * cover exactly the surface the plugin uses: pages, the CDP session attached to
 * one, and the context's own lifecycle events.
 *
 * The one thing a fake launch cannot avoid is the profile directory: the plugin
 * mkdtemps a `dsh-browser-*` directory *before* it calls the launcher, and a
 * test that never closes its browser is a browser the plugin never cleans up
 * after. So the launcher records what it was handed and the file's own `after`
 * hook removes them — otherwise every run leaves an empty directory per launch
 * in %TEMP%.
 */
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { after } from 'node:test'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import type { BrowserSession, LaunchConfig } from '../../src/browser/launch.ts'
import type { Launcher } from '../../src/browser/session-browser.ts'
import { fakeCdp, type FakeCdp } from './cdp.ts'

/** One dialog a fake page opened, and what the plugin answered. */
export interface FakeDialog {
  /** The kind of dialog, as Playwright reports it. */
  type(): string
  /** What the page asks. */
  message(): string
  /** What a prompt offers as its default, empty for the other kinds. */
  defaultValue(): string
  /**
   * Accept the dialog.
   * @param text - what a prompt is answered with.
   */
  accept(text?: string): Promise<void>
  /** Dismiss the dialog. */
  dismiss(): Promise<void>
  /** What the plugin answered, or `undefined` while it has not answered. */
  readonly handled: 'accepted' | 'dismissed' | undefined
  /** The text the plugin accepted a prompt with. */
  readonly answer: string | undefined
}

/** One page in a fake browser. */
export interface FakePage {
  /** The recorded page, for the plugin to use. */
  readonly page: Page
  /** The CDP session this page hands out. */
  readonly cdp: FakeCdp
  /** Address the fake reports, as `page.url()` would. */
  url: string
  /**
   * Value `page.evaluate` answers with.
   *
   * The plugin's only uses of it are the user agent it reads before overriding
   * a headless one, so that is what the fake returns.
   */
  userAgent: string
  /** Whether `page.close()` has been called. */
  readonly closed: boolean
  /**
   * Deliver a page event the plugin subscribed to.
   * @param event - event name, e.g. `framenavigated`.
   * @param args - event payload.
   */
  emit(event: string, ...args: unknown[]): void
  /**
   * Open a dialog on this page, the way `alert()` or `confirm()` would.
   *
   * The plugin has to answer it while it is open — a page that never gets an
   * answer never runs again — so the record is what says which way it answered.
   * @param type - `alert`, `confirm`, `prompt`, or `beforeunload`.
   * @param message - what the page asks.
   * @param defaultValue - what a prompt offers as its default.
   * @returns the dialog's record.
   */
  dialog(type: string, message: string, defaultValue?: string): FakeDialog
}

/** One browser a fake launch produced. */
export interface FakeBrowser {
  /** The session handed back to the plugin. */
  readonly session: BrowserSession
  /** Configuration the launch was called with — the assigned CDP port included. */
  readonly config: LaunchConfig
  /** Profile directory the launch was called with. */
  readonly profileDir: string
  /** Pages that existed when the browser started. */
  readonly pages: FakePage[]
  /** Whether the browser's context has been closed. */
  readonly closed: boolean
  /**
   * Open one more page, as `window.open` or Ctrl+T would.
   * @param url - the address the new page reports.
   * @returns the page record.
   */
  openPage(url?: string): FakePage
  /**
   * Let the browser die on its own, the way a user closing the window or a
   * crash would.
   * @param reason - what the disconnect reports.
   */
  die(reason?: string): void
}

/** The launcher plus what it produced. */
export interface FakeLaunch {
  /** The launcher to inject into the pool. */
  readonly launch: Launcher
  /** Every browser started so far, in order. */
  readonly browsers: FakeBrowser[]
}

/**
 * Whether a launch's profile directory is one the plugin created for that launch.
 *
 * Only what `mkdtemp(join(tmpdir(), 'dsh-browser-'))` produces qualifies. A
 * configured `userDataDir` resolves to a subdirectory of whatever the deployment
 * named, and that belongs to the user, not to this suite.
 * @param directory - the directory a fake launch was handed.
 * @returns whether the plugin itself created it under the temporary directory.
 */
function isTemporaryProfile(directory: string): boolean {
  return dirname(directory) === tmpdir() && basename(directory).startsWith('dsh-browser-')
}

/** Temporary profiles this process's fake launches were handed, in launch order. */
const temporaryProfiles = new Set<string>()

/**
 * Remove the temporary profiles this run's fake launches created.
 *
 * This is a record of what the launches were handed rather than a sweep of the
 * temporary directory: another dsh instance's *running* browser has a
 * `dsh-browser-*` profile there too, and deleting that would take out a browser
 * nobody asked to touch.
 */
export function removeTemporaryProfiles(): void {
  for (const directory of temporaryProfiles) {
    rmSync(directory, { recursive: true, force: true })
  }
  temporaryProfiles.clear()
}

// Registered here rather than in each test file: every file that launches a
// browser imports this module, and a test that leaks a profile is exactly the
// case the plugin cannot clean up on its own.
after(removeTemporaryProfiles)

/** The user agent a real Chrome sends from a window. */
export const HEADFUL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'

/**
 * What the same build reports without a window.
 *
 * Headless Chrome spells itself `HeadlessChrome`, which is the marker the
 * plugin's stealth setting removes.
 */
export const HEADLESS_UA = HEADFUL_UA.replace('Chrome/', 'HeadlessChrome/')

/**
 * Build a launcher that records instead of starting a browser.
 * @returns the launcher and its record of started browsers.
 */
export function fakeLauncher(): FakeLaunch {
  const browsers: FakeBrowser[] = []

  /**
   * Start one fake browser.
   * @param config - the configuration the plugin launched with.
   * @param profileDir - the profile directory the plugin chose.
   * @returns the session, as a real launch would.
   */
  const launch: Launcher = async (config: LaunchConfig, profileDir) => {
    if (isTemporaryProfile(profileDir)) temporaryProfiles.add(profileDir)
    const events = new EventEmitter()
    const pages: FakePage[] = []
    let closed = false

    /**
     * Add one page to this browser.
     * @param url - the address the page reports.
     * @returns the page record.
     */
    function createPage(url: string): FakePage {
      const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
      const cdp = fakeCdp()
      let pageClosed = false
      cdp.answers.set('Page.captureScreenshot', { data: Buffer.from('shot').toString('base64') })
      cdp.answers.set('Page.getLayoutMetrics', { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } })
      cdp.answers.set('Runtime.evaluate', { result: { value: 'evaluated' } })
      cdp.answers.set('Target.getTargetInfo', { targetInfo: { targetId: `target-${String(pages.length)}`, url } })
      const page = {
        url: () => record.url,
        title: async () => `title of ${record.url}`,
        goto: async (target: string) => {
          record.url = target
          record.emit('framenavigated')
        },
        reload: async () => { record.emit('framenavigated') },
        // A fake page never has a load in flight, so waiting for one is
        // immediately satisfied; what it proves is that an action waits at all.
        waitForLoadState: async () => {},
        close: async () => {
          pageClosed = true
          record.emit('close')
          events.emit('pageclosed', record)
        },
        evaluate: async () => record.userAgent,
        isClosed: () => pageClosed,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          handlers.set(event, [...handlers.get(event) ?? [], listener])
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          handlers.set(event, (handlers.get(event) ?? []).filter(candidate => candidate !== listener))
        },
      } as unknown as Page
      const record: FakePage = {
        page,
        cdp,
        url,
        userAgent: config.headless ? HEADLESS_UA : HEADFUL_UA,
        get closed() { return pageClosed },
        emit: (event, ...args) => {
          for (const listener of handlers.get(event) ?? []) listener(...args)
        },
        dialog: (type, message, defaultValue = '') => {
          let handled: 'accepted' | 'dismissed' | undefined
          let answer: string | undefined
          const opened: FakeDialog = {
            type: () => type,
            message: () => message,
            defaultValue: () => defaultValue,
            accept: async (text?: string) => { handled = 'accepted'; answer = text },
            dismiss: async () => { handled = 'dismissed' },
            get handled() { return handled },
            get answer() { return answer },
          }
          record.emit('dialog', opened)
          return opened
        },
      }
      pages.push(record)
      return record
    }

    const context = {
      pages: () => pages.filter(entry => !entry.closed).map(entry => entry.page),
      newPage: async () => createPage('about:blank').page,
      newCDPSession: async (page: Page) => {
        const record = pages.find(entry => entry.page === page)
        if (record === undefined) throw new Error('dsh-browser test: not a page of this context')
        return record.cdp.session as unknown as CDPSession
      },
      close: async () => {
        if (closed) return
        closed = true
        events.emit('close')
      },
      on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener) },
      off: (event: string, listener: (...args: unknown[]) => void) => { events.off(event, listener) },
    }
    // The page the browser starts with is not announced; every later one is,
    // which is what the plugin has to react to.
    createPage('about:blank')
    const browser: FakeBrowser = {
      session: {
        context: context as unknown as BrowserContext,
        debugPort: config.debugPort,
        version: 'FakeChrome/1.0',
      },
      config,
      profileDir,
      pages,
      get closed() { return closed },
      openPage: (target = 'about:blank') => {
        const created = createPage(target)
        events.emit('page', created.page)
        return created
      },
      die: (reason = 'browser closed') => {
        if (closed) return
        closed = true
        events.emit('close')
        events.emit('disconnected', reason)
      },
    }
    browsers.push(browser)
    return browser.session
  }
  return { launch, browsers }
}
