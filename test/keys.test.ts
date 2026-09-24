/**
 * The keyboard vocabulary both halves speak.
 *
 * `isDispatchableKey` is the pane's half of this table: the pane asks it before
 * a keystroke leaves the browser, because a chord the host refuses comes back on
 * the frame the pane shows as a browser failure. The dispatch tests in
 * `input.test.ts` pin what an accepted chord becomes; these pin which chords are
 * accepted at all, since that is the line the two halves must agree on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDispatchableKey, parseKeyStroke } from '../src/browser/keys.ts'

test('a chord of modifiers and one key is dispatchable', () => {
  for (const chord of ['Control+A', 'Meta+Enter', 'Shift+Tab', 'Alt+ArrowLeft', 'Control+Shift+A']) {
    assert.equal(isDispatchableKey(chord), true, chord)
  }
})

test('a named key and a single character are dispatchable on their own', () => {
  for (const chord of ['Enter', 'Escape', 'ArrowDown', 'Home', 'a', 'A', '中', ' ']) {
    assert.equal(isDispatchableKey(chord), true, chord)
  }
})

test('a modifier with no key after it is not', () => {
  // Both spellings the pane could produce for a lone modifier key: the bare name
  // and the double one a naive "modifiers + key" join makes of it.
  for (const chord of ['Control', 'Control+Control', 'Meta+Meta', 'Shift+Shift', 'Alt+Alt', 'Control+Shift']) {
    assert.equal(isDispatchableKey(chord), false, chord)
  }
})

test('a key the table does not carry is not', () => {
  assert.equal(isDispatchableKey('F5'), false)
  assert.equal(isDispatchableKey('Control+F5'), false)
  assert.equal(isDispatchableKey('Insert'), false)
  assert.equal(isDispatchableKey(''), false)
  assert.equal(isDispatchableKey('Control+'), false)
})

test('an unknown modifier is not', () => {
  assert.equal(isDispatchableKey('Hyper+a'), false)
  assert.equal(isDispatchableKey('Hyper+Enter'), false)
})

test('the verdict is the parser throwing, not a second table', () => {
  // The two must not drift: whatever the pane sends has to be what the host
  // dispatches, so the only acceptable disagreement is none at all.
  for (const chord of ['Control+A', 'Control+Control', 'F5', 'Shift+a', 'Enter', '']) {
    assert.equal(isDispatchableKey(chord), resolves(chord), chord)
  }
})

/**
 * Whether the parser resolves a chord.
 * @param chord - the chord to test.
 * @returns true when `parseKeyStroke` returns instead of throwing.
 */
function resolves(chord: string): boolean {
  try {
    parseKeyStroke(chord)
    return true
  } catch {
    return false
  }
}
