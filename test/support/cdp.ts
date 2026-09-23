/**
 * A CDP session that records instead of talking to a browser.
 *
 * Every browser-facing unit here takes a `CDPSession`, so a recorder is what
 * lets the mapping from a caller's intent to protocol calls be asserted without
 * starting Chrome. `emit` drives the event side the same way: it calls the
 * listeners the code under test registered.
 */
import type { CDPSession } from 'playwright-core'

/** One protocol call the code under test made. */
export interface RecordedCall {
  /** CDP method name, e.g. `Input.dispatchMouseEvent`. */
  readonly method: string
  /** Parameters, or `{}` when the call carried none. */
  readonly params: Record<string, unknown>
}

/** A recorder standing in for a CDP session. */
export interface FakeCdp {
  /** The session to hand to the code under test. */
  readonly session: CDPSession
  /** Every call made so far, in order. */
  readonly calls: RecordedCall[]
  /** Responses to return per method; a method absent here answers `{}`. */
  readonly answers: Map<string, unknown>
  /** Fail every call to this method with the given message. */
  failWith(method: string, message: string): void
  /**
   * Deliver a protocol event to listeners registered for it.
   * @param method - event name, e.g. `Page.screencastFrame`.
   * @param event - the event payload.
   */
  emit(method: string, event: unknown): void
  /** Calls to one method, for the assertions that only care about those. */
  method(name: string): RecordedCall[]
}

/**
 * Build a recording CDP session.
 * @returns the recorder and the session to pass to the code under test.
 */
export function fakeCdp(): FakeCdp {
  const calls: RecordedCall[] = []
  const answers = new Map<string, unknown>()
  const failures = new Map<string, string>()
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  const session = {
    send: async (method: string, params?: unknown): Promise<unknown> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const failure = failures.get(method)
      if (failure !== undefined) throw new Error(failure)
      return answers.get(method) ?? {}
    },
    on: (method: string, listener: (event: unknown) => void): void => {
      const registered = listeners.get(method) ?? []
      registered.push(listener)
      listeners.set(method, registered)
    },
    off: (method: string, listener: (event: unknown) => void): void => {
      const registered = listeners.get(method) ?? []
      listeners.set(method, registered.filter(candidate => candidate !== listener))
    },
  }
  return {
    session: session as unknown as CDPSession,
    calls,
    answers,
    failWith: (method, message) => { failures.set(method, message) },
    emit: (method, event) => {
      for (const listener of listeners.get(method) ?? []) listener(event)
    },
    method: name => calls.filter(call => call.method === name),
  }
}
