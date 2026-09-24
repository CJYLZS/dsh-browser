/**
 * Where in the page a snapshot was taken.
 *
 * A long page looks the same in a snapshot whether it is scrolled to the top or
 * to the bottom, so "scroll down and read it" is the one instruction a model
 * cannot check. This line is that check: it comes from the same
 * `Page.getLayoutMetrics` call the click coordinates use, so the numbers and
 * the clicks cannot disagree about where the viewport is.
 */

/** The page geometry one snapshot was taken at. */
export interface PageInfo {
  /** Viewport width in CSS pixels. */
  readonly viewportWidth: number
  /** Viewport height in CSS pixels. */
  readonly viewportHeight: number
  /** Full scrollable width in CSS pixels. */
  readonly pageWidth: number
  /** Full scrollable height in CSS pixels, never less than the viewport. */
  readonly pageHeight: number
  /** How far the viewport is scrolled from the top, in CSS pixels. */
  readonly scrolledY: number
}

/** One `Page.getLayoutMetrics` result, as far as this plugin reads it. */
interface LayoutMetrics {
  readonly cssVisualViewport?: { readonly clientWidth?: number; readonly clientHeight?: number }
  readonly cssLayoutViewport?: { readonly clientWidth?: number; readonly clientHeight?: number; readonly pageY?: number }
  readonly cssContentSize?: { readonly width?: number; readonly height?: number }
}

/**
 * Read page geometry out of layout metrics.
 *
 * The content size is what the page scrolls to, but a page shorter than its
 * window reports a content size smaller than the viewport; the larger of the two
 * is what "the whole page is in view" has to be measured against. A scroll
 * offset on a page that no longer scrolls is stale, so it is dropped rather than
 * reported as a position the page is not at.
 * @param metrics - the CDP result, or anything else that arrived.
 * @returns the geometry to describe.
 */
export function pageInfoFromMetrics(metrics: unknown): PageInfo {
  const read = (metrics ?? {}) as LayoutMetrics
  const viewport = read.cssVisualViewport ?? read.cssLayoutViewport ?? {}
  const viewportWidth = viewport.clientWidth ?? 0
  const viewportHeight = viewport.clientHeight ?? 0
  const pageWidth = Math.max(read.cssContentSize?.width ?? 0, viewportWidth)
  const pageHeight = Math.max(read.cssContentSize?.height ?? 0, viewportHeight)
  const scrollable = pageHeight > viewportHeight
  const offset = scrollable ? Math.max(0, read.cssLayoutViewport?.pageY ?? 0) : 0
  return {
    viewportWidth,
    viewportHeight,
    pageWidth,
    pageHeight,
    scrolledY: Math.min(offset, pageHeight - viewportHeight),
  }
}

/**
 * Describe page geometry in one line.
 * @param info - the geometry to describe.
 * @returns the `Page info:` line a snapshot header carries.
 */
export function formatPageInfo(info: PageInfo): string {
  if (info.viewportHeight <= 0 || info.viewportWidth <= 0) return 'Page info: the page reported no viewport size'
  const viewport = `${String(info.viewportWidth)}x${String(info.viewportHeight)}`
  const page = `${String(info.pageWidth)}x${String(info.pageHeight)}`
  if (info.pageHeight <= info.viewportHeight) {
    return `Page info: ${viewport} viewport, page ${page} — the whole page is in view`
  }
  const screens = Math.ceil(info.pageHeight / info.viewportHeight)
  const below = info.pageHeight - info.viewportHeight - info.scrolledY
  const screen = Math.floor(info.scrolledY / info.viewportHeight) + 1
  const position = info.scrolledY <= 0
    ? 'at the top'
    : below <= 0
      ? 'at the bottom'
      : `${String(info.scrolledY)} px scrolled (${String(Math.round((info.scrolledY / info.pageHeight) * 100))}%)`
  const other = below <= 0
    ? `${String(info.scrolledY)} px above`
    : `${String(below)} px below`
  return `Page info: ${viewport} viewport, page ${page} (${String(screens)} screens) `
    + `— ${position}, ${other}, screen ${String(screen)} of ${String(screens)}`
}
