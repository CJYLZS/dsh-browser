/**
 * The viewer transport: what a socket that names a session — and, now, a page —
 * is sent, and what its messages act on.
 *
 * One sidebar tab per browser page means a viewer is bound to a page, not to
 * whichever page the tools act on: its frames, its address, its input, and its
 * close all belong to the page it named. These tests drive `attach` over a
 * recording socket, so what they assert is what crossed the wire.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSocket } from 'ws'
import { BrowserPool } from '../src/browser/pool.ts'
import { plainConfig, Config, type BrowserConfig } from '../src/config.ts'
import { attach } from '../src/view/server.ts'
import { fakeLauncher, type FakeLaunch } from './support/browser.ts'

/** One frame's worth of payload, as Chrome sends it. */
const FRAME = { data: Buffer.from('jpeg').toString('base64'), sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }

/** A pool over a fake launcher, ready to start. */
function poolWith(config: Partial<BrowserConfig> = {}): { pool: BrowserPool; launch: FakeLaunch } {
  const launch = fakeLauncher()
  const logger = { info: () => {}, warn: () => {} } as unknown as Context['logger']
  const pool = new BrowserPool(plainConfig(Config(config)), logger, launch.launch, async () => true)
  return { pool, launch }
}

/** A socket that records what crossed it, as the route's only client. */
class FakeSocket {
  /** The constants a real WebSocket carries, which the route's guards read. */
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = 1
  readonly sent: (string | Buffer)[] = []
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...this.handlers.get(event) ?? [], listener])
  }

  close(): void {
    this.readyState = 3
    for (const listener of this.handlers.get('close') ?? []) listener()
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args)
  }

  /** The JSON messages, decoded. */
  messages(): { type?: string; status?: { state?: string; url?: string }; message?: string }[] {
    return this.sent
      .filter((data): data is string => typeof data === 'string')
      .map(data => JSON.parse(data) as { type?: string; status?: { state?: string; url?: string }; message?: string })
  }

  /** The binary frames. */
  frames(): Buffer[] {
    return this.sent.filter((data): data is Buffer => typeof data !== 'string')
  }
}

test('a viewer that names a page is sent that page frames and address', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const socket = new FakeSocket()
  await attach(socket as unknown as WebSocket, pool, 'session-a', 'target-1')
  const statuses = socket.messages().filter(message => message.type === 'status')
  assert.equal(statuses.at(-1)?.status?.url, 'https://example.test/new', 'the address the pane shows is its own page’s')
  opened.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(socket.frames().length, 1)
  assert.equal(
    launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0,
    0,
    'the page nobody named is not being mirrored for this viewer',
  )
})

test('a viewer whose page is gone is told and the socket closes', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  const socket = new FakeSocket()
  // A target id the browser has never heard of: the tab list the client read
  // was already out of date.
  await attach(socket as unknown as WebSocket, pool, 'session-a', 'target-9')
  const refusal = socket.messages().find(message => message.type === 'error')
  assert.match(String(refusal?.message), /has no page target-9/)
  assert.equal(socket.readyState, 3, 'a viewer with nothing to watch is not kept open')
})

test('a viewer that names no page watches the active page, as before', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  const socket = new FakeSocket()
  await attach(socket as unknown as WebSocket, pool, 'session-a')
  await until(() => socket.messages().filter(message => message.type === 'status').at(-1)?.status?.url === 'about:blank', 'the opening status')
  launch.browsers[0]?.pages[0]?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(socket.frames().length, 1)
})

/**
 * Wait until a condition holds, so an assertion does not race a `void`ed
 * asynchronous path.
 * @param condition - the predicate to wait on.
 * @param what - description used in the failure message.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('input from a viewer that named a page reaches that page', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const socket = new FakeSocket()
  await attach(socket as unknown as WebSocket, pool, 'session-a', 'target-1')
  socket.emit('message', JSON.stringify({ type: 'input', message: { type: 'mouse', action: 'down', x: 0.5, y: 0.5 } }), false)
  await new Promise(resolve => { setImmediate(resolve) })
  await new Promise(resolve => { setImmediate(resolve) })
  assert.ok(opened.cdp.method('Input.dispatchMouseEvent').length > 0, 'the named page got the press')
})

test('closing over the socket is the page closing, not the browser stopping', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const socket = new FakeSocket()
  await attach(socket as unknown as WebSocket, pool, 'session-a', 'target-1')
  socket.emit('message', JSON.stringify({ type: 'close' }), false)
  await new Promise(resolve => { setImmediate(resolve) })
  await new Promise(resolve => { setImmediate(resolve) })
  assert.equal(opened.closed, true, 'the page the viewer named is the page that closed')
  assert.equal(launch.browsers[0]?.closed, false, 'the browser outlives one of its pages')
})
