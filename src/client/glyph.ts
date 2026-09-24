/**
 * The one glyph this plugin uses for the browser: the product's own globe.
 *
 * Re-exported rather than drawn here, because the harness's built-in Browser tab
 * draws exactly this icon in exactly this place — two hand-drawn globes would be
 * two subtly different globes in one tab strip. The package is part of the
 * client platform's module table, so requiring it costs nothing.
 *
 * `definition.ts` takes this as an argument instead of importing it: `test/*.test.ts`
 * imports that definition under Node's type stripping, and the primitives package
 * (CSS modules and all) is not loadable there.
 */
export { IconGlobeOutlineRegular as BrowserGlyph } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The same globe at the weight the address bar's own icons are drawn at.
 *
 * The address bar draws a lock beside it, so the globe there has to match that
 * stroke rather than the chip's; it is still the product's globe and not a
 * second drawing of one.
 */
export { IconGlobeOutlineMedium as AddressGlobe } from '@deepseek-ai/dsh-client-ui-primitives'
