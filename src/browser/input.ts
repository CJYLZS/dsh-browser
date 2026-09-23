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
      const named = NAMED_KEYS[message.key]
      if (named === undefined) {
        throw new Error(`dsh-browser: "${message.key}" is not a dispatchable key; send text through the text message`)
      }
      const base = {
        key: message.key,
        code: named.code,
        windowsVirtualKeyCode: named.keyCode,
        nativeVirtualKeyCode: named.keyCode,
      }
      await session.send('Input.dispatchKeyEvent', {
        ...base,
        type: named.text === undefined ? 'rawKeyDown' : 'keyDown',
        ...named.text === undefined ? {} : { text: named.text },
      })
      await session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      return
    }
  }
}
