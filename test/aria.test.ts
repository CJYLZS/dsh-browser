/**
 * The accessibility tree is how an agent reads a page without writing code,
 * and the only way it can name an element to click or type into. The format is
 * therefore a contract with the model: stable, small, and honest about what it
 * left out. These tests hold that contract over a fixture shaped like the tree
 * Chrome returns.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAxTree, type AxNode } from '../src/browser/aria.ts'

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
    '    - StaticText "Welcome"',
    '  - textbox "Email" value="a@b.c" [ref=e1]',
    '  - button "Sign in" [ref=e2]',
    '  - link "Forgot?" [disabled] [ref=e3]',
  ].join('\n'))
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

test('a node without a DOM node behind it gets no ref', () => {
  const snapshot = formatAxTree(PAGE)
  assert.ok(!snapshot.text.includes('StaticText "Welcome" [ref'), 'a text node was given a ref')
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
  ])
  assert.equal(snapshot.text, [
    '- checkbox "Remember" [checked] [ref=e1]',
    '- checkbox "Some" [checked=mixed] [ref=e2]',
    '- checkbox "Off" [ref=e3]',
  ].join('\n'))
})

test('a long page is cut at the node budget and says how much it cut', () => {
  const many = Array.from({ length: 50 }, (_, index) => node({
    nodeId: String(index),
    role: { value: 'button' },
    name: { value: `button ${String(index)}` },
    backendDOMNodeId: 100 + index,
  }))
  const snapshot = formatAxTree(many, { maxNodes: 10 })
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.text.split('\n').length, 11)
  assert.match(snapshot.text, /… 40 more nodes/)
  assert.equal(snapshot.refs.size, 10)
})

test('a page within the budget is not marked truncated', () => {
  const snapshot = formatAxTree(PAGE, { maxNodes: 10 })
  assert.equal(snapshot.truncated, false)
  assert.ok(!snapshot.text.includes('more nodes'))
})

test('an empty tree produces empty text rather than a stray line', () => {
  const snapshot = formatAxTree([])
  assert.equal(snapshot.text, '')
  assert.equal(snapshot.refs.size, 0)
})
