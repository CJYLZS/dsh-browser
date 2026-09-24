/**
 * The pane's own clipboard: which keystroke is a copy, a cut or a paste, and
 * what the pane does with it once the mirror answers.
 *
 * The mirrored page can never receive one of these keystrokes. Chromium runs the
 * clipboard shortcuts in the **browser process**, and an injected key event does
 * not get there: measured against this plugin's own browser, `Ctrl+C`, `Ctrl+V`
 * and `Ctrl+X` produce no DOM `keydown` at all in the page, while `Ctrl+A`,
 * `Ctrl+K` and `Ctrl+Z` arrive normally. CDP's `commands` field runs editing
 * commands but not the clipboard ones, even with the clipboard permission
 * granted to the page.
 *
 * The pane, on the other hand, runs in the browser the *user* is in: the same
 * keystroke there is a trusted event with the system clipboard one Web API away.
 * That is where every browser-based remote desktop puts this, and the decisions
 * with a right answer live here so they can be tested without a browser:
 * VS Code's web clipboard writes with `navigator.clipboard` and falls back to a
 * hidden textarea plus `execCommand('copy')`; xterm.js terminals read
 * `navigator.clipboard.readText()` on the paste shortcut; Guacamole's rule for
 * its own bridge is that it must never disturb the clipboard unless the local
 * one actually changed, which is what {@link clipboardReply} keeps.
 */
import type { KeyMessage } from './keys.ts'

/** The parts of a DOM key event this decision is given. */
export interface ChordEventLike {
  /** DOM `key` value. */
  readonly key: string
  /** Whether the platform's primary modifier is held. */
  readonly ctrlKey: boolean
  /** Whether Meta (Command on macOS) is held. */
  readonly metaKey: boolean
  /** Whether Alt is held. */
  readonly altKey: boolean
  /** Whether Shift is held. Read by nothing here: it takes no shortcut away. */
  readonly shiftKey: boolean
}

/** What a keystroke asks the pane's clipboard to do. */
export type ClipboardChord = 'copy' | 'cut' | 'paste'

/** The chords that read the mirror's selection before doing anything. */
export type ReadingChord = Exclude<ClipboardChord, 'paste'>

/**
 * Whether this keystroke is one of the clipboard shortcuts the pane owns.
 *
 * Alt disqualifies it: on Windows AltGr arrives as Control+Alt and still types a
 * character, and the pane's own key path sends that as text. Shift does not:
 * `Control+Shift+V` is a browser's paste-as-plain-text, which is exactly what the
 * mirror's paste is, and nothing here claims Shift+C or Shift+X.
 * @param event - the keydown to classify.
 * @returns the chord to handle, or undefined when the key belongs to the mirror.
 */
export function clipboardChord(event: ChordEventLike): ClipboardChord | undefined {
  if (event.altKey) return undefined
  if (!event.ctrlKey && !event.metaKey) return undefined
  switch (event.key.toLowerCase()) {
    case 'c': return 'copy'
    case 'x': return 'cut'
    case 'v': return 'paste'
    default: return undefined
  }
}

/** What the pane does once the mirror has reported its selection. */
export interface ClipboardReply {
  /** The text to put on the clipboard, or undefined when there is nothing to copy. */
  readonly write: string | undefined
  /** The input message to send after a cut, or undefined when nothing was cut. */
  readonly after: KeyMessage | undefined
}

/**
 * What a copy or a cut does with the text the mirror reported.
 *
 * An empty selection writes nothing: a browser's own copy with nothing selected
 * leaves the clipboard as it was, and overwriting it with "" would be the pane
 * clobbering a clipboard the user did not ask it to touch. A cut that did have
 * something deletes it in the mirror, which is the whole difference between the
 * two chords.
 * @param chord - the reading chord that was pressed.
 * @param text - the selection the mirror reported.
 * @returns the clipboard write and, for a cut, the delete that follows it.
 */
export function clipboardReply(chord: ReadingChord, text: string): ClipboardReply {
  if (text === '') return { write: undefined, after: undefined }
  return { write: text, ...chord === 'cut' ? { after: { type: 'key', key: 'Delete' } } : { after: undefined } }
}

/**
 * What a paste sends the mirror, if anything.
 *
 * An empty clipboard sends nothing: `Input.insertText` with "" would be a
 * keystroke the page never saw, and there is nothing to insert anyway.
 * @param text - the clipboard text the pane read.
 * @returns the text input message, or undefined when there is nothing to paste.
 */
export function pasteMessage(text: string): KeyMessage {
  return text === '' ? undefined : { type: 'text', text }
}
