/**
 * A launcher that hands out recordable browsers instead of starting Chrome.
 *
 * The pool's whole job is deciding which session gets which browser and when
 * that browser goes away, and none of that needs a real process. These fakes
 * cover exactly the surface the plugin uses: pages, the CDP session attached to
 * one, and the context's own lifecycle events.
 */
import { EventEmitter } from 'node:events'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import type { BrowserConfig } from '../../src/config.ts'
import type { BrowserSession } from '../../src/browser/launch.ts'
import type { Launcher } from '../../src/browser/session-browser.ts'
import { fakeCdp, type FakeCdp } from './cdp.ts'

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
}

/** One browser a fake launch produced. */
export interface FakeBrowser {
  /** The session handed back to the plugin. */
  readonly session: BrowserSession
  /** Configuration the launch was called with — the assigned CDP port included. */
  readonly config: BrowserConfig
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
  const launch: Launcher = async (config, profileDir) => {
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
