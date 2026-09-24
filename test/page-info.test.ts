/**
 * "Scroll down" is the one instruction a model cannot check on its own: a
 * snapshot of a long page looks the same after scrolling as before it. The page
 * info line is what makes the viewport honest — where in the page this
 * snapshot was taken, how much is above and below, and which screen of how
 * many it is.
 *
 * The shape comes from `Page.getLayoutMetrics`, which is the same call the
 * click coordinates use, so the numbers and the clicks cannot disagree.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatPageInfo, pageInfoFromMetrics, type PageInfo } from '../src/browser/page-info.ts'

/** A viewport-sized page, measured on a 1280x720 window. */
const FITS: PageInfo = { viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 720, scrolledY: 0 }

test('a page that fits in the window says so', () => {
  assert.equal(formatPageInfo(FITS), 'Page info: 1280x720 viewport, page 1280x720 — the whole page is in view')
})

test('the top of a long page reports what is below it', () => {
  const info: PageInfo = { viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 3600, scrolledY: 0 }
  assert.equal(
    formatPageInfo(info),
    'Page info: 1280x720 viewport, page 1280x3600 (5 screens) — at the top, 2880 px below, screen 1 of 5',
  )
})

test('a scrolled page reports how far down it is and what is left below', () => {
  const info: PageInfo = { viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 3600, scrolledY: 900 }
  assert.equal(
    formatPageInfo(info),
    'Page info: 1280x720 viewport, page 1280x3600 (5 screens) — 900 px scrolled (25%), 1980 px below, screen 2 of 5',
  )
})

test('the bottom of a page says there is nothing left to scroll to', () => {
  const info: PageInfo = { viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 3600, scrolledY: 2880 }
  assert.equal(
    formatPageInfo(info),
    'Page info: 1280x720 viewport, page 1280x3600 (5 screens) — at the bottom, 2880 px above, screen 5 of 5',
  )
})

test('a page that no longer scrolls is described from the top regardless of the old offset', () => {
  const info: PageInfo = { viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 600, scrolledY: 300 }
  assert.equal(formatPageInfo(info), 'Page info: 1280x720 viewport, page 1280x600 — the whole page is in view')
})

test('a browser that reports no viewport is not described with zeroes', () => {
  assert.equal(
    formatPageInfo({ viewportWidth: 0, viewportHeight: 0, pageWidth: 0, pageHeight: 0, scrolledY: 0 }),
    'Page info: the page reported no viewport size',
  )
})

test('layout metrics are read into the numbers the line needs', () => {
  const info = pageInfoFromMetrics({
    cssVisualViewport: { clientWidth: 1440, clientHeight: 900, pageY: 0 },
    cssLayoutViewport: { pageX: 0, pageY: 1234 },
    cssContentSize: { width: 1440, height: 4200 },
  })
  assert.deepEqual(info, { viewportWidth: 1440, viewportHeight: 900, pageWidth: 1440, pageHeight: 4200, scrolledY: 1234 })
})

test('a page smaller than its viewport is reported at its own size, not the scroll offset', () => {
  const info = pageInfoFromMetrics({
    cssVisualViewport: { clientWidth: 1440, clientHeight: 900 },
    cssLayoutViewport: { pageY: 40 },
    cssContentSize: { width: 1440, height: 400 },
  })
  assert.equal(info.pageHeight, 900)
  assert.equal(info.scrolledY, 0)
})

test('metrics that are missing entirely do not throw', () => {
  assert.deepEqual(pageInfoFromMetrics(undefined), {
    viewportWidth: 0, viewportHeight: 0, pageWidth: 0, pageHeight: 0, scrolledY: 0,
  })
})
