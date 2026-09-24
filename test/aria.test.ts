/**
 * The accessibility tree is how an agent reads a page without writing code,
 * and the only way it can name an element to click or type into. The format is
 * therefore a contract with the model: stable, small, and honest about what it
 * left out. These tests hold that contract over fixtures shaped like the trees
 * Chrome returns, including the noise Chrome really emits — one `InlineTextBox`
 * per text run, ignored wrappers, and named ancestors whose children repeat
 * them.
 *
 * The numbers behind the filter rules come from a real page (github.com/
 * trending, 2026-09-24: 1148 nodes, 215 of them `InlineTextBox`); the fixtures
 * here are the small, deterministic face of the same shapes. `scripts/
 * ax-probe.mjs` measures the real ones.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAxTree, parseQuery, RefLabels, type AxNode } from '../src/browser/aria.ts'

/**
 * Build one tree node.
 * @param node - the fields that matter for the fixture.
 * @returns the node, as CDP would report it.
 */
function node(node: Partial<AxNode> & { nodeId: string }): AxNode {
  return node
}

/** A page with a heading, a filled textbox, an enabled button inside an ignored wrapper, and a disabled link. */
const PAGE: AxNode[] = [
  node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Sign in' }, childIds: ['2', '3', '4', '5'] }),
  node({ nodeId: '2', role: { value: 'heading' }, name: { value: 'Welcome' }, childIds: ['2a'] }),
  node({ nodeId: '2a', role: { value: 'StaticText' }, name: { value: 'Welcome' } }),
  node({ nodeId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@b.c' }, backendDOMNodeId: 31 }),
  node({
    nodeId: '4',
    role: { value: 'none' },
    ignored: true,
    childIds: ['4a'],
    backendDOMNodeId: 41,
  }),
  node({ nodeId: '4a', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 42 }),
  node({
    nodeId: '5',
    role: { value: 'link' },
    name: { value: 'Forgot?' },
    properties: [{ name: 'disabled', value: { value: true } }],
    backendDOMNodeId: 51,
  }),
]

test('every node is printed as role and name in tree order', () => {
  const snapshot = formatAxTree(PAGE)
  assert.equal(snapshot.text, [
    '- RootWebArea "Sign in"',
    '  - heading "Welcome"',
    '  - textbox "Email" value="a@b.c" [ref=e1]',
    '  - button "Sign in" [ref=e2]',
    '  - link "Forgot?" [disabled] [ref=e3]',
  ].join('\n'))
})

test('a text run Chrome repeats inside its named ancestor is not printed twice', () => {
  // `heading "Welcome"` already says it; the StaticText under it is the same
  // words, and on a real page that duplicate is a large share of the lines.
  const snapshot = formatAxTree(PAGE)
  assert.equal(snapshot.text.split('\n').filter(line => line.includes('Welcome')).length, 1)
})

test('a text run that repeats a sibling rather than an ancestor is kept', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'paragraph' }, childIds: ['2', '3'] }),
    node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Nothing to see' } }),
    node({ nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Nothing to see' } }),
  ])
  assert.equal((snapshot.text.match(/Nothing to see/g) ?? []).length, 2)
})

test('one-letter text boxes are dropped without losing the text they spell', () => {
  // Chrome emits an `InlineTextBox` per rendering run; on a styled page they are
  // single characters, and the `StaticText` above them already carries the run.
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'link' }, name: { value: 'Skip to content' }, backendDOMNodeId: 11, childIds: ['2', '3', '4'] }),
    node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Skip to content' }, backendDOMNodeId: 12, childIds: ['2a', '2b'] }),
    node({ nodeId: '2a', role: { value: 'InlineTextBox' }, name: { value: 'S' }, backendDOMNodeId: 13 }),
    node({ nodeId: '2b', role: { value: 'InlineTextBox' }, name: { value: 'kip' }, backendDOMNodeId: 14 }),
    node({ nodeId: '3', role: { value: 'LineBreak' } }),
    node({ nodeId: '4', role: { value: 'ListMarker' }, name: { value: '•' } }),
  ])
  assert.equal(snapshot.text, '- link "Skip to content" [ref=e1]')
})

