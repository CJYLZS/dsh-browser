/**
 * How the browser's glyph is placed inside a chip title.
 *
 * The chip's title row (`[data-dockkit-tab-title]`) is already
 * `display: flex; gap: 5px; align-items: center`, and it reaches registrants
 * through a `display: contents` slot wrapper — so the harness's own chips hand
 * it a bare `<svg>`: a flex item, blockified, centred on the row's line, one
 * 5px gap from the label.
 *
 * This bundle has no stylesheet of its own, so the wrapper below is where that
 * has to be said instead. It exists for `flex: 0 0 auto` (without it a long
 * label shrinks the globe) and must add nothing else. Two measured ways of
 * getting it wrong, both seen on 2026-09-24 with the pane open in the GUI:
 *
 * - `display: inline-block` wrapping the icon leaves the *svg* inline, sitting
 *   on the wrapper's first baseline while the row centres the wrapper — an
 *   18.2px line box for a 14px glyph, 2.1px above the label's centre.
 * - `margin-right` here doubles the row's gap: 10px from the label against the
 *   sibling chips' 5px.
 *
 * `verticalAlign` is not part of it either: its wrapper is a block-level flex
 * item, where the property has no effect (which is why `-3px` never moved the
 * glyph that looked high).
 */
export const CHIP_GLYPH: Readonly<Record<string, string>> = {
  display: 'flex', alignItems: 'center', flex: '0 0 auto',
}

/**
 * The chip glyph's edge in px — the size the sibling chips draw their own
 * glyphs at (`FileTypeIcon size={16}` in the files and text titles) and the
 * built-in Browser tab's default for this same globe.
 */
export const CHIP_GLYPH_SIZE = 16
