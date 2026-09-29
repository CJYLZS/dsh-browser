/**
 * What the pane says about itself before it is open: the browser's guide entry
 * offers the browser's own glyph, the chip's glyph is placed like its siblings',
 * and a page's tab is addressed by the page it mirrors.
 *
 * These live here together because they are the same story told at the moments
 * the user meets a browser they did not open: an entry to pick, the chip on the
 * strip, and tabs that name their pages.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHIP_GLYPH, CHIP_GLYPH_SIZE } from '../src/client/chip.ts'
import { browserDefinition, BROWSER_KIND } from '../src/client/definition.ts'
import { followOneReport } from '../src/client/reveal.ts'
import { markClosing } from '../src/client/pages.ts'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

test('the guide entry offers the browser glyph rather than the placeholder cube', () => {
  const glyph = (): null => null
  const definition = browserDefinition(() => '浏览器', () => '浏览器', () => '镜像本机真实浏览器', glyph)
  assert.equal(definition.guide?.length, 1)
  assert.equal(
    definition.guide?.[0]?.icon,
    glyph,
    'a guide entry without an icon draws the placeholder cube for the browser',
  )
})

test('a page tab is addressed by the page it mirrors', () => {
  // One tab per browser page, named by the page's CDP target id: opening the
  // same page again reveals the tab that is already there, and a tab survives
  // a reloaded client still pointing at its page.
  const definition = browserDefinition(() => '浏览器', () => '浏览器', () => '镜像本机真实浏览器', () => null)
  const address = 'dsh-resource://dsh-browser-page/C7348134B8D2E3885B9D5E2BE60728CE'
  assert.ok(definition.patterns?.includes('dsh-resource://dsh-browser-page/**'))
  assert.equal(definition.canOpen?.(address), true)
  assert.equal(definition.canOpen?.('sidebar://cdpBrowser'), false)
  assert.equal(definition.canOpen?.('dsh-resource://file/s1/notes.md'), false)
})

test('the chip glyph adds no spacing or centring of its own', () => {
  // The chip's title row is `display: flex; gap: 5px; align-items: center`, and
  // the slot reaches this wrapper through `display: contents`. So the wrapper
  // may say only "do not shrink me"; anything that spaces or nudges the glyph
  // is measured against the sibling chips rather than chosen here.
  const keys = Object.keys(CHIP_GLYPH)
  assert.deepEqual(
    keys.filter(key => /^(margin|padding|verticalAlign|position|top|left)/.test(key)),
    [],
    'a spacing or nudge property here lands on top of the row gap and centring the chip already applies',
  )
  assert.equal(CHIP_GLYPH.display, 'flex', 'an inline wrapper puts the svg on a baseline and lifts it off the centre the row applies')
  assert.equal(CHIP_GLYPH.alignItems, 'center')
  assert.equal(CHIP_GLYPH.flex, '0 0 auto', 'a long label must not shrink the glyph')
})

test('the chip glyph is drawn at the size the sibling chips draw theirs', () => {
  // `FileTypeIcon size={16}` in the files and text titles, and the built-in
  // Browser tab's own default for this globe.
  assert.equal(CHIP_GLYPH_SIZE, 16)
})

/**
 * A client context that records what the loop did, over the tabs it was told
 * the Sidebar already shows.
 * @param tabs - the open tabs of this kind, per session.
 * @returns the context and what was opened and closed on it.
 */
function clientWith(tabs: { sessionId: string; tabId: string; contentId: string }[]): {
  ctx: ClientContext
  opened: string[]
  closed: string[]
} {
  const opened: string[] = []
  const closed: string[] = []
  const ctx = {
    sidebarRight: {
      openTabs: {
        getSnapshot: () => tabs.map(tab => ({ ...tab, kind: BROWSER_KIND })),
      },
      openResourceIn: (_sessionId: unknown, address: string) => { opened.push(address) },
      closeIn: (_sessionId: unknown, tabId: unknown) => { closed.push(String(tabId)) },
    },
  }
  return { ctx: ctx as unknown as ClientContext, opened, closed }
}

test('a report is followed: a tab for every page, none for a page that is gone', () => {
  const { ctx, opened, closed } = clientWith([
    { sessionId: 'session-a', tabId: 't0', contentId: 'dsh-resource://dsh-browser-page/target-0' },
    { sessionId: 'session-a', tabId: 't2', contentId: 'dsh-resource://dsh-browser-page/target-2' },
  ])
  followOneReport(ctx, {
    instances: [{
      sessionId: 'session-a',
      state: 'ready',
      tabs: [
        { index: 0, url: 'https://a.test/', active: false, targetId: 'target-0', title: 'A' },
        { index: 1, url: 'https://b.test/', active: true, targetId: 'target-1', title: 'B' },
      ],
    }],
  })
  assert.deepEqual(opened, ['dsh-resource://dsh-browser-page/target-1'])
  assert.deepEqual(closed, ['t2'], 'a page the browser no longer holds takes its tab with it')
})

test('a browser that stopped takes every page tab with it', () => {
  // The report for a stopped browser lists no pages; its tabs are then a
  // picture of pages that are not there.
  const { ctx, opened, closed } = clientWith([
    { sessionId: 'session-a', tabId: 't0', contentId: 'dsh-resource://dsh-browser-page/target-0' },
  ])
  followOneReport(ctx, { instances: [{ sessionId: 'session-a', state: 'closed', tabs: [] }] })
  assert.deepEqual(opened, [])
  assert.deepEqual(closed, ['t0'])
})

test('the guide entry tab stands down once page tabs exist', () => {
  const { ctx, opened, closed } = clientWith([
    { sessionId: 'session-a', tabId: 'g1', contentId: 'sidebar://cdpBrowser' },
  ])
  followOneReport(ctx, {
    instances: [{
      sessionId: 'session-a',
      state: 'ready',
      tabs: [{ index: 0, url: 'https://a.test/', active: true, targetId: 'target-0', title: 'A' }],
    }],
  })
  assert.deepEqual(opened, ['dsh-resource://dsh-browser-page/target-0'])
  assert.deepEqual(closed, ['g1'], 'the un-named tab is redundant once pages have their own')
})

test('a page whose close was just asked for does not get its tab back', () => {
  // The user closed the tab; the close is on its way. The report still lists
  // the page, and reading that moment as "a page with no tab" would put the
  // tab back over the close the user asked for.
  const { ctx, opened } = clientWith([])
  markClosing('session-a', 'target-0')
  followOneReport(ctx, {
    instances: [{
      sessionId: 'session-a',
      state: 'ready',
      tabs: [{ index: 0, url: 'https://a.test/', active: true, targetId: 'target-0', title: 'A' }],
    }],
  })
  assert.deepEqual(opened, [], 'a tab whose page is on its way out is not opened again')
  // The kind is the one the close handler is registered under.
  assert.equal(BROWSER_KIND, 'cdpBrowser')
})
