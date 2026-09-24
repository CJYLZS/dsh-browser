/**
 * The pane's own clipboard.
 *
 * Two decisions live here with right answers, and they are the ones worth
 * testing without a browser: which keystroke the pane takes for itself, and what
 * it does once the mirror reports its selection. The DOM plumbing around them
 * (the paste sink, the clipboard write with its textarea fallback) is in
 * `view.tsx`, which no Node test can import.
 *
 * The rule the second decision carries is Guacamole's, from its own clipboard
 * bridge: never disturb the clipboard unless the local one actually changed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipboardChord, clipboardReply, pasteMessage, type ChordEventLike } from '../src/client/clipboard.ts'

/**
 * A keydown with no modifiers held.
 * @param key - the DOM `key` value.
 * @param held - the modifiers this event says are held.
 * @returns the event the decision reads.
 */
function down(key: string, held: Partial<ChordEventLike> = {}): ChordEventLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held }
}

test('the three clipboard shortcuts are the pane to handle', () => {
  assert.equal(clipboardChord(down('c', { ctrlKey: true })), 'copy')
  assert.equal(clipboardChord(down('x', { ctrlKey: true })), 'cut')
  assert.equal(clipboardChord(down('v', { ctrlKey: true })), 'paste')
  // Meta is the same shortcut on macOS, where the pane's user may well be.
  assert.equal(clipboardChord(down('c', { metaKey: true })), 'copy')
  assert.equal(clipboardChord(down('V', { metaKey: true })), 'paste')
})

test('shift does not take a clipboard shortcut away', () => {
  // Control+Shift+V is a browser's paste-as-plain-text, which is exactly what
  // this paste is, and nothing else claims Shift+C or Shift+X.
  assert.equal(clipboardChord(down('v', { ctrlKey: true, shiftKey: true })), 'paste')
  assert.equal(clipboardChord(down('C', { ctrlKey: true, shiftKey: true })), 'copy')
})

test('AltGr is a character, not a shortcut', () => {
  // On Windows AltGr arrives as Control+Alt and still types something; the key
  // path sends that as text, so the clipboard must not claim it.
  assert.equal(clipboardChord(down('c', { ctrlKey: true, altKey: true })), undefined)
  assert.equal(clipboardChord(down('v', { ctrlKey: true, altKey: true })), undefined)
})

test('every other keystroke belongs to the mirror', () => {
  for (const event of [
    down('c'),
    down('v'),
    down('a', { ctrlKey: true }),
    down('k', { ctrlKey: true }),
    down('Enter', { ctrlKey: true }),
    down('中', { ctrlKey: true }),
    down('Control', { ctrlKey: true }),
  ]) {
    assert.equal(clipboardChord(event), undefined, JSON.stringify(event))
  }
})

test('a copy writes what the mirror reported, and a cut also deletes it', () => {
  assert.deepEqual(clipboardReply('copy', 'alpha beta'), { write: 'alpha beta', after: undefined })
  assert.deepEqual(clipboardReply('cut', 'alpha beta'), {
    write: 'alpha beta',
    after: { type: 'key', key: 'Delete' },
  })
})

test('copying nothing leaves the clipboard alone', () => {
  // The user's clipboard is not ours to clear: a browser's own copy with nothing
  // selected changes nothing, and neither does this.
  assert.deepEqual(clipboardReply('copy', ''), { write: undefined, after: undefined })
  assert.deepEqual(clipboardReply('cut', ''), { write: undefined, after: undefined })
})

test('a paste sends the text, and an empty clipboard sends nothing', () => {
  assert.deepEqual(pasteMessage('alpha beta'), { type: 'text', text: 'alpha beta' })
  assert.equal(pasteMessage(''), undefined)
})
