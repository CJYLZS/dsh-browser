/**
 * Stage one of this plugin's tab registration: what the mirror's tab type IS.
 *
 * The kind is `cdpBrowser`, deliberately not `browser`. A later harness ships
 * `ui-sidebar-browser` under `browser`, and that tab embeds a page inside the
 * app; this one mirrors a separate browser process over CDP. Sharing the kind
 * would make installing this plugin silently replace that tab with a different
 * capability.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this plugin owns. */
export const BROWSER_KIND = 'cdpBrowser'

/** This implementation's identity: the key its body and title register under. */
export const BROWSER_ID = 'dsh-browser'

/**
 * The mirror's registry definition.
 * @param title - the tab chip's text in the current language.
 * @param guideTitle - the guide entry's title in the current language.
 * @param guideDescription - the guide entry's one-line description.
 * @returns the definition to register.
 */
export function browserDefinition(
  title: () => string,
  guideTitle: () => string,
  guideDescription: () => string,
): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    priority: 'extension',
    title,
    guide: [{ order: 40, title: guideTitle, description: guideDescription }],
  }
}
