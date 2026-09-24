/**
 * Drive a real local Chrome and mirror it into the right Sidebar.
 *
 * One plugin row owns all of it: the browsers, the tools that drive them, and
 * the WebSocket a Sidebar viewer renders from. There is one browser per
 * conversation — same tools, same pane, different session, different browser —
 * and each starts on first use, when a tool call or a viewer asks for it.
 *
 * The tab type registers from the client half under its own kind (`cdpBrowser`)
 * rather than taking over `browser`: a later harness ships
 * `ui-sidebar-browser` under that kind, and that tab embeds a page in the app
 * while this one mirrors a separate browser process.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-skill'
import { BrowserPool } from './browser/pool.ts'
import { registerStream } from './view/server.ts'
import { registerStatus } from './view/status.ts'
import { registerTools } from './tools/index.ts'
import { installSettings } from './settings.ts'
import { browserSkill } from './skill.ts'
import { Config, plainConfig, type BrowserConfig, type BrowserConfigInput } from './config.ts'

export { Config, plainConfig }
export type { BrowserConfig, BrowserConfigInput }

/** Plugin identity in cordis diagnostics. */
export const name = 'dsh-browser'

/**
 * Services this plugin cannot work without.
 *
 * `connection` is a hard requirement, not an optional one: the viewer route is
 * served by this plugin and would be unauthenticated without it, so a profile
 * that cannot supply the trust check must fail to load the plugin rather than
 * run an open route into the user's browser.
 */
export const inject = ['tools', 'webServer', 'connection']

/**
 * Host half: own the browsers, serve the mirror, and register the tools.
 * @param ctx - plugin context.
 * @param config - the configuration the loader holds, whose editable fields it
 * rewrites in place.
 */
export function apply(ctx: Context, config: BrowserConfigInput): void {
  // Read through the wrappers on every use, so a settings edit is picked up
  // without the plugin being remounted around it.
  const resolve = (): BrowserConfig => plainConfig(config)
  const pool = new BrowserPool(resolve(), ctx.logger)
  ctx.effect(() => () => { void pool.closeAll() }, 'dsh-browser: browser lifetime')
  // A disposed session cannot come back, so its browser is a process, a profile,
  // and a CDP port held for a conversation nobody can return to.
  ctx.on('session/disposed', (session) => { void pool.dispose(session.id) })
  installSettings(ctx, resolve, pool)
  registerStream(ctx, pool)
  registerStatus(ctx, pool)
  registerTools(ctx, pool)
  // The guidance is contributed as a skill rather than as more tool
  // description: it is worth reading once per task, not once per call. A
  // profile that mounts no skill registry keeps the tools and loses only the
  // words, which is why this is injected rather than required.
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => {
      try {
        return scoped.skills.register(browserSkill())
      } catch (error) {
        // A guidance file that cannot be read leaves a usable plugin: the tools
        // carry their own contracts, and losing the browser over a missing
        // paragraph would be the worse failure. The warning names the file.
        scoped.logger.warn(error instanceof Error ? error : new Error(String(error)))
        return () => {}
      }
    }, 'dsh-browser: skill')
  })
}