test('consecutive text runs under one parent read as one line', () => {
  // The paragraph itself earns no line: a nameless wrapper around a single run
  // says nothing the text does not, so the run is promoted to its place.
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'paragraph' }, childIds: ['2', '3', '4', '5'] }),
    node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Hello ' } }),
    node({ nodeId: '3', role: { value: 'StaticText' }, name: { value: 'bold' } }),
    node({ nodeId: '4', role: { value: 'StaticText' }, name: { value: ' world' } }),
    node({ nodeId: '5', role: { value: 'StaticText' }, name: { value: '.' } }),
  ])
  assert.equal(snapshot.text, '- StaticText "Hello bold world."')
})

test('two runs with no space between them are not read as one word', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'paragraph' }, childIds: ['2', '3'] }),
    node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: '$' } }),
    node({ nodeId: '3', role: { value: 'StaticText' }, name: { value: '12' } }),
  ])
  assert.equal(snapshot.text, '- StaticText "$ 12"')
})

test('a run of text separated by another node is not merged across it', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'paragraph' }, childIds: ['2', '3', '4'] }),
    node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'before' } }),
    node({ nodeId: '3', role: { value: 'link' }, name: { value: 'a link' }, backendDOMNodeId: 11 }),
    node({ nodeId: '4', role: { value: 'StaticText' }, name: { value: 'after' } }),
  ])
  assert.deepEqual(snapshot.text.split('\n'), [
    '- paragraph',
    '  - StaticText "before"',
    '  - link "a link" [ref=e1]',
    '  - StaticText "after"',
  ])
})

test('an unnamed wrapper that groups nothing is dropped and its child promoted', () => {
  // A nameless `generic` around a single button says only "there is nesting".
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'generic' }, childIds: ['2'] }),
    node({ nodeId: '2', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 21 }),
  ])
  assert.equal(snapshot.text, '- button "Send" [ref=e1]')
})

test('an unnamed wrapper that groups several nodes is kept, and keeps the grouping', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'article' }, childIds: ['2', '3'] }),
    node({ nodeId: '2', role: { value: 'link' }, name: { value: 'one' }, backendDOMNodeId: 21 }),
    node({ nodeId: '3', role: { value: 'link' }, name: { value: 'two' }, backendDOMNodeId: 22 }),
  ])
  assert.deepEqual(snapshot.text.split('\n'), [
    '- article',
    '  - link "one" [ref=e1]',
    '  - link "two" [ref=e2]',
  ])
})

test('a named wrapper is kept even when it groups one node', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'navigation' }, name: { value: 'Footer navigation' }, childIds: ['2'] }),
    node({ nodeId: '2', role: { value: 'link' }, name: { value: 'Privacy' }, backendDOMNodeId: 21 }),
  ])
  assert.equal(snapshot.text, '- navigation "Footer navigation"\n  - link "Privacy" [ref=e1]')
})

test('a subtree hidden from assistive technology never reaches the model', () => {
  const snapshot = formatAxTree([
    node({
      nodeId: '1',
      role: { value: 'none' },
      ignored: true,
      ignoredReasons: [{ name: 'ariaHiddenSubtree' }],
      childIds: ['2'],
    }),
    node({ nodeId: '2', role: { value: 'button' }, name: { value: 'hidden button' }, backendDOMNodeId: 21 }),
    node({ nodeId: '3', role: { value: 'button' }, name: { value: 'visible' }, backendDOMNodeId: 22 }),
  ])
  assert.equal(snapshot.text, '- button "visible" [ref=e1]')
})

test('nodes Chrome marks ignored are dropped and their children take their place', () => {
  const snapshot = formatAxTree(PAGE)
  assert.ok(!snapshot.text.includes('none'), 'the ignored wrapper was printed')
  assert.equal(snapshot.text.split('\n').filter(line => line.includes('button')).length, 1)
})

