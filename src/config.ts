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
import { DEFAULT_ATTRIBUTES } from './browser/aria.ts'

/** Which installed Chromium-family browser Playwright should start. */
export type BrowserChannel = 'chrome' | 'msedge'

/** The whitelisted accessibility properties a snapshot prints, as a schema default. */
export const SNAPSHOT_ATTRIBUTES_DEFAULT = DEFAULT_ATTRIBUTES.join(', ')

/** The selector a page marks elements no snapshot should print with, by default. */
export const SNAPSHOT_IGNORE_DEFAULT = '[data-dsh-browser-ignore]'

/**
 * Read a comma-separated configuration list.
 *
 * Both snapshot settings are lists a user types into one settings field: which
 * properties to print, and which selectors to leave out. A comma is the natural
 * separator for both, and it is also what a CSS selector list uses, so a value
 * like `nav, footer` means two selectors.
 * @param value - the configured string.
 * @returns the entries, trimmed, with the empty ones dropped.
 */
export function listOf(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

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
   * Lowest external CDP port a session browser may listen on.
   *
   * A window rather than a port, because every session gets its own browser and
   * every browser needs a listener of its own: the first one takes the lowest
   * free port here and the next takes the next. Which port a session ended up on
   * is reported by the status route, so nothing should assume it is this value.
   */
  debugPortMin: number
  /**
   * Highest external CDP port a session browser may listen on.
   *
   * The end of the window is what keeps the search from wandering into whatever
   * else this machine runs. A browser that finds nothing free inside the window
   * fails with the window in the message instead of taking a port outside it, so
   * a deployment running more sessions than the window is wide widens it here.
   */
  debugPortMax: number
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
   * spending the conversation's context on itself. A tree cut short says so, and
   * says which parameter would have printed the rest.
   *
   * 500 rather than the original 300 because the filters remove most of what a
   * snapshot used to spend its budget on: github.com/trending's 1148 nodes print
   * as 408 lines (measured 2026-09-24), so the whole page now fits in one call
   * where two thirds of it used to fall off the end.
   */
  snapshotNodes: number
  /**
   * Accessibility properties one node prints, comma-separated.
   *
   * A role and a name are what a reader hears; everything else a node reports is
   * detail, and printing all of it buries the tree. The default is the short
   * list that changes what the model can do — where a link goes, how deep a
   * heading is, what a field expects. Empty prints none.
   */
  snapshotAttributes: string
  /**
   * CSS selectors whose elements no snapshot prints, comma-separated.
   *
   * This is the page's own escape hatch, and the deployment's: a site can mark
   * decoration (or something the plugin should never read) with a data
   * attribute, and a user can keep whole regions out. The subtree behind each
   * match is dropped, not the element alone.
   */
  snapshotIgnore: string
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
  debugPortMin: Volatile<number>
  debugPortMax: Volatile<number>
  viewportWidth: Volatile<number>
  viewportHeight: Volatile<number>
  stealth: Volatile<boolean>
  quality: Volatile<number>
  snapshotAttributes: Volatile<string>
  snapshotIgnore: Volatile<string>
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
    debugPortMin: config.debugPortMin.get(),
    debugPortMax: config.debugPortMax.get(),
    viewportWidth: config.viewportWidth.get(),
    viewportHeight: config.viewportHeight.get(),
    stealth: config.stealth.get(),
    quality: config.quality.get(),
    snapshotAttributes: config.snapshotAttributes.get(),
    snapshotIgnore: config.snapshotIgnore.get(),
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
  debugPortMin: z.natural().min(1).max(65535).default(9333).volatile(),
  debugPortMax: z.natural().min(1).max(65535).default(9400).volatile(),
  viewportWidth: z.natural().default(1440).volatile(),
  viewportHeight: z.natural().default(900).volatile(),
  stealth: z.boolean().default(true).volatile(),
  startupUrl: z.string().default('about:blank'),
  quality: z.natural().min(1).max(100).default(70).volatile(),
  maxWidth: z.natural().default(1600),
  maxHeight: z.natural().default(1200),
  everyNthFrame: z.natural().default(1),
  snapshotNodes: z.natural().min(1).default(500),
  snapshotAttributes: z.string().default(SNAPSHOT_ATTRIBUTES_DEFAULT).volatile(),
  snapshotIgnore: z.string().default(SNAPSHOT_IGNORE_DEFAULT).volatile(),
  maxInstances: z.natural().min(1).max(16).default(4),
  extraArgs: z.array(z.string()).default([]),
})
