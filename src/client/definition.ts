/**
 * Stage one of this plugin's tab registration: what the mirror's tab type IS.
 *
 * The kind is `cdpBrowser`, deliberately not `browser`. A later harness ships
 * `ui-sidebar-browser` under `browser`, and that tab embeds a page inside the
 * app; this one mirrors a separate browser process over CDP. Sharing the kind
 * would make installing this plugin silently replace that tab with a different
 * capability.
 */
import type { ComponentType } from 'react'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this plugin owns. */
export const BROWSER_KIND = 'cdpBrowser'

/** This implementation's identity: the key its body and title register under. */
export const BROWSER_ID = 'dsh-browser'

/**
 * The mirror's registry definition.
 *
 * The guide entry carries the glyph the caller hands in: without one the guide
 * draws its cube placeholder, which says nothing about what picking the entry
 * opens. The chip draws the same glyph through this module's own title
 * registrant, so the two places the user meets the browser agree on what it
 * looks like.
 * @param title - the tab chip's text in the current language.
 * @param guideTitle - the guide entry's title in the current language.
 * @param guideDescription - the guide entry's one-line description.
 * @param icon - the browser's glyph, supplied by the caller so this module stays
 * loadable outside the bundle (see `glyph.ts`).
 * @returns the definition to register.
 */
export function browserDefinition(
  title: () => string,
  guideTitle: () => string,
  guideDescription: () => string,
  icon: ComponentType<IconProps>,
): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    priority: 'extension',
    title,
    guide: [{ id: BROWSER_ID, order: 40, title: guideTitle, description: guideDescription, icon }],
  }
}