test('a ref names the DOM node behind it, so a click has somewhere to land', () => {
  const snapshot = formatAxTree(PAGE)
  assert.deepEqual([...snapshot.refs], [['e1', 31], ['e2', 42], ['e3', 51]])
})

test('text that cannot be clicked is described without a ref', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'StaticText' }, name: { value: 'just words' }, backendDOMNodeId: 11 }),
    node({ nodeId: '2', role: { value: 'image' }, name: { value: 'a chart' }, backendDOMNodeId: 12 }),
  ])
  assert.equal(snapshot.text, '- StaticText "just words"\n- image "a chart" [ref=e1]')
})

test('an empty name or value is left off rather than printed empty', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'button' }, name: { value: '' }, backendDOMNodeId: 11 }),
    node({ nodeId: '2', role: { value: 'textbox' }, value: { value: '' }, backendDOMNodeId: 12 }),
  ])
  assert.equal(snapshot.text, '- button [ref=e1]\n- textbox [ref=e2]')
})

test('a quote inside a name cannot end the quoted string early', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'button' }, name: { value: 'say "hi"' }, backendDOMNodeId: 11 }),
  ])
  assert.equal(snapshot.text, '- button "say \\"hi\\"" [ref=e1]')
})

test('a checked checkbox says so, and a mixed one says that', () => {
  const snapshot = formatAxTree([
    node({
      nodeId: '1',
      role: { value: 'checkbox' },
      name: { value: 'Remember' },
      properties: [{ name: 'checked', value: { value: 'true' } }],
      backendDOMNodeId: 11,
    }),
    node({
      nodeId: '2',
      role: { value: 'checkbox' },
      name: { value: 'Some' },
      properties: [{ name: 'checked', value: { value: 'mixed' } }],
      backendDOMNodeId: 12,
    }),
    node({
      nodeId: '3',
      role: { value: 'checkbox' },
      name: { value: 'Off' },
      properties: [{ name: 'checked', value: { value: 'false' } }],
      backendDOMNodeId: 13,
    }),
    node({
      nodeId: '4',
      role: { value: 'button' },
      name: { value: 'Bold' },
      properties: [{ name: 'pressed', value: { value: 'true' } }],
      backendDOMNodeId: 14,
    }),
  ])
  assert.equal(snapshot.text, [
    '- checkbox "Remember" [checked] [ref=e1]',
    '- checkbox "Some" [checked=mixed] [ref=e2]',
    '- checkbox "Off" [ref=e3]',
    '- button "Bold" [pressed] [ref=e4]',
  ].join('\n'))
})

test('only the whitelisted properties are printed, with their values truncated', () => {
  const long = 'x'.repeat(120)
  const snapshot = formatAxTree([
    node({
      nodeId: '1',
      role: { value: 'link' },
      name: { value: 'Docs' },
      description: { value: 'Documentation' },
      properties: [
        { name: 'url', value: { value: 'https://example.test/docs' } },
        { name: 'level', value: { value: '2' } },
        { name: 'focusable', value: { value: 'true' } },
        { name: 'keyshortcuts', value: { value: long } },
      ],
      backendDOMNodeId: 11,
    }),
  ], { attributes: ['url', 'level', 'keyshortcuts', 'description'] })
  assert.equal(snapshot.text, `- link "Docs" url="https://example.test/docs" level="2" keyshortcuts="${'x'.repeat(60)}…" description="Documentation" [ref=e1]`)
  assert.ok(!snapshot.text.includes('focusable'), 'a property outside the whitelist was printed')
})

