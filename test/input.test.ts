/**
 * Viewer input is translated into protocol calls here, and nothing else in the
 * plugin is as easy to get subtly wrong: a click that lands one pixel off, or a
 * key event that arrives without its key-up, breaks a page in a way no error
 * message explains. These tests pin the translation on its own, with the page
 * replaced by a recorder.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dispatchInput, scaleToViewport, type InputMessage } from '../src/browser/input.ts'
import { fakeCdp } from './support/cdp.ts'

test('a pointer move is dispatched as a move with no button held', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'mouse', action: 'move', x: 10, y: 20 })
  assert.deepEqual(cdp.method('Input.dispatchMouseEvent'), [{
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: 10, y: 20, button: 'none', clickCount: 0 },
  }])
})

test('a press defaults to the left button and one click', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'mouse', action: 'down', x: 1, y: 2 })
  assert.deepEqual(cdp.method('Input.dispatchMouseEvent')[0]?.params, {
    type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1,
  })
})

test('a release keeps the button and click count it was given', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'mouse', action: 'up', x: 3, y: 4, button: 'right', clickCount: 2 })
  assert.deepEqual(cdp.method('Input.dispatchMouseEvent')[0]?.params, {
    type: 'mouseReleased', x: 3, y: 4, button: 'right', clickCount: 2,
  })
})

test('wheel deltas reach the page unsplit', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'wheel', x: 5, y: 6, deltaX: -40, deltaY: 120 })
  assert.deepEqual(cdp.method('Input.dispatchMouseEvent')[0]?.params, {
    type: 'mouseWheel', x: 5, y: 6, deltaX: -40, deltaY: 120,
  })
})

test('typed text goes through insertText so non-Latin input works', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'text', text: '中文' })
  assert.deepEqual(cdp.method('Input.insertText'), [
    { method: 'Input.insertText', params: { text: '中文' } },
  ])
})

test('a key that produces text is pressed with that text and then released', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Enter' })
  const events = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.deepEqual(events, [
    { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, type: 'keyDown', text: '\r' },
    { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, type: 'keyUp' },
  ])
})

test('a key that produces no text is pressed raw', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'ArrowDown' })
  const [down, up] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(down?.type, 'rawKeyDown')
  assert.equal(down?.text, undefined)
  assert.equal(down?.windowsVirtualKeyCode, 40)
  assert.equal(up?.type, 'keyUp')
})

test('a key with no mapping fails naming the key and the alternative', async () => {
  const cdp = fakeCdp()
  await assert.rejects(
    () => dispatchInput(cdp.session, { type: 'key', key: 'F5' }),
    /F5.*text message/,
  )
  assert.equal(cdp.calls.length, 0)
})

test('a chord holds its modifiers down for both the press and the release', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Control+A' })
  const events = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.deepEqual(events, [
    { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2, type: 'rawKeyDown' },
    { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2, type: 'keyUp' },
  ])
})

test('a chord with a non-typing modifier produces no text, because a browser does not either', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Meta+Enter' })
  const [down] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(down?.type, 'rawKeyDown')
  assert.equal(down?.text, undefined)
  assert.equal(down?.modifiers, 4)
  assert.equal(down?.key, 'Enter')
})

test('shift alone still produces the character it would on a keyboard', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Shift+a' })
  const [down] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(down?.key, 'A')
  assert.equal(down?.text, 'A')
  assert.equal(down?.modifiers, 8)
  assert.equal(down?.type, 'keyDown')
})

test('a named key keeps its own text when a modifier that does not suppress it is held', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Shift+Enter' })
  const [down] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(down?.text, '\r')
  assert.equal(down?.modifiers, 8)
})

test('a bare character is pressed as the key it names', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'a' })
  const [down, up] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.deepEqual(down, {
    key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, type: 'keyDown', text: 'a',
  })
  assert.equal(up?.type, 'keyUp')
})

test('the modifiers a caller may name are accepted under the names a keyboard has for them', async () => {
  const aliases = ['Ctrl+a', 'Command+a', 'Option+a']
  const expected = [2, 4, 1]
  for (const [index, chord] of aliases.entries()) {
    const cdp = fakeCdp()
    await dispatchInput(cdp.session, { type: 'key', key: chord })
    assert.equal(cdp.method('Input.dispatchKeyEvent')[0]?.params['modifiers'], expected[index], chord)
  }
})

test('modifiers combine into one bit field', async () => {
  const cdp = fakeCdp()
  await dispatchInput(cdp.session, { type: 'key', key: 'Control+Shift+A' })
  const [down] = cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(down?.modifiers, 10)
  assert.equal(down?.key, 'A')
  assert.equal(down?.text, undefined)
})

test('a chord that names no key fails with a message about the chord', async () => {
  const cdp = fakeCdp()
  await assert.rejects(
    () => dispatchInput(cdp.session, { type: 'key', key: 'Control' }),
    /Control.*modifier with no key.*Control\+A/,
  )
  assert.equal(cdp.calls.length, 0)
})

test('a chord with an unknown modifier fails naming it and the ones that work', async () => {
  const cdp = fakeCdp()
  await assert.rejects(
    () => dispatchInput(cdp.session, { type: 'key', key: 'Hyper+a' }),
    /Hyper.*Control, Meta, Alt, Shift/,
  )
  assert.equal(cdp.calls.length, 0)
})

test('a chord that ends on its separator fails rather than pressing nothing', async () => {
  const cdp = fakeCdp()
  await assert.rejects(
    () => dispatchInput(cdp.session, { type: 'key', key: 'Control+' }),
    /Control\+/,
  )
  assert.equal(cdp.calls.length, 0)
})

test('fractions become pixels against the page viewport', () => {
  const message: InputMessage = { type: 'mouse', action: 'down', x: 0.5, y: 0.25 }
  assert.deepEqual(scaleToViewport(message, { width: 1000, height: 800 }), {
    type: 'mouse', action: 'down', x: 500, y: 200,
  })
})

test('wheel coordinates are scaled the same way as pointer coordinates', () => {
  const message: InputMessage = { type: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 100 }
  assert.deepEqual(scaleToViewport(message, { width: 800, height: 600 }), {
    type: 'wheel', x: 400, y: 300, deltaX: 0, deltaY: 100,
  })
})

test('messages that carry no position are passed through untouched', () => {
  const message: InputMessage = { type: 'text', text: 'a' }
  assert.equal(scaleToViewport(message, { width: 800, height: 600 }), message)
})
