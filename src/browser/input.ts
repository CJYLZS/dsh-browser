/**
 * Turn viewer input into CDP dispatch calls on the mirrored page.
 *
 * Coordinates arrive normalised by the viewer (`0..1` of the frame), so the
 * mirror never needs the page's pixel size and resizing the Sidebar cannot
 * shift a click.
 *
 * Printable characters arrive as text and go through `Input.insertText`, which
 * is what makes non-Latin input work without a keycode table; named keys the
 * page must see as keys (Enter, Tab, arrows, editing keys) are dispatched as
 * raw key events.
 *
 * A key may name a chord — `Control+A`, `Shift+Tab`, `Meta+Enter` — because a
 * page that only reacts to a keyboard shortcut reacts to nothing else: a site
 * that opens its command palette on Ctrl+K, or a form that submits on
 * Cmd+Enter, is unreachable without one. A character pressed with a modifier
 * that suppresses text is sent as a raw key with no text, which is what a real
 * keyboard sends, and a letter is pressed as the case Shift gives it.
 */
import type { CDPSession } from 'playwright-core'

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
interface KeyStroke {
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
function parseKeyStroke(chord: string): KeyStroke {
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

/** The mouse button a message names; CDP spells the neutral state `none`. */
export type MouseButton = 'left' | 'middle' | 'right'


/**
 * One viewer message.
 *
 * `x` and `y` are fractions of the frame, not pixels.
 */
export type InputMessage =
  | { readonly type: 'mouse'; readonly action: 'move' | 'down' | 'up'; readonly x: number; readonly y: number; readonly button?: MouseButton; readonly clickCount?: number }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly key: string }

/** The page's CSS viewport, which normalised coordinates are resolved against. */
export interface ViewportSize {
  /** Width in CSS pixels. */
  readonly width: number
  /** Height in CSS pixels. */
  readonly height: number
}

/**
 * Resolve a message's normalised position against the page's viewport.
 *
 * Viewers send fractions of the frame, so their own size never enters the
 * protocol; CDP takes CSS pixels. Messages without a position pass through
 * unchanged, since they carry nothing to scale — this is the whole of the
 * difference between a viewer's coordinates and the page's.
 * @param message - the decoded viewer message.
 * @param size - the page's CSS viewport.
 * @returns the message with pixel coordinates, or the same message.
 */
export function scaleToViewport(message: InputMessage, size: ViewportSize): InputMessage {
  switch (message.type) {
    case 'mouse': return { ...message, x: message.x * size.width, y: message.y * size.height }
    case 'wheel': return { ...message, x: message.x * size.width, y: message.y * size.height }
    default: return message
  }
}

/**
 * Apply one viewer message to the mirrored page.
 * @param session - CDP session attached to the mirrored page.
 * @param message - the decoded viewer message.
 * @throws {Error} when the message names a key with no dispatch mapping.
 */
export async function dispatchInput(session: CDPSession, message: InputMessage): Promise<void> {
  switch (message.type) {
    case 'mouse': {
      const button = message.action === 'move' ? 'none' : message.button ?? 'left'
      await session.send('Input.dispatchMouseEvent', {
        type: message.action === 'move' ? 'mouseMoved' : message.action === 'down' ? 'mousePressed' : 'mouseReleased',
        x: message.x,
        y: message.y,
        button,
        clickCount: message.action === 'move' ? 0 : message.clickCount ?? 1,
      })
      return
    }
    case 'wheel':
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: message.x,
        y: message.y,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
      })
      return
    case 'text':
      await session.send('Input.insertText', { text: message.text })
      return
    case 'key': {
      const stroke = parseKeyStroke(message.key)
      // A modifier of zero is left out rather than sent as zero: `modifiers` is
      // optional in the protocol, and a call that carries only what the caller
      // chose is the one an assertion about it can be read as a sentence.
      const base = {
        key: stroke.key,
        ...stroke.code === undefined ? {} : { code: stroke.code },
        ...stroke.keyCode === undefined
          ? {}
          : { windowsVirtualKeyCode: stroke.keyCode, nativeVirtualKeyCode: stroke.keyCode },
        ...stroke.modifiers === 0 ? {} : { modifiers: stroke.modifiers },
      }
      await session.send('Input.dispatchKeyEvent', {
        ...base,
        type: stroke.text === undefined ? 'rawKeyDown' : 'keyDown',
        ...stroke.text === undefined ? {} : { text: stroke.text },
      })
      await session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      return
    }
  }
}