test('an attribute that only repeats the name or value is left out', () => {
  const snapshot = formatAxTree([
    node({
      nodeId: '1',
      role: { value: 'textbox' },
      name: { value: 'Search' },
      value: { value: 'shoes' },
      properties: [
        { name: 'placeholder', value: { value: 'Search' } },
        { name: 'valuetext', value: { value: 'shoes' } },
        { name: 'orientation', value: { value: 'vertical' } },
      ],
      backendDOMNodeId: 11,
    }),
  ], { attributes: ['placeholder', 'valuetext', 'orientation'] })
  assert.equal(snapshot.text, '- textbox "Search" value="shoes" orientation="vertical" [ref=e1]')
})

test('one value repeated across attributes is printed once', () => {
  const snapshot = formatAxTree([
    node({
      nodeId: '1',
      role: { value: 'link' },
      name: { value: 'Home' },
      description: { value: 'Home' },
      properties: [{ name: 'url', value: { value: 'https://example.test/' } }],
      backendDOMNodeId: 11,
    }),
  ], { attributes: ['url', 'description'] })
  assert.equal(snapshot.text, '- link "Home" url="https://example.test/" [ref=e1]')
})

test('the snapshot only prints the subtree a target names', () => {
  const snapshot = formatAxTree(PAGE, { target: { backendNodeId: 42, described: 'e2' } })
  assert.equal(snapshot.text, '- button "Sign in" [ref=e1]')
})

test('a target with no node in the tree fails naming what was asked for', () => {
  assert.throws(
    () => formatAxTree(PAGE, { target: { backendNodeId: 999, described: 'e9' } }),
    /e9 .*no node/,
  )
})

test('a depth limit prints to that level and counts what is below it', () => {
  const snapshot = formatAxTree([
    node({ nodeId: '1', role: { value: 'navigation' }, name: { value: 'Main' }, childIds: ['2'] }),
    node({ nodeId: '2', role: { value: 'list' }, name: { value: 'Menu' }, childIds: ['3', '4'] }),
    node({ nodeId: '3', role: { value: 'link' }, name: { value: 'one' }, backendDOMNodeId: 21 }),
    node({ nodeId: '4', role: { value: 'link' }, name: { value: 'two' }, backendDOMNodeId: 22 }),
  ], { depth: 1 })
  assert.equal(snapshot.text, [
    '- navigation "Main"',
    '  - list "Menu"',
    '',
    '… 2 nodes are deeper than depth=1 and were not printed; raise depth to see them',
  ].join('\n'))
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.elided.depth, 2)
})

test('backend nodes the caller asked to ignore are dropped with their subtrees', () => {
  const snapshot = formatAxTree(PAGE, { ignore: new Set([42]) })
  assert.ok(!snapshot.text.includes('button'), 'the ignored button was printed')
})

test('a long page is cut at the node budget and says how to see the rest', () => {
  const many = Array.from({ length: 50 }, (_, index) => node({
    nodeId: String(index),
    role: { value: 'button' },
    name: { value: `button ${String(index)}` },
    backendDOMNodeId: 100 + index,
  }))
  const snapshot = formatAxTree(many, { maxNodes: 10 })
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.nodes, 10)
  assert.equal(snapshot.elided.budget, 40)
  assert.match(snapshot.text, /… 40 more nodes were not printed/)
  assert.match(snapshot.text, /target=/)
  assert.match(snapshot.text, /depth=/)
  assert.equal(snapshot.refs.size, 10)
})

test('a page within the budget is not marked truncated', () => {
  const snapshot = formatAxTree(PAGE, { maxNodes: 10 })
  assert.equal(snapshot.truncated, false)
  assert.equal(snapshot.elided.budget, 0)
  assert.equal(snapshot.elided.depth, 0)
  assert.ok(!snapshot.text.includes('more nodes'))
})

test('an empty tree produces empty text rather than a stray line', () => {
  const snapshot = formatAxTree([])
  assert.equal(snapshot.text, '')
  assert.equal(snapshot.refs.size, 0)
  assert.equal(snapshot.nodes, 0)
})

