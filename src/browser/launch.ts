/**
 * Start the browser and make its external CDP listener usable.
 *
 * Two facts measured during M1 shape this module:
 *
 * - Playwright keeps its own control channel on `--remote-debugging-pipe`, and
 *   an extra `--remote-debugging-port` still makes Chrome listen on that port
 *   (verified against `/json/version`). That port is what lets DevTools or
 *   another Playwright attach to the same browser.
 * - Because the pipe is present, Chrome does NOT write `DevToolsActivePort` in
 *   the profile, so the port cannot be discovered from disk. The port is
 *   therefore a configuration value, and readiness is proven by polling
 *   `/json/version`.
 */
import { chromium, type BrowserContext } from 'playwright-core'
import type { BrowserConfig } from '../config.ts'

/** One running browser, with the facts the mirror and its viewers need. */
export interface BrowserSession {
  /** Playwright's handle on the persistent profile. */
  readonly context: BrowserContext
  /** The external CDP port that answered during startup. */
  readonly debugPort: number
  /** `Browser` string reported by `/json/version`, for diagnostics and display. */
  readonly version: string
}

/**
 * Sleep for a fixed time.
 * @param ms - milliseconds.
 * @returns a promise settling after the delay.
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Poll the external listener until it answers.
 *
 * The browser is already running when this is called; a port that never answers
 * means the launch arguments did not take effect, which must fail loud rather
 * than leave a mirror that silently cannot be attached to.
 * @param port - the configured CDP port.
 * @param timeoutMs - budget before failing.
 * @returns the reported browser version string.
 * @throws {Error} when nothing answers within the budget.
 */
async function waitForDebugPort(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        const body = await response.json() as { Browser?: unknown }
        return typeof body.Browser === 'string' ? body.Browser : 'unknown'
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(150)
  }
  throw new Error(
    `dsh-browser: the external CDP port ${port} never answered /json/version (${lastError}); `
    + 'another process may hold the port, or the browser refused --remote-debugging-port',
  )
}

/**
 * Launch the persistent browser and wait for its CDP listener.
 * @param config - resolved plugin configuration.
 * @param userDataDir - profile directory to open (temporary or configured).
 * @param timeoutMs - budget for the listener to answer.
 * @returns the running session.
 */
export async function launchBrowser(
  config: BrowserConfig,
  userDataDir: string,
  timeoutMs = 20_000,
): Promise<BrowserSession> {
  const args = [
    `--remote-debugging-port=${config.debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...config.extraArgs,
  ]
  if (config.stealth) {
    // Measured: this is what turns `navigator.webdriver` off. The user-agent
    // half cannot be done from here — the headless spelling is only known once
    // the browser reports it — so it is applied over CDP in the manager.
    args.push('--disable-blink-features=AutomationControlled')
  }
  if (!config.headless) {
    // Measured in M1: Playwright already passes the backgrounding switches, so
    // this is not what keeps a covered window painting. It stays as the
    // documented hardening for the headful case, where the window the user
    // watches is routinely behind another one.
    args.push('--disable-features=CalculateNativeWinOcclusion')
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    // Headless has no window to take a size from, and the virtual one it uses
    // is far smaller than a real page expects — measured at 764x485, which
    // crops most sites. The configured viewport is what the page, the mirrored
    // frames, and every screenshot are then measured against. Headful keeps
    // the real window size the user is looking at.
    viewport: config.headless
      ? { width: config.viewportWidth, height: config.viewportHeight }
      : null,
    args,
    ...config.executablePath === '' ? { channel: config.channel } : { executablePath: config.executablePath },
  })
  const version = await waitForDebugPort(config.debugPort, timeoutMs)
  return { context, debugPort: config.debugPort, version }
}
