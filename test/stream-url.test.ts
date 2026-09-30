/**
 * Where the viewer socket dials.
 *
 * The address is the contract behind a blank pane: a Web page and the Host that
 * serves it share one origin, while a Desktop window is a `dsh-app://app`
 * document that only reaches its Host through the published transport origin.
 * Dialing the document's own host there produces `ws://app/…`, which no Host
 * ever answers.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { hostOrigin, streamUrl } from '../src/client/stream-url.ts'

/**
 * Serve the page from one document origin.
 * @param origin - what `location.origin` answers, e.g. `dsh-app://app`.
 */
function servedFrom(origin: string): void {
  Object.defineProperty(globalThis, 'location', { value: { origin }, configurable: true })
}

/**
 * Publish the shell's transport descriptor, or take it away.
 * @param base - Host HTTP origin the shell names, or `undefined` for a shell that names none.
 */
function transportNames(base?: string): void {
  if (base === undefined) {
    Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__')
    return
  }
  Object.defineProperty(globalThis, '__DSH_TRANSPORT__', { value: { streamBaseUrl: base }, configurable: true })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'location')
  Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__')
})

test('a Web page dials its own origin, which is the Host that serves it', () => {
  servedFrom('http://127.0.0.1:3080')
  transportNames(undefined)
  assert.equal(hostOrigin(), 'http://127.0.0.1:3080')
  assert.equal(
    streamUrl('/dsh-browser/stream', { session: 'session-a' }),
    'ws://127.0.0.1:3080/dsh-browser/stream?session=session-a',
  )
})

test('a Desktop document dials the Host origin the shell published, not its own scheme', () => {
  servedFrom('dsh-app://app')
  transportNames('http://127.0.0.1:43210')
  assert.equal(hostOrigin(), 'http://127.0.0.1:43210')
  assert.equal(
    streamUrl('/dsh-browser/stream', { session: 'session-a', page: 'target-7' }),
    'ws://127.0.0.1:43210/dsh-browser/stream?session=session-a&page=target-7',
  )
})

test('a secure Host dials wss on the transport origin', () => {
  servedFrom('https://harness.example')
  transportNames('https://harness.example')
  assert.equal(streamUrl('/dsh-browser/stream', {}), 'wss://harness.example/dsh-browser/stream')
})