test('refs keep their labels across snapshots of a page, so an old ref still works', () => {
  const labels = new RefLabels()
  const first = formatAxTree(PAGE, { labels })
  assert.deepEqual([...first.refs], [['e1', 31], ['e2', 42], ['e3', 51]])
  assert.deepEqual([...first.fresh], [], 'the first snapshot marked everything as new')

  // A dropdown opens: new nodes appear ahead of the ones already labelled.
  const opened: AxNode[] = [
    node({ nodeId: '0', role: { value: 'menu' }, name: { value: 'Date range' }, childIds: ['0a'] }),
    node({ nodeId: '0a', role: { value: 'menuitem' }, name: { value: 'This week' }, backendDOMNodeId: 61 }),
    ...PAGE,
  ]
  const second = formatAxTree(opened, { labels })
  // The page grew, so only the new element has a new label.
  assert.deepEqual([...second.refs], [['e4', 61], ['e1', 31], ['e2', 42], ['e3', 51]])
  assert.deepEqual([...second.fresh], ['e4'])
  assert.match(second.text, /\*\[ref=e4\]/, 'a newly appeared element was not marked')
  assert.ok(!second.text.includes('*[ref=e1]'), 'an element that was already labelled was marked new')
})

test('a label a page has not handed out is unknown to the registry', () => {
  const labels = new RefLabels()
  formatAxTree(PAGE, { labels })
  assert.equal(labels.targetOf('e1')?.backendNodeId, 31)
  assert.equal(labels.targetOf('e9'), undefined)
  assert.deepEqual([...labels.entries()], [['e1', 31], ['e2', 42], ['e3', 51]])
})

test('a star marks a node the page gained, not one a depth limit left out', () => {
  const labels = new RefLabels()
  // The usual way to keep a large page affordable: read the top first, then ask
  // for more. Nothing on the page changed between these two.
  formatAxTree(PAGE, { labels, depth: 0 })
  const full = formatAxTree(PAGE, { labels })
  assert.deepEqual([...full.fresh], [], 'the depth limit made the page look new')
  assert.ok(!full.text.includes('*[ref='), 'a node that was there all along was marked new')

  const later = node({ nodeId: '6', role: { value: 'button' }, name: { value: 'Later' }, backendDOMNodeId: 61 })
  const grown = formatAxTree([...PAGE, later], { labels })
  assert.deepEqual([...grown.fresh], ['e4'], 'a node the page gained was not marked')
})

test('a page that goes away does not hand its numbers to the page after it', () => {
  const labels = new RefLabels()
  formatAxTree(PAGE, { labels })
  assert.equal(labels.targetOf('e1')?.backendNodeId, 31)

  // The next document mints labels of its own, and all a caller kept from the
  // last one is the string: if the new page re-used `e1`, the old ref would
  // name an element on a page it was never about.
  labels.forgetPage()
  const second = formatAxTree(PAGE, { labels })
  assert.deepEqual([...second.refs], [['e4', 31], ['e5', 42], ['e6', 51]])
  assert.equal(labels.targetOf('e1'), undefined, 'a ref from the page before still named a node')
  assert.equal(labels.targetOf('e3'), undefined)
})

test('a label can be re-pointed at the node that replaced it', () => {
  const labels = new RefLabels()
  formatAxTree(PAGE, { labels })
  labels.rebind('e2', { backendNodeId: 77, role: 'button', name: 'Sign in' })
  assert.deepEqual(labels.targetOf('e2'), { backendNodeId: 77, role: 'button', name: 'Sign in' })
  assert.equal(labels.targetOf('e1')?.backendNodeId, 31)
})

