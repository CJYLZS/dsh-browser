/**
 * Keep the plugin's configuration editable at runtime.
 *
 * The Host derives the settings namespace and its schema from this plugin's
 * loader entry, so nothing is registered host-side for the values to be
 * editable: the client half binds the same namespace and writes through it.
 * What remains here are the two facts the Host cannot infer.
 *
 * The page policy: the settings shell would otherwise expect a client that
 * generates pages from the schema, and no shipped client does that yet.
 *
 * The follow-through: every field the page edits is volatile, so an edit
 * rewrites this plugin's config object in place and announces it, and the
 * browsers follow the new values. Every such field changes how a browser is
 * launched, so a change while one is running restarts it; viewers stay
 * subscribed and the next frame request starts a browser from the new values.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { BrowserConfig } from './config.ts'
import type { BrowserPool } from './browser/pool.ts'

/** The settings namespace this plugin owns: its profile entry id. */
export const SETTINGS_NAMESPACE = 'dsh-browser'

/**
 * Declare this plugin's page policy and follow its volatile configuration.
 * @param ctx - plugin context.
 * @param resolve - reads the current values out of the configuration the loader holds.
 * @param pool - the browsers that are reconfigured on every change.
 */
export function installSettings(ctx: Context, resolve: () => BrowserConfig, pool: BrowserPool): void {
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'dsh-browser: settings page policy',
    )
  })
  // The loader has already written the new values into the configuration by the
  // time this fires, so reading it here sees the edit.
  ctx.on('loader/volatile-update', () => { void pool.reconfigure(resolve()) })
}
