/**
 * What the pane sends for one keydown.
 *
 * The reported defect lives here: pressing Ctrl alone in the pane's canvas sent
 * the chord `Control+Control`, which the host refused, and the refusal reached
 * the pane on the frame it uses for a browser in trouble — so an ordinary
 * modifier key looked like a broken browser. The rule is that a key event only
 * leaves the pane as something the host can dispatch, and the host's own table
 * is what answers that (`../src/browser/keys.ts`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyMessage, type KeyEventLike } from '../src/client/keys.ts'

/**
 * A keydown with no modifiers held.
 * @param key - the DOM `key` value.
 * @param held - the modifiers this event says are held.
 * @returns the event the decision reads.
 */
function down(key: string, held: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held }
}

test('a modifier pressed on its own is not a keystroke', () => {
  // A chord writes its key last, and Control is not the key of a chord whose
  // modifiers are Control: the host refuses "Control+Control" and the pane shows
  // the refusal as a browser failure. Nothing is what a real browser sends too.
  assert.equal(keyMessage(down('Control', { ctrlKey: true })), undefined)
  assert.equal(keyMessage(down('Meta', { metaKey: true })), undefined)
  assert.equal(keyMessage(down('Alt', { altKey: true })), undefined)
  assert.equal(keyMessage(down('Shift', { shiftKey: true })), undefined)
})

test('a modifier pressed while another is held is still only a modifier', () => {
  assert.equal(keyMessage(down('Shift', { ctrlKey: true, shiftKey: true })), undefined)
  assert.equal(keyMessage(down('Control', { ctrlKey: true, metaKey: true })), undefined)
})

test('a key the host cannot dispatch is not sent at all', () => {
  // F5 used to travel as a chord and come back refused; the pane must not turn
  // a key it cannot deliver into a failure the user has to dismiss.
  assert.equal(keyMessage(down('F5')), undefined)
  assert.equal(keyMessage(down('F5', { ctrlKey: true })), undefined)
  assert.equal(keyMessage(down('Insert', { shiftKey: true })), undefined)
})

test('a modifier held over a character is sent as the chord it is', () => {
  assert.deepEqual(keyMessage(down('a', { ctrlKey: true })), { type: 'key', key: 'Control+a' })
  assert.deepEqual(keyMessage(down('a', { metaKey: true })), { type: 'key', key: 'Meta+a' })
  assert.deepEqual(
    keyMessage(down('A', { ctrlKey: true, shiftKey: true })),
    { type: 'key', key: 'Control+Shift+A' },
  )
})

test('a named key is sent as a key event, with its modifiers when held', () => {
  assert.deepEqual(keyMessage(down('Enter')), { type: 'key', key: 'Enter' })
  assert.deepEqual(keyMessage(down('ArrowUp', { shiftKey: true })), { type: 'key', key: 'Shift+ArrowUp' })
  // A chord of a letter the page must not receive as text.
  assert.deepEqual(keyMessage(down('Escape', { metaKey: true })), { type: 'key', key: 'Meta+Escape' })
})

test('a printable character typed on its own is text, not a key event', () => {
  // `insertText` is what makes non-Latin input work without a keycode table.
  assert.deepEqual(keyMessage(down('a')), { type: 'text', text: 'a' })
  assert.deepEqual(keyMessage(down('中')), { type: 'text', text: '中' })
  assert.deepEqual(keyMessage(down(' ')), { type: 'text', text: ' ' })
  // Shift's own case is the character the keyboard would produce.
  assert.deepEqual(keyMessage(down('A', { shiftKey: true })), { type: 'text', text: 'A' })
})

test('AltGr still types its character rather than becoming a chord', () => {
  // On Windows AltGr arrives as Control+Alt; a Polish or German layout types its
  // symbols that way, and sending it as a chord would swallow the character.
  assert.deepEqual(keyMessage(down('ą', { ctrlKey: true, altKey: true })), { type: 'text', text: 'ą' })
})
