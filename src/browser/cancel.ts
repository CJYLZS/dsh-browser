/**
 * Cancelling one browser call.
 *
 * A tool call belongs to a conversation that can be interrupted, and the tool
 * registry keeps waiting for the promise a body returned rather than abandoning
 * it — so a body that waits on a browser which never answers is a call that
 * never finishes, and an interrupt cannot stop it. Measured 2026-09-25: a
 * `browser_navigate` to a stalled address never returned, outlived an interrupt
 * and a turn restart, and ended only when the browser was closed by hand.
 *
 * Cancelling therefore has to be two things at once. The call gives up as soon
 * as the caller's signal aborts, and the work it had started is stopped, not
 * left running behind it: a page that is still loading is told to stop, a script
 * that is still executing is terminated, and a browser that answers neither is
 * dropped so the next call starts a fresh one instead of inheriting a wedged
 * one. What the call would have reported is lost either way — a cancelled call
 * has no answer — but the browser is left usable and the conversation can move.
 */

/** Something that can be told to stop what it is doing. */
export interface Interruptible {
  /**
   * Stop what the browser is doing, so the next call does not inherit it.
   * @returns after the browser has reacted, or has been dropped for not answering.
   */
  interrupt(): Promise<void>
}

/**
 * Run one browser operation under the caller's cancellation.
 *
 * The operation starts only after the signal is being watched, so an abort that
 * happens while the call is being set up cannot be missed, and a call that was
 * cancelled before it started does not touch the browser at all beyond being
 * told to stop.
 * @param target - the browser the operation runs on.
 * @param signal - the caller's cancellation, when the caller has one.
 * @param what - the operation, named in the error a cancellation produces.
 * @param work - starts the operation; called at most once.
 * @returns what the operation produced.
 * @throws {Error} when the call was cancelled, or when the operation failed.
 */
export async function cancelable<T>(
  target: Interruptible,
  signal: AbortSignal | undefined,
  what: string,
  work: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return await work()
  if (signal.aborted) {
    await target.interrupt()
    throw new Error(cancelled(what))
  }
  let reject: (error: Error) => void = () => {}
  // The call settles on the signal even when the browser never answers; the
  // race attaches the handler that keeps this rejection from going unhandled.
  const stopped = new Promise<never>((_resolve, rejectIt) => { reject = rejectIt })
  const stop = (): void => { reject(new Error(cancelled(what))) }
  signal.addEventListener('abort', stop, { once: true })
  const started = work()
  // The race may leave this behind, and its failure is no longer the caller's:
  // an unhandled rejection here would end the host process.
  void started.catch(() => {})
  try {
    return await Promise.race([started, stopped])
  } catch (error) {
    // The work is stopped even when it failed on its own after a cancellation:
    // the caller gave up, and whatever the page is doing is not theirs any more.
    if (signal.aborted) await target.interrupt()
    throw error
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/**
 * What a cancelled call reports.
 * @param what - the operation that was cancelled.
 * @returns the message the caller sees.
 */
function cancelled(what: string): string {
  return `dsh-browser: ${what} was cancelled by the caller; the page was stopped, `
    + 'and the browser is free for the next call'
}
