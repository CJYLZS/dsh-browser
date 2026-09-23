/**
 * Make the plugin's configuration editable at runtime.
 *
 * The composition entry stays the base layer and the settings document holds
 * user overrides above it, so a deployment that configures the browser in
 * cordis.yml keeps working while the settings page changes the same fields.
 * Without a settings provider nothing is registered and the entry config is
 * the configuration, exactly as composed.
 *
 * Every field here changes how the browser is launched, so a change while one
 * is running closes it; viewers stay subscribed and the next frame request
 * starts a new browser from the new values.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, type BrowserConfig } from './config.ts'
import type { BrowserPool } from './browser/pool.ts'

/** The settings namespace this plugin owns. */
export const SETTINGS_NAMESPACE = 'dsh-browser'

/**
 * Register the settings namespace and follow it.
 * @param ctx - plugin context.
 * @param entry - the composition entry config, used as the base layer.
 * @param pool - the browsers that are reconfigured on every change.
 */
export function installSettings(ctx: Context, entry: BrowserConfig, pool: BrowserPool): void {
  ctx.inject(['settings'], (scoped) => {
    // The authoritative value is the resolved scope while a settings provider
    // is attached, and the composition entry whenever it is not.
    let current: () => BrowserConfig = () => entry
    scoped.settings.installSection(scoped, SETTINGS_NAMESPACE, Config, entry, {
      setSource: (source: () => BrowserConfig) => { current = source },
      // Every session's browser follows one shared configuration: the page is
      // the same page in every conversation, and a deployment's browser choice
      // is the deployment's, not the conversation's.
      onChange: () => { void pool.reconfigure(current()) },
    })
  })
}
