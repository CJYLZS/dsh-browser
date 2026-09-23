/**
 * Mirror the page as JPEG frames over one CDP session.
 *
 * Two measured behaviours decide this module's shape:
 *
 * - A frame must be acknowledged with `Page.screencastFrameAck`; Chrome stops
 *   sending after an unacknowledged frame.
 * - The stream is repaint-driven, so a page that never changes produces almost
 *   no frames. Viewers keep the last frame on screen rather than treating the
 *   gap as an error.
 */
import type { CDPSession } from 'playwright-core'

/** Encoding settings for the mirrored stream. */
export interface ScreencastOptions {
  /** JPEG quality, 1-100. */
  readonly quality: number
  /** Longest frame edge in device pixels. */
  readonly maxWidth: number
  /** Tallest frame edge in device pixels. */
  readonly maxHeight: number
  /** Mirror every Nth composited frame. */
  readonly everyNthFrame: number
}

/** One mirrored frame, decoded from CDP's base64 payload. */
export interface MirrorFrame {
  /** Encoded JPEG bytes, sent to viewers unchanged. */
  readonly jpeg: Buffer
  /** Page width the frame was captured at, in device pixels. */
  readonly deviceWidth: number
  /** Page height the frame was captured at, in device pixels. */
  readonly deviceHeight: number
}

/** What the CDP frame event carries. */
interface ScreencastFrameEvent {
  readonly data: string
  readonly sessionId: number
  readonly metadata?: { readonly deviceWidth?: number; readonly deviceHeight?: number }
}

/**
 * Begin mirroring a page.
 *
 * The returned stopper removes this module's listener before asking Chrome to
 * stop, so a frame arriving during teardown cannot be counted or forwarded.
 * @param session - CDP session attached to the mirrored page.
 * @param options - encoding settings.
 * @param onFrame - receives every acknowledged frame.
 * @param onError - receives acknowledgement failures, which otherwise stop the stream silently.
 * @returns the stopper for this stream.
 */
export async function startScreencast(
  session: CDPSession,
  options: ScreencastOptions,
  onFrame: (frame: MirrorFrame) => void,
  onError: (error: unknown) => void,
): Promise<() => Promise<void>> {
  const handler = (event: ScreencastFrameEvent): void => {
    // The ack races the frame's use on purpose: Chrome only needs it before the
    // next frame is produced, and viewers must not wait on a round trip.
    session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(onError)
    onFrame({
      jpeg: Buffer.from(event.data, 'base64'),
      deviceWidth: event.metadata?.deviceWidth ?? 0,
      deviceHeight: event.metadata?.deviceHeight ?? 0,
    })
  }
  session.on('Page.screencastFrame', handler as never)
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: options.quality,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    everyNthFrame: options.everyNthFrame,
  })
  return async () => {
    session.off('Page.screencastFrame', handler as never)
    await session.send('Page.stopScreencast')
  }
}
