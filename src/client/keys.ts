/**
 * What one keydown in the pane becomes on the wire.
 *
 * The decision lives here rather than in the canvas that listens, because it is
 * the one piece of the pane's input path with a right answer: whether a
 * keystroke is text, a chord, or nothing at all. It asks the host's own
 * vocabulary (`../browser/keys.ts`) before naming a chord, so the pane cannot
 * ask for something the host will refuse — a refusal comes back on the frame the
 * pane reserves for a browser in trouble, which is how pressing Ctrl once came
 * to look like a broken browser.
 */
import { isDispatchableKey } from '../browser/keys.ts'

/** The parts of a DOM key event this decision reads. */
export interface KeyEventLike {
  /** DOM `key` value. */
  readonly key: string
  /** Whether the platform's primary modifier is held. */
  readonly ctrlKey: boolean
  /** Whether Meta (Command on macOS) is held. */
  readonly metaKey: boolean
  /** Whether Alt is held. */
  readonly altKey: boolean
  /** Whether Shift is held. */
  readonly shiftKey: boolean
}

/** What one keydown becomes on the wire, or nothing at all. */
export type KeyMessage =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly key: string }
  | undefined

/**
 * The modifiers a key event is holding, spelled the way a chord writes them.
 * @param event - the key event.
 * @returns the modifier names, in the order a chord writes them.
 */
function modifiersOf(event: KeyEventLike): string[] {
  const held: string[] = []
  if (event.ctrlKey) held.push('Control')
  if (event.metaKey) held.push('Meta')
  if (event.altKey) held.push('Alt')
  if (event.shiftKey) held.push('Shift')
  return held
}

/**
 * Resolve one keydown into the message the viewer channel carries.
 *
 * AltGr arrives as Control+Alt on Windows and still produces a character — a
 * German or Polish layout types its symbols that way — so it goes as text;
 * sending it as a chord would swallow the character the user meant to type. A
 * chord is a keystroke, not text: sending Ctrl+A as the character "a" is what
 * this path used to do, and a page that selects everything on Ctrl+A had an "a"
 * typed into it instead. And a key that is only a modifier resolves to nothing,
 * because a chord writes its key last: pressing Ctrl starts a chord rather than
 * being one.
 *
 * @param event - the keydown to resolve.
 * @returns the text or chord to send, or undefined when this key is nothing the
 * page can be sent.
 */
export function keyMessage(event: KeyEventLike): KeyMessage {
  const altGraph = event.ctrlKey && event.altKey && event.key.length === 1
  if (event.key.length === 1 && (!(event.ctrlKey || event.metaKey || event.altKey) || altGraph)) {
    return { type: 'text', text: event.key }
  }
  const chord = [...modifiersOf(event), event.key].join('+')
  return isDispatchableKey(chord) ? { type: 'key', key: chord } : undefined
}