/** A page with a navigation and a result list, only one result of which is wanted. */
const RESULTS: AxNode[] = [
  node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Search' }, childIds: ['2', '3'] }),
  node({ nodeId: '2', role: { value: 'navigation' }, name: { value: 'Main' }, childIds: ['2a'] }),
  node({ nodeId: '2a', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 21 }),
  node({ nodeId: '3', role: { value: 'list' }, childIds: ['3a', '3b'] }),
  node({ nodeId: '3a', role: { value: 'listitem' }, childIds: ['3a1'] }),
  node({
    nodeId: '3a1',
    role: { value: 'link' },
    name: { value: 'Codex documentation' },
    properties: [{ name: 'url', value: { value: 'https://example.test/codex' } }],
    backendDOMNodeId: 31,
  }),
  node({ nodeId: '3b', role: { value: 'listitem' }, childIds: ['3b1'] }),
  node({ nodeId: '3b1', role: { value: 'link' }, name: { value: 'Anything else' }, backendDOMNodeId: 32 }),
]

test('a query keeps the match and the path to it, and drops the rest', () => {
  const snapshot = formatAxTree(RESULTS, { find: parseQuery('codex') })
  const lines = snapshot.text.split('\n').filter(line => line !== '' && !line.startsWith('…'))
  // The path is what makes a match readable: a link alone does not say which
  // list it belongs to. A `listitem` that groups one node prints in neither a
  // full snapshot nor this one, so a match sits at the same depth either way.
  assert.deepEqual(lines, [
    '- RootWebArea "Search"',
    '  - list',
    '    - link "Codex documentation" url="https://example.test/codex" [ref=e1]',
  ])
})

test('a query says how to read the subtree behind a match', () => {
  const snapshot = formatAxTree(RESULTS, { find: parseQuery('codex') })
  assert.match(snapshot.text, /1 node matches "codex"/)
  assert.match(snapshot.text, /target=/)
})

test('a query tested with a regular expression matches what a substring would not', () => {
  const snapshot = formatAxTree(RESULTS, { find: parseQuery('/codex.*documentation/i') })
  assert.match(snapshot.text, /Codex documentation/)
  const missed = formatAxTree(RESULTS, { find: parseQuery('/^Codex$/') })
  assert.doesNotMatch(missed.text, /Codex documentation/)
})

test('a query that matches nothing says so rather than reading as an empty page', () => {
  const snapshot = formatAxTree(RESULTS, { find: parseQuery('nothing here') })
  assert.match(snapshot.text, /Nothing in the page matches "nothing here"/)
  assert.equal(snapshot.nodes, 0)
})

test('a query is tested against the properties a line prints, not only its name', () => {
  const snapshot = formatAxTree(RESULTS, { find: parseQuery('example.test/codex') })
  assert.match(snapshot.text, /Codex documentation/)
})

test('text split across sibling runs is matched as the one line it prints as', () => {
  // A model searching for a phrase reads it in the snapshot as one line; the
  // page wrote it as several text nodes, and a query has to see the same words.
  const page = [
    node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'] }),
    node({ nodeId: '2', role: { value: 'paragraph' }, childIds: ['2a', '2b', '2c'] }),
    node({ nodeId: '2a', role: { value: 'StaticText' }, name: { value: 'Sign in to ' } }),
    node({ nodeId: '2b', role: { value: 'StaticText' }, name: { value: 'continue' } }),
    node({ nodeId: '2c', role: { value: 'StaticText' }, name: { value: ' reading' } }),
  ]
  const whole = formatAxTree(page)
  assert.match(whole.text, /StaticText "Sign in to continue reading"/)
  const found = formatAxTree(page, { find: parseQuery('continue reading') })
  assert.match(found.text, /StaticText "Sign in to continue reading"/)
})

test('a box is printed beside the element it belongs to, in viewport pixels', () => {
  const boxes = new Map([[31, { x: 120, y: 340, width: 80, height: 24 }]])
  const snapshot = formatAxTree(RESULTS, { boxes })
  assert.match(
    snapshot.text,
    /- link "Codex documentation" url="[^"]*" \[ref=e\d+\] box=120,340 80x24/,
  )
  // An element the page reported no box for prints without one rather than
  // with a box of zeroes, which would read as an element at the page's corner.
  assert.doesNotMatch(snapshot.text, /Home.*box=/)
})
