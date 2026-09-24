/**
 * Plugin configuration, changeable from cordis.yml.
 *
 * Every field is a deployment choice rather than a protocol constant: which
 * installed browser to drive, whether it gets a window, where its profile
 * lives, and how much bandwidth the mirror spends. Empty strings mean "not
 * set" so the schema stays free of optionality.
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Which installed Chromium-family browser Playwright should start. */
export type BrowserChannel = 'chrome' | 'msedge'

/** Resolved plugin configuration. */
export interface BrowserConfig {
  /** Installed browser to drive; ignored when `executablePath` is set. */
  channel: BrowserChannel
  /** Explicit browser binary, for installs the channel lookup misses. */
  executablePath: string
  /**
   * Whether the browser gets a window.
   *
   * Headless is the default: the mirror is normally watched in the Sidebar
   * while the browser window is behind it, and a windowless browser has no
   * occlusion or minimize state to lose rendering to. Headful is for driving a
   * window the user also looks at directly.
   */
  headless: boolean
  /**
   * Parent directory of the per-session profiles; empty means fresh temporary
   * profiles.
   *
   * Each session's browser gets its own subdirectory here, because a Chrome
   * profile directory belongs to exactly one running process. Pointing this at
   * a directory an ordinary browser is using, or at one session's own
   * subdirectory, fails to open rather than sharing it.
   */
  userDataDir: string
  /**
   * First port for the external CDP listeners that DevTools and Playwright
   * attach to.
   *
   * Each session's browser probes upward from here for a free port, so the
   * number a session ends up on is reported by the status route rather than
   * assumed from this value.
   */
  debugPort: number
  /** Page width in headless mode, which has no window to take a size from. */
  viewportWidth: number
  /** Page height in headless mode. */
  viewportHeight: number
  /**
   * Whether to hide the markers a Playwright-started browser carries.
   *
   * Measured 2026-09-23 (scripts/risk.mjs): every configuration this plugin
   * could launch reported `navigator.webdriver === true`, and headless also
   * spelled its user agent `HeadlessChrome/…`. Of six configurations put to
   * Google, those two markers were the only thing separating the one that got
   * results from the five served the "unusual traffic" page — including a real
   * Edge window started the same way. This turns both off.
   */
  stealth: boolean
  /** First address the browser opens. */
  startupUrl: string
  /** JPEG quality of mirrored frames, 1-100. */
  quality: number
  /** Longest mirrored frame edge, in device pixels. */
  maxWidth: number
  /** Tallest mirrored frame edge, in device pixels. */
  maxHeight: number
  /** Mirror every Nth composited frame; 1 is every frame. */
  everyNthFrame: number
  /**
   * Most accessibility-tree nodes one `browser_snapshot` prints.
   *
   * The tree becomes model input, so the budget is what keeps a large page from
   * spending the conversation's context on itself. A tree cut short says so.
   */
  snapshotNodes: number
  /**
   * How many session browsers may run at once.
   *
   * Each one is a browser process with its own profile, so this bounds both
   * memory and, in headful mode, how many windows appear. Reaching it fails the
   * request naming the limit rather than evicting a browser someone is looking
   * at.
   */
  maxInstances: number
  /** Additional browser arguments, appended after this plugin's own. */
  extraArgs: string[]
}

/**
 * The fields the settings page edits, as the loader holds them.
 *
 * A volatile field is a reference the loader rewrites in place, which is how an
 * edit reaches a running plugin without remounting it; everything else in
 * {@link BrowserConfig} arrives as a plain value.
 */
export interface BrowserConfigVolatile {
  channel: Volatile<BrowserChannel>
  executablePath: Volatile<string>
  headless: Volatile<boolean>
  userDataDir: Volatile<string>
  debugPort: Volatile<number>
  viewportWidth: Volatile<number>
  viewportHeight: Volatile<number>
  stealth: Volatile<boolean>
  quality: Volatile<number>
}

/** What the loader hands `apply`: {@link BrowserConfig} with its editable fields wrapped. */
export type BrowserConfigInput = Omit<BrowserConfig, keyof BrowserConfigVolatile> & BrowserConfigVolatile

/**
 * Read the current values out of a resolved configuration.
 *
 * Called per use rather than once, because a volatile field's contents change
 * when the settings page writes one; the wrapper is what stays the same.
 * @param config - the configuration the loader holds.
 * @returns the plain configuration the rest of the plugin works with.
 */
export function plainConfig(config: BrowserConfigInput): BrowserConfig {
  return {
    ...config,
    channel: config.channel.get(),
    executablePath: config.executablePath.get(),
    headless: config.headless.get(),
    userDataDir: config.userDataDir.get(),
    debugPort: config.debugPort.get(),
    viewportWidth: config.viewportWidth.get(),
    viewportHeight: config.viewportHeight.get(),
    stealth: config.stealth.get(),
    quality: config.quality.get(),
  }
}

/**
 * Schema for {@link BrowserConfigInput}.
 *
 * Marking a field volatile is what puts it on the settings page: the shell
 * exposes exactly the fields a volatile ancestor makes editable, and rewrites
 * them in place instead of remounting the plugin, so a running browser is
 * restarted onto the new values rather than losing the pane watching it.
 * Launch and encoding fields are volatile for that reason; the rest are
 * ordinary configuration, changeable from cordis.yml.
 */
export const Config = z.object({
  channel: z.union([z.const('chrome'), z.const('msedge')]).default('chrome').volatile(),
  executablePath: z.string().default('').volatile(),
  headless: z.boolean().default(true).volatile(),
  userDataDir: z.string().default('').volatile(),
  debugPort: z.natural().max(65535).default(9333).volatile(),
  viewportWidth: z.natural().default(1440).volatile(),
  viewportHeight: z.natural().default(900).volatile(),
  stealth: z.boolean().default(true).volatile(),
  startupUrl: z.string().default('about:blank'),
  quality: z.natural().min(1).max(100).default(70).volatile(),
  maxWidth: z.natural().default(1600),
  maxHeight: z.natural().default(1200),
  everyNthFrame: z.natural().default(1),
  snapshotNodes: z.natural().min(1).default(300),
  maxInstances: z.natural().min(1).max(16).default(4),
  extraArgs: z.array(z.string()).default([]),
})
