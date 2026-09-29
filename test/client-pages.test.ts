/**
 * The client half's own model of a browser's pages: the addresses its tabs
 * carry, the rule that keeps one tab per page, and the facts a chip reads.
 *
 * The identity is the page's CDP target id, so a tab keeps naming its page
 * across navigations, active-page changes, and a reloaded client; the rule is
 * reconciliation against the host's report, and the facts are what the tab
 * chip shows while the page renames itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isClosing,
  markClosing,
  pageAddressOf,
  pageFactsOf,
  publishPageFacts,
  reconcile,
  settleClosing,
  subscribePageFacts,
  targetIdOf,
} from '../src/client/pages.ts'

test('a tab address names its page and only a page', () => {
  const address = pageAddressOf('C7348134B8D2E3885B9D5E2BE60728CE')
  assert.equal(address, 'dsh-resource://dsh-browser-page/C7348134B8D2E3885B9D5E2BE60728CE')
  assert.equal(targetIdOf(address), 'C7348134B8D2E3885B9D5E2BE60728CE')
  // The guide entry's tab names no page; neither does any other scheme.
  assert.equal(targetIdOf('sidebar://cdpBrowser'), undefined)
  assert.equal(targetIdOf('dsh-resource://file/session/s1/notes.md'), undefined)
  assert.equal(targetIdOf('dsh-resource://dsh-browser-page/'), undefined)
})

test('one tab per page: missing pages open, gone pages close', () => {
  const desired = ['dsh-resource://dsh-browser-page/a', 'dsh-resource://dsh-browser-page/b']
  const actual = [
    { id: 't1', contentId: 'dsh-resource://dsh-browser-page/a' },
    { id: 't2', contentId: 'dsh-resource://dsh-browser-page/stale' },
  ]
  assert.deepEqual(reconcile(desired, actual), {
    open: ['dsh-resource://dsh-browser-page/b'],
    close: ['t2'],
  })
  // Nothing to do when the two sides already agree.
  assert.deepEqual(
    reconcile(desired, [
      { id: 't1', contentId: 'dsh-resource://dsh-browser-page/a' },
      { id: 't2', contentId: 'dsh-resource://dsh-browser-page/b' },
    ]),
    { open: [], close: [] },
  )
})

test('the tab that names no page hands over once page tabs exist', () => {
  // The guide entry's tab exists to start a browser nobody is watching; while
  // the browser is starting it is the only pane there is, and closing it would
  // leave the picker's promise empty. Page tabs are the story it hands to.
  assert.deepEqual(
    reconcile(['dsh-resource://dsh-browser-page/a'], [
      { id: 'g1', contentId: 'sidebar://cdpBrowser' },
    ]),
    { open: ['dsh-resource://dsh-browser-page/a'], close: ['g1'] },
  )
  assert.deepEqual(
    reconcile([], [{ id: 'g1', contentId: 'sidebar://cdpBrowser' }]),
    { open: [], close: [] },
  )
})

test('a page whose close was asked for does not get its tab back', () => {
  // Closing a tab closes its page, but the host's report is a snapshot: for a
  // moment the page is still listed. The ask stands until the report agrees.
  const key = ['session-a', 'target-1'] as const
  markClosing(key[0], key[1])
  assert.equal(isClosing(key[0], key[1]), true)
  // Still listed: the ask stands.
  settleClosing([key], 1_000)
  assert.equal(isClosing(key[0], key[1]), true)
  // Gone from the report: the close answered.
  settleClosing([], 2_000)
  assert.equal(isClosing(key[0], key[1]), false)
})

test('a close ask that never answered expires, and the tab comes back', () => {
  // If the close could not be carried out — the host unreachable, the browser
  // wedged — the page is still there, and a tab for it is the honest picture.
  markClosing('session-a', 'target-2', 0)
  settleClosing([['session-a', 'target-2']], 16_000)
  assert.equal(isClosing('session-a', 'target-2'), false)
})

test('a chip reads the title the page carries now, and only then', () => {
  const address = pageAddressOf('target-1')
  const seen: number[] = []
  const unsubscribe = subscribePageFacts(() => { seen.push(seen.length + 1) })
  assert.equal(pageFactsOf(address), undefined)
  publishPageFacts([[address, { title: 'Example Domain', url: 'https://example.com' }]])
  assert.deepEqual(pageFactsOf(address), { title: 'Example Domain', url: 'https://example.com' })
  assert.equal(seen.length, 1)
  // The same facts again are not a change: a poll that learned nothing must
  // not re-render the chip.
  publishPageFacts([[address, { title: 'Example Domain', url: 'https://example.com' }]])
  assert.equal(seen.length, 1)
  // A renamed page is.
  publishPageFacts([[address, { title: 'Renamed', url: 'https://example.com' }]])
  assert.equal(pageFactsOf(address)?.title, 'Renamed')
  assert.equal(seen.length, 2)
  unsubscribe()
})
