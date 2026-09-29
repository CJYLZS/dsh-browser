/**
 * What a locator means, and what happens when it means more than one thing.
 *
 * A ref is one answer the page gave once; a locator is a question asked at the
 * moment of the action. The interesting case is not the happy one — it is two
 * controls with the same name, where every other tool in this space either
 * guesses or gives up. Ours refuses, and the refusal has to carry enough for
 * the caller to narrow it: which elements matched, and the ancestors that tell
 * them apart.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeLocator,
  locateAmbiguousError,
  locateInTree,
  locateMissError,
  locatorIsTreeShaped,
  type Locator,
} from '../src/browser/locate.ts'
import type { AxNode } from '../src/browser/aria.ts'

/**
 * A page with the two shapes a ref cannot express: the same control name in two
 * places, and a control with no accessible name at all.
 */
const TREE: AxNode[] = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Dashboard' }, backendDOMNodeId: 1, childIds: ['2', '3', '4', '5', '6'] },
  { nodeId: '2', role: { value: 'dialog' }, name: { value: 'Settings' }, backendDOMNodeId: 10, childIds: ['2a'] },
  // The wrapper has no name, so the trail must skip it rather than print it.
  { nodeId: '2a', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 11, childIds: ['2b'] },
  { nodeId: '2b', role: { value: 'button' }, name: { value: 'Open' }, backendDOMNodeId: 12 },
  { nodeId: '3', role: { value: 'region' }, name: { value: 'Instances' }, backendDOMNodeId: 20, childIds: ['3a', '3b'] },
  { nodeId: '3a', role: { value: 'button' }, name: { value: 'Open' }, backendDOMNodeId: 21 },
  { nodeId: '3b', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 22 },
  { nodeId: '4', role: { value: 'button' }, name: { value: 'Run' }, backendDOMNodeId: 30, childIds: ['4a'] },
  { nodeId: '4a', role: { value: 'svg' }, name: { value: '' }, backendDOMNodeId: 31 },
  { nodeId: '5', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 40 },
  // Hidden from assistive technology, and carrying a third `Open`: an action
  // cannot reach it, so it must never be offered as a candidate.
  { nodeId: '6', role: { value: 'button' }, name: { value: 'Open' }, backendDOMNodeId: 50, ignored: true },
  // A purely structural node: no DOM node behind it, so nothing to act on.
  { nodeId: '7', role: { value: 'group' }, name: { value: 'Open things' } },
  // A second root — a partial tree, as a subtree query returns — whose own name
  // is empty: the case a candidate has to report as "no named ancestor".
  { nodeId: '8', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 60, childIds: ['8a'] },
  { nodeId: '8a', role: { value: 'switch' }, name: { value: 'Beta' }, backendDOMNodeId: 61 },
]

test('a run of text its container already says is one answer, not two', () => {
  // Measured 2026-09-29 on a real page: an element whose accessible name is
  // computed from its contents — a button, a link — carries the same words as
  // the text run inside it, so both match. The run says nothing the element does
  // not, and the element is the one a caller can act on, so a plain text locator
  // has to find one thing here or every such page would be refused as ambiguous.
  // (A `role="status"` div does **not** compute a name from its contents, which
  // is why the run has to stay findable on its own — see the next test.)
  const tree: AxNode[] = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Wait' }, backendDOMNodeId: 1, childIds: ['2'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'engine ready' }, backendDOMNodeId: 70, childIds: ['2a'] },
    { nodeId: '2a', role: { value: 'StaticText' }, name: { value: 'engine ready' }, backendDOMNodeId: 71 },
  ]
  const found = locateInTree(tree, { text: 'engine ready' })
  assert.equal(found.length, 1)
  assert.equal(found[0]?.role, 'button')
  assert.equal(found[0]?.backendNodeId, 70)
})

test('a run of text inside an element that says nothing is still findable', () => {
  // A plain `div` computes no name of its own, so the text run is the only
  // thing that says "Loading…" — dropping it would make the most common way a
  // page states what it is doing impossible to wait for.
  const tree: AxNode[] = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Wait' }, backendDOMNodeId: 1, childIds: ['2'] },
    { nodeId: '2', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 80, childIds: ['2a'] },
    { nodeId: '2a', role: { value: 'StaticText' }, name: { value: 'Loading…' }, backendDOMNodeId: 81 },
  ]
  const found = locateInTree(tree, { text: 'Loading' })
  assert.equal(found.length, 1)
  assert.equal(found[0]?.backendNodeId, 81)
})

