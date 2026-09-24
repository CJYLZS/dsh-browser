/**
 * What the pane says about itself before it is open: the browser's guide entry
 * offers the browser's own glyph, the chip's glyph is placed like its siblings',
 * and the client half brings the pane forward exactly when a browser has just
 * started for the Session on screen.
 *
 * These live here together because they are the same story told at the moments
 * the user meets a browser they did not open: an entry to pick, the chip on the
 * strip, and a pane that opens itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHIP_GLYPH, CHIP_GLYPH_SIZE } from '../src/client/chip.ts'
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
