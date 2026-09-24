/**
 * Client half: register the mirror's tab type, its viewer body, and its copy.
 *
 * Registration follows the Sidebar's public two-stage path — the type into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab`
 * seat under the same definition `id`. Nothing here reaches into the Sidebar's
 * store or panes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { BrowserBody } from './view.tsx'
import { BrowserTitle } from './title.tsx'
import { revealOnBrowserStart } from './reveal.ts'
import { BrowserSettingsSection } from './settings.tsx'
import type { BrowserSettingsView } from './settings-layout.ts'
import { BROWSER_ID, browserDefinition } from './definition.ts'
import { BrowserGlyph } from './glyph.ts'
import { NS, en, zh, type DshBrowserKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Viewer copy, address bar, and status lines. */
    dshBrowser: DshBrowserKey
  }
}

/** Required browser services: the tab registry, its navigation face, the slot registry, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/** The settings namespace the host half registers, and this page edits. */
const SETTINGS_NAMESPACE = 'dsh-browser'

/**
 * Client plugin body: register the dictionaries, the tab type, its body, and
 * the settings page.
 * @param ctx - client root context carrying the registries and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-browser: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(
    () => t('title'),
    () => t('guideTitle'),
    () => t('guideDescription'),
    BrowserGlyph,
  )), 'dsh-browser: cdpBrowser type')
  // The pane is a session-scoped slot, so its registration factory is handed
  // the session it is rendering for — which is exactly what the viewer has to
  // name on the socket to be given that session's browser.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: BROWSER_ID,
      locale: NS,
      inject: (sessionId: SessionIdOf) => ({ sessionId }),
    },
    BrowserBody,
  )), 'dsh-browser: viewer body')
  // The chip's glyph, registered the same keyed way the shipped guide type does
  // it: without a registrant the strip shows the tab's captured title text alone,
  // which is how the browser got a chip with no icon.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: BROWSER_ID },
    BrowserTitle,
  )), 'dsh-browser: viewer title')
  // The browser is the Session's, the pane is the user's: this is what puts one
  // in front of the other when a tool starts a browser nobody is watching.
  revealOnBrowserStart(ctx)
  // The page appears only while the Host serves this namespace: a deployment
  // that never loaded the plugin's host half has no configuration to edit, so
  // the page registers nothing and the tab shows no trace of it.
  ctx.inject(['configForms'], (settingsCtx) => {
    const form = settingsCtx.configForms.get<BrowserSettingsView>(SETTINGS_NAMESPACE)
    settingsCtx.effect(
      () => settingsCtx.configForms.whileServed([SETTINGS_NAMESPACE], () =>
        settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
          name: 'settings.section',
          id: BROWSER_ID,
          order: 46,
          label: () => t('settingsTitle'),
          inject: () => ({ form, t }),
        }, BrowserSettingsSection))),
      'dsh-browser: settings section',
    )
  })
}
