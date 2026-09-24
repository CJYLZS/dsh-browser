/**
 * The keyboard vocabulary the viewer channel speaks.
 *
 * A key is either a named key the page must receive as a key event (Enter, Tab,
 * the arrows, the editing keys) or a single character; modifiers may be joined
 * to either with `+`, because a page that only reacts to a keyboard shortcut
 * reacts to nothing else — a site that opens its command palette on Ctrl+K, or
 * a form that submits on Cmd+Enter, is unreachable without one. A character
 * pressed with a modifier that suppresses text is sent as a raw key with no
 * text, which is what a real keyboard sends, and a letter is pressed as the case
 * Shift gives it.
 *
 * This table is read by both halves: the host dispatches what `parseKeyStroke`
 * resolves, and the pane asks `isDispatchableKey` before it sends anything. The
 * pane keeping its own copy of the key names is exactly how a lone Ctrl came to
 * be sent as `Control+Control` — refused by the host, and shown in the pane as a
 * browser failure.
 */

/** A named key the page receives as a key event rather than as inserted text. */
interface NamedKey {
  /** DOM `code` value. */
  readonly code: string
  /** Windows virtual key code CDP expects. */
  readonly keyCode: number
  /** Text the key produces, when it produces one. */
  readonly text?: string
}

/** Keys worth dispatching as key events; anything else printable goes through `insertText`. */
const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
}

/**
 * The modifiers a chord may name, as the bit field CDP takes.
 *
 * The aliases are the ones a keyboard and the platform APIs give the same four
 * keys, so a chord written either way presses the same thing.
 */
const MODIFIERS: Readonly<Record<string, number>> = {
  Alt: 1,
  Option: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Cmd: 4,
  Shift: 8,
}

/** How to spell the modifiers in a message about them. */
const MODIFIER_NAMES = 'Control, Meta, Alt, Shift'

/** Shift, as the bit field spells it. */
const SHIFT = 8

/** Modifiers that stop the key from producing text, as a browser does. */
const SUPPRESSES_TEXT = 1 | 2 | 4

/** One key press, resolved into what the protocol is told. */
export interface KeyStroke {
  /** DOM `key` value. */
  readonly key: string
  /** DOM `code` value, when the key has one. */
  readonly code: string | undefined
  /** Windows virtual key code, when the key has one. */
  readonly keyCode: number | undefined
  /** Text the press produces, absent when it produces none. */
  readonly text: string | undefined
  /** The modifiers held while it is pressed. */
  readonly modifiers: number
}

/**
 * One character pressed as a key.
 *
 * Only a letter's case follows Shift, because only a letter's case is the same
 * on every keyboard: `Shift+1` is `!` on a US layout and something else on the
 * next one, so a character that is not a letter is pressed as it is written and
 * typing it as text is the caller's job.
 * @param token - the character the chord named.
 * @param modifiers - the modifiers held.
 * @returns the resolved press.
 */
function characterStroke(token: string, modifiers: number): KeyStroke {
  const letter = /^[a-z]$/iu.test(token)
  const digit = /^[0-9]$/u.test(token)
  const upper = token.toUpperCase()
  const key = letter ? ((modifiers & SHIFT) === 0 ? token.toLowerCase() : upper) : token
  const code = letter ? `Key${upper}` : digit ? `Digit${token}` : token === ' ' ? 'Space' : undefined
  const keyCode = letter ? upper.charCodeAt(0) : digit ? 48 + Number(token) : token === ' ' ? 32 : undefined
  const text = (modifiers & SUPPRESSES_TEXT) === 0 ? key : undefined
  return { key, code, keyCode, text, modifiers }
}

/**
 * Resolve one chord into the press it describes.
 *
 * @param chord - a key name, a single character, or modifiers joined to either
 * with `+`.
 * @returns what to dispatch.
 * @throws {Error} when the chord names no key, an unknown modifier, or a key
 * that has no dispatch mapping.
 */
export function parseKeyStroke(chord: string): KeyStroke {
  const tokens = chord.split('+')
  const named = tokens.slice(0, -1)
  const last = tokens.at(-1) ?? ''
  let modifiers = 0
  for (const token of named) {
    const bit = MODIFIERS[token]
    if (bit === undefined) {
      throw new Error(
        `dsh-browser: "${token}" is not a modifier; use one of ${MODIFIER_NAMES}, `
        + `joined to the key with "+", such as "Control+A"`,
      )
    }
    modifiers |= bit
  }
  if (MODIFIERS[last] !== undefined && named.length > 0) {
    throw new Error(
      `dsh-browser: "${chord}" names no key after its modifiers; write the key last, such as "Control+A"`,
    )
  }
  if (MODIFIERS[last] !== undefined) {
    throw new Error(
      `dsh-browser: "${chord}" is a modifier with no key after it; write the key last, such as "Control+A"`,
    )
  }
  if (last === '') {
    throw new Error(
      `dsh-browser: "${chord}" names no key after its modifiers; write the key last, such as "Control+A"`,
    )
  }
  const key = NAMED_KEYS[last]
  if (key !== undefined) {
    const text = (modifiers & SUPPRESSES_TEXT) === 0 ? key.text : undefined
    return { key: last, code: key.code, keyCode: key.keyCode, text, modifiers }
  }
  if ([...last].length === 1) return characterStroke(last, modifiers)
  throw new Error(
    `dsh-browser: "${chord}" is not a dispatchable key; send a single character, `
    + 'or text through the text message',
  )
}

/**
 * Whether the host would dispatch this chord.
 *
 * The pane asks before it sends, and it must ask here rather than of its own
 * table: a chord the host refuses comes back on the same error frame the pane
 * uses for a browser in trouble, so a pane that guesses turns an ordinary
 * keypress — a lone modifier, a key this table does not carry — into a UI
 * failure. One table, one answer.
 * @param chord - a key name, a single character, or modifiers joined to either.
 * @returns true when `parseKeyStroke` resolves it, false when it would refuse.
 */
export function isDispatchableKey(chord: string): boolean {
  try {
    parseKeyStroke(chord)
    return true
  } catch {
    return false
  }
}