test('a role and name locator finds every element that answers it', () => {
  const found = locateInTree(TREE, { role: 'button', name: 'Open' })
  assert.deepEqual(found.map(candidate => candidate.backendNodeId), [12, 21])
})

test('a candidate carries the nearest named ancestors that tell it from the others', () => {
  const found = locateInTree(TREE, { role: 'button', name: 'Open' })
  // Nearest first, so the informative ancestor leads; the unnamed wrapper
  // between the dialog and the button is skipped rather than printed as empty.
  assert.deepEqual(found[0]?.trail, ['dialog "Settings"', 'RootWebArea "Dashboard"'])
  assert.deepEqual(found[1]?.trail, ['region "Instances"', 'RootWebArea "Dashboard"'])
})

test('role and name are matched without regard to case', () => {
  assert.deepEqual(
    locateInTree(TREE, { role: 'BUTTON', name: 'oPeN' }).map(candidate => candidate.backendNodeId),
    [12, 21],
  )
})

test('a name is matched as a substring, so a caller need not quote it exactly', () => {
  assert.deepEqual(locateInTree(TREE, { role: 'button', name: 'pen' }).map(candidate => candidate.backendNodeId), [12, 21])
})

test('a role alone finds every element with that role', () => {
  assert.deepEqual(
    locateInTree(TREE, { role: 'button' }).map(candidate => candidate.backendNodeId),
    [12, 21, 30],
  )
})

test('text finds an element by what it says, without knowing its role', () => {
  assert.deepEqual(
    locateInTree(TREE, { text: 'docs' }).map(candidate => candidate.backendNodeId),
    [22],
  )
})

test('a locator the page does not answer finds nothing rather than something near it', () => {
  assert.deepEqual(locateInTree(TREE, { role: 'button', name: 'Docs' }), [])
})

test('a role and a name are one locator, not a filter over the other', () => {
  // `name` narrows a role; it is not a second, independent search.
  assert.deepEqual(locateInTree(TREE, { role: 'link', name: 'Open' }), [])
})

test('an element hidden from assistive technology is never a candidate', () => {
  const found = locateInTree(TREE, { role: 'button', name: 'Open' })
  assert.equal(found.some(candidate => candidate.backendNodeId === 50), false)
})

test('a node with no DOM node behind it is not a candidate even when it matches', () => {
  assert.deepEqual(locateInTree(TREE, { text: 'Open things' }), [])
})

test('a CSS selector is not a question the tree answers', () => {
  // The whole locator is CSS, so this module has nothing to say; the caller
  // resolves it against the document and maps the result back by node id.
  assert.deepEqual(locateInTree(TREE, { selector: '#anything' }), [])
  assert.equal(locatorIsTreeShaped({ selector: '#anything' }), false)
  assert.equal(locatorIsTreeShaped({ role: 'button' }), true)
})

test('a miss says what was asked for and what to do instead', () => {
  const error = locateMissError({ role: 'button', name: 'Docs' })
  assert.match(error.message, /no element matches button "Docs"/)
  assert.match(error.message, /browser_snapshot/)
})

test('a CSS miss names the selector, not an element', () => {
  assert.match(locateMissError({ selector: '#gone' }).message, /no element matches selector "#gone"/)
})

test('an ambiguous locator lists every candidate with where it lives', () => {
  const found = locateInTree(TREE, { role: 'button', name: 'Open' })
  const error = locateAmbiguousError({ role: 'button', name: 'Open' }, found)
  assert.match(error.message, /matches 2 elements/)
  assert.match(error.message, /1\. button "Open" — in dialog "Settings"/)
  assert.match(error.message, /2\. button "Open" — in region "Instances"/)
  assert.match(error.message, /Narrow it with a name that is unique/)
})

test('a candidate with no named ancestor says so rather than showing an empty list', () => {
  const found = locateInTree(TREE, { role: 'switch' })
  assert.deepEqual(found[0]?.trail, [])
  const error = locateAmbiguousError({ role: 'switch' }, found)
  assert.match(error.message, /— no named ancestor/)
})

test('a locator is described the way the caller wrote it', () => {
  assert.equal(describeLocator({ role: 'button', name: 'Open' }), 'button "Open"')
  assert.equal(describeLocator({ role: 'button' }), 'role button')
  assert.equal(describeLocator({ text: 'Docs' }), 'text "Docs"')
  assert.equal(describeLocator({ selector: '#main' }), 'selector "#main"')
  const nothing: Locator = {}
  assert.equal(describeLocator(nothing), 'the given locator')
  assert.equal(locatorIsTreeShaped(nothing), false)
})
