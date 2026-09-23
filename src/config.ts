/**
 * Plugin configuration, changeable from cordis.yml.
 *
 * Every field is a deployment choice rather than a protocol constant: which
 * installed browser to drive, whether it gets a window, where its profile
 * lives, and how much bandwidth the mirror spends. Empty strings mean "not
 * set" so the schema stays free of optionality.
 */
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

/** Schema for {@link BrowserConfig}. */
export const Config: z<BrowserConfig> = z.object({
  channel: z.union([z.const('chrome'), z.const('msedge')]).default('chrome'),
  executablePath: z.string().default(''),
  headless: z.boolean().default(true),
  userDataDir: z.string().default(''),
  debugPort: z.natural().max(65535).default(9333),
  viewportWidth: z.natural().default(1440),
  viewportHeight: z.natural().default(900),
  stealth: z.boolean().default(true),
  startupUrl: z.string().default('about:blank'),
  quality: z.natural().min(1).max(100).default(70),
  maxWidth: z.natural().default(1600),
  maxHeight: z.natural().default(1200),
  everyNthFrame: z.natural().default(1),
  snapshotNodes: z.natural().min(1).default(300),
  maxInstances: z.natural().min(1).max(16).default(4),
  extraArgs: z.array(z.string()).default([]),
})
