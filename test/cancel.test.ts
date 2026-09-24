/**
 * What a cancelled tool call does.
 *
 * The tool registry does not abandon the promise a tool body returned, so a body
 * that keeps waiting on a browser that never answers is a call that never
 * finishes — and a conversation that cannot be stopped. Measured 2026-09-25: a
 * `browser_navigate` that never returned survived both an interrupt and a
 * restart of the turn, and only closing the browser ended it. These tests hold
 * the contract that makes cancellation real: the call gives up, and what it
 * started is stopped rather than left running.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelable, type Interruptible } from '../src/browser/cancel.ts'

/** An operation that never settles, so only cancellation can end it. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** Wait for the timers and microtasks a cancellation goes through. */
async function settle(): Promise<void> {
  await new Promise(done => { setTimeout(done, 5) })
}

/**
 * A stand-in for the browser a call is cancelled against.
 * @returns the target, and the log of interruptions it was sent.
 */
function faked(): { readonly target: Interruptible; readonly interruptions: number[] } {
  const interruptions: number[] = []
  return {
    target: { async interrupt() { interruptions.push(interruptions.length + 1) } },
    interruptions,
  }
}

test('a cancelled call stops waiting and stops what it started', async () => {
  const fake = faked()
  const controller = new AbortController()
  const call = cancelable(fake.target, controller.signal, 'opening the page', never)
  controller.abort()
  await assert.rejects(call, /opening the page was cancelled/)
  assert.deepEqual(fake.interruptions, [1])
})

test('a call whose signal is already aborted never starts the work', async () => {
  const fake = faked()
  const controller = new AbortController()
  controller.abort()
  let started = false
  await assert.rejects(
    cancelable(fake.target, controller.signal, 'clicking e3', async () => {
      started = true
    }),
    /clicking e3 was cancelled/,
  )
  assert.equal(started, false, 'the work must not start for a call that was already cancelled')
})

test('a call with no signal runs the work and gives back what it produced', async () => {
  const fake = faked()
  assert.equal(await cancelable(fake.target, undefined, 'reading the page', async () => 'value'), 'value')
  assert.deepEqual(fake.interruptions, [])
})

test('a call that fails on its own is not interrupted', async () => {
  const fake = faked()
  const controller = new AbortController()
  await assert.rejects(
    cancelable(fake.target, controller.signal, 'reading the page', async () => {
      throw new Error('the page threw')
    }),
    /the page threw/,
  )
  assert.deepEqual(fake.interruptions, [])
})

test('work that fails after the call gave up does not become an unhandled rejection', async () => {
  const fake = faked()
  const controller = new AbortController()
  const seen: unknown[] = []
  const watch = (error: unknown): void => { seen.push(error) }
  process.on('unhandledRejection', watch)
  try {
    let fail: (error: Error) => void = () => {}
    const call = cancelable(fake.target, controller.signal, 'opening the page', async () =>
      await new Promise<never>((_done, reject) => { fail = reject }))
    controller.abort()
    await assert.rejects(call, /opening the page was cancelled/)
    // The browser answers long after the call is gone; nobody is waiting for it
    // any more, and that must not surface as an unhandled rejection.
    fail(new Error('the navigation timed out'))
    await settle()
    assert.deepEqual(seen, [])
    assert.deepEqual(fake.interruptions, [1])
  } finally {
    process.off('unhandledRejection', watch)
  }
})
