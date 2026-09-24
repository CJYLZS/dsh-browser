/**
 * What a tool result says.
 *
 * The tools are the only thing the model sees of the browser, so their results
 * are part of the model's world: "Clicked e2" says nothing about whether the
 * click did anything, and a snapshot that hides where in the page it was taken
 * makes "scroll down" unverifiable. These tests hold the wording that fixes
 * both, and the formats are asserted as text because a model reads them as text.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionText, changedText, snapshotText, tabsText } from '../src/tools/index.ts'
import type { ActionReport, TabSummary } from '../src/browser/session-browser.ts'

/** The pages a result carries, with the second one active. */
const TABS: TabSummary[] = [
  { index: 0, url: 'https://example.test/first', active: false },
  { index: 1, url: 'https://example.test/second', active: true },
]

/**
 * Build an action report.
 * @param report - the fields this test cares about.
 * @returns the report, with the settled-and-unchanged defaults filled in.
 */
function report(report: Partial<ActionReport> = {}): ActionReport {
  return {
    url: 'https://example.test/form',
    title: 'Form',
    changed: [],
    mutations: 0,
    settled: true,
    ...report,
  }
}

test('an action that changed nothing says so rather than leaving it to be guessed', () => {
  assert.equal(changedText(report()), 'The page did not change.')
})

test('an action that changed the page names what changed', () => {
  assert.equal(changedText(report({ changed: ['url', 'title', 'dom'] })), 'The page changed: url, title, dom.')
})

test('an action that never settled is reported as unfinished, with what it did see', () => {
  assert.equal(
    changedText(report({ settled: false, changed: ['dom'] })),
    'The page was still changing when this returned (changed: dom).',
  )
  assert.equal(
    changedText(report({ settled: false })),
    'The page was still changing when this returned.',
  )
})

test('a click result names the element, the address, and the outcome', () => {
  assert.equal(
    actionText('Clicked button "Send"', report({ changed: ['dom'], mutations: 3 }), TABS),
    [
      'Clicked button "Send".',
      'Page: https://example.test/form — "Form"',
      'The page changed: dom.',
      '',
      '[0] https://example.test/first',
      '[active] https://example.test/second',
    ].join('\n'),
  )
})

test('an action that navigated shows the address it landed on, not the one it left', () => {
  const text = actionText('Clicked link "This week"', report({
    url: 'https://example.test/trending?since=weekly',
    title: 'Trending',
    changed: ['url', 'title'],
  }), TABS)
  assert.match(text, /Page: https:\/\/example\.test\/trending\?since=weekly — "Trending"/)
  assert.match(text, /The page changed: url, title\./)
})

test('a result says when the element had been replaced and was found again', () => {
  const text = actionText('Clicked button "Send"', report({
    element: { role: 'button', name: 'Send' },
    recovered: true,
  }), TABS)
  assert.match(text, /found again by its role and name/)
})

test('a result says when something else received the click', () => {
  const text = actionText('Clicked link "Docs"', report({
    element: { role: 'link', name: 'Docs' },
    obstructed: { role: 'generic', name: 'View all solutions' },
  }), TABS)
  assert.match(
    text,
    /\nThe click was received by generic "View all solutions", which is over the element the ref named\./,
  )
})

test('a typed result names the text and the element it went into', () => {
  const text = actionText(
    `Typed ${JSON.stringify('a@b.c')} into textbox "Email"`,
    report({ element: { role: 'textbox', name: 'Email' }, changed: ['dom'] }),
    TABS,
  )
  assert.match(text, /^Typed "a@b\.c" into textbox "Email"\./)
})

test('a snapshot result is headed by where in the page it was taken', () => {
  const text = snapshotText({
    info: 'Page info: 1440x900 viewport, page 1440x900 — the whole page is in view',
    text: '- RootWebArea "Form"\n  - button "Send" [ref=e1]',
    tabs: TABS,
  })
  assert.equal(text, [
    'Page info: 1440x900 viewport, page 1440x900 — the whole page is in view',
    '',
    '- RootWebArea "Form"',
    '  - button "Send" [ref=e1]',
    '',
    '[0] https://example.test/first',
    '[active] https://example.test/second',
  ].join('\n'))
})

test('a spilled snapshot returns the path and how to read it', () => {
  const text = snapshotText({
    info: 'Page info: 1440x900 viewport, page 1440x900 — the whole page is in view',
    text: '- RootWebArea "Form"\n… 400 more lines are in the file.',
    path: 'C:\\spill\\snapshot.txt',
    hint: 'read C:\\spill\\snapshot.txt with your file tools; grep it if it is long',
    tabs: TABS,
  })
  assert.match(text, /the whole of it is in C:\\spill\\snapshot\.txt/)
  assert.match(text, /read C:\\spill\\snapshot\.txt with your file tools/)
})

test('a page list says which page the tools act on, or that there are none', () => {
  assert.equal(tabsText(TABS), '[0] https://example.test/first\n[active] https://example.test/second')
  assert.equal(tabsText([]), 'No pages are open.')
})
