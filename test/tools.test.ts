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
import { actionText, changedText, changesText, consoleText, evaluateText, readable, shotBlocks, shotText, snapshotText, tabsActionText, tabsText, waitText } from '../src/tools/index.ts'
import type { ActionReport, TabSummary } from '../src/browser/session-browser.ts'
import type { ImageRef } from '../src/tools/attach.ts'

/** The image reference a fake attachment store hands back. */
const REF: ImageRef = { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 100, width: 10, height: 10 }

/** The pages a result carries, with the second one active. */
const TABS: TabSummary[] = [
  { index: 0, url: 'https://example.test/first', active: false, targetId: 'target-0', title: 'First' },
  { index: 1, url: 'https://example.test/second', active: true, targetId: 'target-1', title: 'Second' },
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
  const text = changedText(report())
  assert.match(text, /^The page did not change\./)
  // The line a model gets wrong most expensively: "did not change" invites a
  // second identical press, so the sentence says what it is evidence *of*.
  assert.match(text, /not a verdict on the action/)
  assert.match(text, /look further rather than pressing again/)
  // What the list can and cannot see is part of reading it honestly: only DOM
  // mutations are watched, so a value written straight into a control leaves no
  // record, and a caller that expected one has to read the control back.
  assert.match(text, /Only DOM mutations are listed/)
  assert.match(text, /an input's value, a checkbox's checked, a select's selectedIndex/)
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
      '[0] target-0 https://example.test/first',
      '[active] target-1 https://example.test/second',
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

test('a result lists what the page changed, in the words the page used', () => {
  assert.equal(
    changesText([
      { kind: 'added', tag: 'div', role: 'status', preview: '先在实例表里点一行' },
      { kind: 'attribute', tag: 'button', preview: '启动并连接', attribute: 'disabled', from: 'true' },
      { kind: 'text', tag: 'p', from: '24.1k', to: '24.2k' },
      { kind: 'removed', tag: 'li', preview: '已连接的实例' },
    ], 0),
    'dom: +1 status "先在实例表里点一行"; ~ button "启动并连接" disabled: "true" → (none); '
    + '~ p "24.1k" → "24.2k"; -1 li "已连接的实例"',
  )
})

test('a change with nothing to say is just its direction and its element', () => {
  assert.equal(changesText([{ kind: 'added', tag: 'span' }], 0), 'dom: +1 span')
  assert.equal(
    changesText([{ kind: 'attribute', tag: 'button', preview: 'Save', attribute: 'disabled' }], 0),
    'dom: ~ button "Save" disabled: (none) → (none)',
    'an attribute with no value either side still says which attribute moved',
  )
})

test('an empty attribute value reads as a value, so the two directions differ', () => {
  // `disabled=""` is how a boolean attribute looks, and the empty string is
  // what the page reports for it (`from` on removal, `to` on addition).
  assert.equal(
    changesText([{ kind: 'attribute', tag: 'button', preview: 'Save', attribute: 'disabled', from: '' }], 0),
    'dom: ~ button "Save" disabled: "" → (none)',
  )
  assert.equal(
    changesText([{ kind: 'attribute', tag: 'button', preview: 'Save', attribute: 'disabled', to: '' }], 0),
    'dom: ~ button "Save" disabled: (none) → ""',
  )
})

test('changes a result could not fit are counted where they were left out', () => {
  assert.equal(
    changesText([{ kind: 'added', tag: 'li' }], 1),
    'dom: +1 li; and 1 more change',
  )
  assert.match(changesText([{ kind: 'added', tag: 'li' }], 4), /and 4 more changes$/)
})

test('a result with no changes says nothing about changes', () => {
  assert.equal(changesText([], 0), '')
})

test('a result carries the change list under the outcome line', () => {
  const text = actionText('Clicked button "Send"', report({
    changed: ['dom'],
    mutations: 1,
    changes: [{ kind: 'added', tag: 'div', role: 'status', preview: 'Saved' }],
  }), TABS)
  assert.match(text, /\nThe page changed: dom\.\ndom: \+1 status "Saved"\n/)
})

test('a wait result says it matched, and what matched', () => {
  assert.equal(
    waitText({ text: 'Send' }, {
      matched: true, waitedMs: 320, url: 'https://example.test/form', title: 'Form',
      element: { role: 'button', name: 'Send' }, matches: 1, tabs: TABS,
    }),
    [
      'Waited 0.3 s — button "Send" is on the page.',
      'Page: https://example.test/form — "Form"',
      '',
      '[0] target-0 https://example.test/first',
      '[active] target-1 https://example.test/second',
    ].join('\n'),
  )
})

test('a wait that matched several elements says a click on them would be refused', () => {
  const text = waitText({ role: 'button', name: 'Start' }, {
    matched: true, waitedMs: 5_000, url: 'https://example.test/form', title: 'Form',
    element: { role: 'button', name: 'Start' }, matches: 3, tabs: TABS,
  })
  assert.match(text, /^Waited 5\.0 s — 3 elements match/)
  assert.match(text, /ambiguous/)
})

test('a wait that ran out of time says so and points at the snapshot', () => {
  const text = waitText({ text: 'ready' }, {
    matched: false, waitedMs: 10_000, url: 'https://example.test/form', title: 'Form', tabs: TABS,
  })
  assert.match(text, /^Waited 10\.0 s and nothing matched text "ready"; take a browser_snapshot/)
})

test('a wait for a usable element reads its two outcomes differently', () => {
  // The distinction the wait exists for: "the page has not enabled it yet" is
  // not "nothing by that name is here".
  assert.match(
    waitText({ role: 'button', name: 'Submit', enabled: true }, {
      matched: true, waitedMs: 3_200, url: 'https://example.test/form', title: 'Form',
      element: { role: 'button', name: 'Submit' }, matches: 1, tabs: TABS,
    }),
    /^Waited 3\.2 s — button "Submit" is on the page and can take a press\./,
  )
  assert.match(
    waitText({ role: 'button', name: 'Submit', enabled: true }, {
      matched: false, waitedMs: 5_000, url: 'https://example.test/form', title: 'Form',
      matches: 1, disabled: 1, tabs: TABS,
    }),
    new RegExp(
      '^Waited 5\\.0 s and nothing usable matched button "Submit"; the element it names is on the '
      + 'page, and the page says it is disabled; take a browser_snapshot',
    ),
  )
})

test('a wait on an address and a fixed wait each say what they waited for', () => {
  assert.match(
    waitText({ url: 'ready' }, {
      matched: true, waitedMs: 1_000, url: 'https://example.test/ready', title: 'Ready', tabs: TABS,
    }),
    /^Waited 1\.0 s — the address contains "ready"\./,
  )
  assert.match(
    waitText({ time: 8_000 }, {
      matched: true, waitedMs: 8_000, url: 'https://example.test/form', title: 'Form', tabs: TABS,
    }),
    /^Waited 8\.0 s \(a fixed wait\)\./,
  )
})

test('a wait result carries what the page changed while it waited', () => {
  const text = waitText({ text: 'ready' }, {
    matched: false,
    waitedMs: 10_000,
    url: 'https://example.test/form',
    title: 'Form',
    changes: [{ kind: 'added', tag: 'div', role: 'status', preview: 'engine starting' }],
    tabs: TABS,
  })
  assert.match(text, /\ndom: \+1 status "engine starting"\n/)
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
    '[0] target-0 https://example.test/first',
    '[active] target-1 https://example.test/second',
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
  // The id leads each line because it is what a later call copies: selecting
  // and closing pages name one by the id the browser gave it.
  assert.equal(
    tabsText(TABS),
    '[0] target-0 https://example.test/first\n[active] target-1 https://example.test/second',
  )
  assert.equal(tabsText([]), 'No pages are open.')
  // A page the browser has not named yet has no id to print, and saying so is
  // better than printing a line that looks like a page a call could name.
  assert.equal(
    tabsText([{ index: 2, url: 'about:blank', active: false }]),
    '[2] - about:blank',
  )
})

test('a tabs result says what each action did and lists the pages after it', () => {
  assert.equal(
    tabsActionText({ action: 'list', tabs: TABS }),
    '[0] target-0 https://example.test/first\n[active] target-1 https://example.test/second',
  )
  assert.equal(
    tabsActionText({ action: 'list', tabs: [] }),
    'No pages are open. `open` starts the browser and gives it one.',
  )
  assert.equal(
    tabsActionText({ action: 'open', tabs: TABS, targetId: 'target-1', url: 'https://example.test/second' }),
    'Opened a new page on https://example.test/second. Its id is target-1.\n\n'
      + '[0] target-0 https://example.test/first\n[active] target-1 https://example.test/second',
  )
  assert.equal(
    tabsActionText({ action: 'select', tabs: TABS, targetId: 'target-0', url: 'https://example.test/first' }),
    'Now acting on page target-0 (https://example.test/first).\n\n'
      + '[0] target-0 https://example.test/first\n[active] target-1 https://example.test/second',
  )
  assert.equal(
    tabsActionText({ action: 'close', tabs: [], targetId: 'target-1' }),
    'Closed page target-1. That was the last page, so the browser stopped.\n\nNo pages are open.',
  )
})

test('a result says which dialog the page asked and how it was answered', () => {
  const text = actionText('Clicked button "Delete"', report({
    changed: ['dialog'],
    dialogs: [{ type: 'confirm', message: 'Delete this item?', defaultValue: '', handled: 'dismissed' }],
  }), TABS)
  assert.match(text, /A confirm dialog asked "Delete this item\?" and was dismissed\./)
  // The model's next move is the one that matters: dismissing is the answer
  // that changes nothing, and a call can only answer a dialog it announced.
  assert.match(text, /Pass dialog: "accept" on the call that opens it/)
})

test('a dialog that was already open is reported as not this call\u2019s', () => {
  const text = actionText('Clicked button "Delete"', report({
    dialogs: [{
      type: 'confirm',
      message: 'Discard changes?',
      defaultValue: '',
      handled: 'dismissed',
      earlier: true,
    }],
  }), TABS)
  assert.match(text, /and was dismissed\. \(it was already open when this call began/)
})

test('a prompt that was accepted says what it was answered with', () => {
  const text = actionText('Clicked button "Rename"', report({
    dialogs: [{
      type: 'prompt',
      message: 'Your name?',
      defaultValue: 'Anonymous',
      handled: 'accepted',
      answer: 'Ada',
    }],
  }), TABS)
  assert.match(text, /A prompt dialog asked "Your name\?" and was accepted with "Ada"\./)
})

test('a dialog nobody had to answer differently carries no advice about answering it', () => {
  const text = actionText('Clicked button "Delete"', report({
    dialogs: [{ type: 'confirm', message: 'Delete this item?', defaultValue: '', handled: 'accepted' }],
  }), TABS)
  assert.match(text, /and was accepted\./)
  assert.doesNotMatch(text, /Pass dialog/)
})

test('a result that met no dialog says nothing about dialogs', () => {
  const text = actionText('Clicked button "Send"', report({ changed: ['dom'] }), TABS)
  assert.doesNotMatch(text, /dialog/)
})

test('a console result lists what the page said, oldest first, with where it came from', () => {
  const text = consoleText({
    entries: [
      { level: 'log', message: 'booting', timestamp: '2026-09-29T10:00:00.000Z' },
      {
        level: 'error',
        message: 'TypeError: save is not a function',
        timestamp: '2026-09-29T10:00:01.000Z',
        url: 'https://example.test/app.js:4',
      },
    ],
    matched: 2,
    total: 2,
    dropped: 0,
    url: 'https://example.test/form',
    title: 'Form',
    tabs: TABS,
  })
  assert.match(text, /^Page: https:\/\/example\.test\/form — "Form"/)
  assert.match(text, /oldest first \(2 matching\)/)
  assert.match(text, /\[log\] booting\n\[error\] TypeError: save is not a function — https:\/\/example\.test\/app\.js:4/)
  assert.doesNotMatch(text, /dropped/)
})

test('a console result says how much of the history it is not showing', () => {
  const text = consoleText({
    entries: [{ level: 'error', message: 'newest', timestamp: '2026-09-29T10:00:02.000Z' }],
    matched: 4,
    total: 9,
    dropped: 3,
    url: 'https://example.test/form',
    title: 'Form',
    tabs: TABS,
  })
  assert.match(text, /3 older matching entries are not shown/)
  assert.match(text, /the buffer dropped 3 older entries/)
})

test('a page that has said nothing is reported as having said nothing', () => {
  const quiet = consoleText({
    entries: [],
    matched: 0,
    total: 0,
    dropped: 0,
    url: 'https://example.test/form',
    title: 'Form',
    tabs: TABS,
  })
  assert.match(quiet, /has said nothing since it loaded/)
  // A page that has said plenty, none of it matching, is a different fact: the
  // caller narrowed the question, and the page was not quiet.
  const filtered = consoleText({
    entries: [],
    matched: 0,
    total: 9,
    dropped: 0,
    url: 'https://example.test/form',
    title: 'Form',
    tabs: TABS,
  })
  assert.match(filtered, /Nothing the page said matches this call \(9 entries in all\)/)
})

test('a capture says what it is a picture of, and where the file is', () => {
  assert.equal(
    shotText({}, { path: 'C:\\shots\\shot-1.jpg', width: 1280, height: 720, bytes: 4567 }),
    'Captured the viewport — 1280x720, 4567 bytes, in C:\\shots\\shot-1.jpg.',
  )
  assert.match(
    shotText({ fullPage: true }, { path: 'C:\\shots\\shot-2.jpg', width: 1280, height: 4321, bytes: 9999 }),
    /^Captured the whole page — 1280x4321/,
  )
  assert.match(
    shotText({}, {
      path: 'C:\\shots\\shot-3.jpg',
      width: 120,
      height: 45,
      bytes: 700,
      element: { role: 'button', name: 'Send' },
    }),
    /^Captured button "Send" — 120x45/,
  )
})

test('a capture that was inlined says so, and one that was not says nothing about an image', () => {
  const value = { path: 'C:\\shots\\shot-1.jpg', width: 10, height: 10, bytes: 100 }
  assert.doesNotMatch(shotText({}, value), /attached/)
  assert.match(shotText({}, { ...value, image: REF }), /The image itself is attached\./)
})

test('an inlined capture renders as the sentence and the image block beside it', () => {
  const blocks = shotBlocks({}, {
    path: 'C:\\shots\\shot-1.jpg',
    width: 10,
    height: 10,
    bytes: 100,
    image: REF,
  })
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0]?.type, 'text')
  // The block carries the store's own reference, which is what makes the
  // picture durable: it is stored before the result is appended, so a replayed
  // conversation still has it.
  assert.deepEqual(blocks[1], { type: 'image', attachment: REF })
})

test('a capture that was not inlined renders as one text block', () => {
  const blocks = shotBlocks({}, { path: 'C:\\shots\\shot-1.jpg', width: 10, height: 10, bytes: 100 })
  assert.deepEqual(blocks.map(block => block.type), ['text'])
})

test('a snapshot result carries a dialog the page opened while it was being read', () => {
  const text = snapshotText({
    info: 'Page info: 1440x900 viewport, page 1440x900 — the whole page is in view',
    text: '- RootWebArea "Form"',
    dialogs: [{ type: 'alert', message: 'Session expiring', defaultValue: '', handled: 'dismissed' }],
    tabs: TABS,
  })
  assert.match(text, /A alert dialog asked "Session expiring" and was dismissed\./)
  assert.match(text, /- RootWebArea "Form"/)
})

test('a string the page returned comes back as the string, not as JSON', () => {
  // The reference runtime returns strings as they are (`stringifyReplResult`),
  // and quoting them is what made every read string arrive escaped: the model
  // had to undo the escaping before it could use what it had just read.
  assert.equal(readable('first line\nsecond "quoted" line'), 'first line\nsecond "quoted" line')
  assert.equal(readable(''), '')
})

test('a structure the page returned comes back as JSON, and a value JSON cannot hold as its string', () => {
  assert.equal(readable({ rows: 2, label: 'ok' }), '{\n  "rows": 2,\n  "label": "ok"\n}')
  assert.equal(readable([1, 2]), '[\n  1,\n  2\n]')
  assert.equal(readable(undefined), 'undefined')
  // A function has no JSON form; its source is still a fact about the value.
  assert.match(readable(() => 1), /^\(\) => 1$/)
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  assert.equal(readable(cyclic), '[object Object]')
})

test('an evaluated result too large to print says where the whole of it went', () => {
  const text = evaluateText({
    result: 'first line\n… 400 more lines are in the file.',
    path: 'C:\\spill\\result.txt',
    hint: 'read C:\\spill\\result.txt with your file tools; grep it if it is long',
  })
  assert.match(text, /the whole of it is in C:\\spill\\result\.txt/)
  assert.match(text, /read C:\\spill\\result\.txt with your file tools/)
  assert.match(text, /^first line/)
})

test('an evaluated result that fits says nothing about files', () => {
  assert.equal(evaluateText({ result: 'ok' }), 'ok')
  assert.doesNotMatch(evaluateText({ result: 'ok' }), /file/)
})

test('an evaluated result carries a dialog the page opened while it ran', () => {
  const text = evaluateText({
    result: 'ok',
    dialogs: [{ type: 'confirm', message: 'Leave?', defaultValue: '', handled: 'accepted' }],
  })
  assert.match(text, /^ok\n\nA confirm dialog asked "Leave\?" and was accepted\./)
})
