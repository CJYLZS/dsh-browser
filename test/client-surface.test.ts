/**
 * What the pane says about itself before it is open: the browser's guide entry
 * offers the browser's own glyph, and the client half brings the pane forward
 * exactly when a browser has just started for the Session on screen.
 *
 * The two live here together because they are the same story told at the two
 * moments the user meets a browser they did not open: an entry to pick, and a
 * pane that opens itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserDefinition } from '../src/client/definition.ts'
import { justStarted } from '../src/client/reveal.ts'

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

test('a browser that was not running and is now is the moment to reveal the pane', () => {
  // No instance yet is the ordinary first call of a conversation: the browser
  // appears in the host's report the moment a tool asks the pool for one.
  assert.equal(justStarted(undefined, 'starting'), true)
  assert.equal(justStarted(undefined, 'ready'), true)
  assert.equal(justStarted('idle', 'starting'), true)
  assert.equal(justStarted('closed', 'starting'), true)
  assert.equal(justStarted('failed', 'ready'), true)
})

test('a browser that was already running is not', () => {
  assert.equal(justStarted('ready', 'ready'), false)
  assert.equal(justStarted('starting', 'ready'), false)
  assert.equal(justStarted('ready', 'closed'), false)
  assert.equal(justStarted('ready', undefined), false)
  assert.equal(justStarted(undefined, undefined), false)
})
