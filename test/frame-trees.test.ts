/**
 * The frame splice, on its own.
 *
 * Chrome answers the page-level tree with every iframe element carrying no
 * children (measured 2026-09-29 on a same-origin pair), so the splice is what
 * makes a frame's controls visible at all — and the flat list it returns has to
 * stay a tree the formatter can walk, which is what the id rewriting is for.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAxTree } from '../src/browser/aria.ts'
import { mergeFrameTrees, type FrameTree } from '../src/browser/frame-trees.ts'
import type { AxNode } from '../src/browser/aria.ts'

/** One node, as CDP would report it. */
function node(node: Partial<AxNode> & { nodeId: string }): AxNode {
  return node
}

/** A page whose only frame-shaped thing is the iframe element itself. */
const PAGE: AxNode[] = [
  node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Frames' }, childIds: ['2'] }),
  node({
    nodeId: '2',
    role: { value: 'Iframe' },
    name: { value: 'iframe 1' },
    childIds: [],
    backendDOMNodeId: 41,
  }),
]

/** The frame's own tree: its document, the text in it, and a control. */
const FRAME: AxNode[] = [
  node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'I am iFrame 1' }, childIds: ['2', '3'] }),
  node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'I am iFrame 1' } }),
  node({ nodeId: '3', role: { value: 'button' }, name: { value: 'CLick Me' }, backendDOMNodeId: 51 }),
]

test('a frame\u2019s content hangs under the element that owns it', () => {
  const merged = mergeFrameTrees(PAGE, [{ ownerBackendNodeId: 41, nodes: FRAME }])
  const snapshot = formatAxTree(merged)
  assert.match(snapshot.text, /- Iframe "iframe 1"/)
  assert.match(snapshot.text, /- button "CLick Me" \[ref=/)
  assert.ok(snapshot.text.indexOf('- Iframe') < snapshot.text.indexOf('CLick Me'), 'the frame content is inside the frame')
})

test('node ids from different frames cannot collide', () => {
  // Two frames, each answering the same node ids their own tree uses; without
  // the rewrite the second frame's nodes would be unreachable children of the
  // first's.
  const merged = mergeFrameTrees(PAGE, [
    { ownerBackendNodeId: 41, nodes: FRAME },
    { ownerBackendNodeId: 41, nodes: FRAME },
  ])
  const snapshot = formatAxTree(merged)
  assert.equal(snapshot.text.split('CLick Me').length - 1, 2, 'both frames\u2019 controls are their own')
})

test('a frame whose owner the page\u2019s tree does not describe is left out', () => {
  // Hanging the frame's content at the top would print frame content as page
  // content; leaving it out says less, and says nothing false.
  const merged = mergeFrameTrees(PAGE, [{ ownerBackendNodeId: 99, nodes: FRAME }])
  assert.deepEqual(merged, PAGE)
})

test('a nested frame lands inside its parent frame\u2019s content', () => {
  // The parent frame is spliced first, so the nested frame's owner — a node of
  // the parent frame's own tree — is already in the list when the child asks
  // where it hangs.
  const nested: AxNode[] = [
    node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Inner' }, childIds: ['2'] }),
    node({ nodeId: '2', role: { value: 'button' }, name: { value: 'Inner button' }, backendDOMNodeId: 61 }),
  ]
  const outer: AxNode[] = [
    node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'I am iFrame 1' }, childIds: ['2', '3'] }),
    node({
      nodeId: '2',
      role: { value: 'Iframe' },
      name: { value: 'inner' },
      childIds: [],
      backendDOMNodeId: 55,
    }),
    node({ nodeId: '3', role: { value: 'button' }, name: { value: 'CLick Me' }, backendDOMNodeId: 51 }),
  ]
  const merged = mergeFrameTrees(PAGE, [
    { ownerBackendNodeId: 41, nodes: outer },
    { ownerBackendNodeId: 55, nodes: nested },
  ])
  const snapshot = formatAxTree(merged)
  assert.match(snapshot.text, /- button "Inner button" \[ref=/)
  assert.ok(
    snapshot.text.indexOf('Iframe "iframe 1"') < snapshot.text.indexOf('Inner button'),
    'the nested frame is inside the outer one',
  )
})
