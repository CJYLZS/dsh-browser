/**
 * A browser per session is what makes two conversations stop sharing tabs,
 * cookies, and a page. The pool is where that promise lives: which session owns
 * which browser, when one starts, and when it goes away again. These tests
 * drive it against the recording launcher, so every assertion is about the
 * pool's decisions rather than about Chrome.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserPool } from '../src/browser/pool.ts'
import { plainConfig, Config, type BrowserConfig } from '../src/config.ts'
import { fakeLauncher, type FakeLaunch } from './support/browser.ts'

/** A logger that keeps what it was told, so failures can be asserted. */
interface RecordingLog {
  /** The logger to hand to the pool. */
  readonly logger: Context['logger']
  /** Every warning and error message, in order. */
  readonly messages: string[]
}

/**
 * Build a recording logger.
 * @returns the logger and the messages it received.
 */
function recordingLog(): RecordingLog {
  const messages: string[] = []
  const record = (...args: unknown[]): void => {
    messages.push(args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '))
  }
  return {
    logger: { info: record, warn: record, error: record, debug: record } as unknown as Context['logger'],
    messages,
  }
}

/**
 * A pool over a fake launcher.
 * @param config - overrides on top of the schema defaults.
 * @param launched - the fake launcher to use, created when omitted.
 * @returns the pool and the launcher.
 */
function poolWith(config: Partial<BrowserConfig> = {}, launched?: FakeLaunch): { pool: BrowserPool; launch: FakeLaunch; log: RecordingLog } {
  const launch = launched ?? fakeLauncher()
  const log = recordingLog()
  const resolved = plainConfig(Config(config))
  const pool = new BrowserPool(resolved, log.logger, launch.launch, async () => true)
  return { pool, launch, log }
}

test('nothing starts until something asks for a browser', async () => {
  const { pool, launch } = poolWith()
  assert.equal(launch.browsers.length, 0)
  pool.get('session-a')
  assert.equal(launch.browsers.length, 0)
  await pool.get('session-a').ensure()
  assert.equal(launch.browsers.length, 1)
})

test('one session keeps one browser', async () => {
  const { pool, launch } = poolWith()
  const first = pool.get('session-a')
  await first.ensure()
  await pool.get('session-a').ensure()
  assert.equal(launch.browsers.length, 1)
  assert.equal(pool.get('session-a'), first)
})

test('two sessions get two browsers, two ports, and two profiles', async () => {
  const { pool, launch } = poolWith({ debugPort: 9400 })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  assert.equal(launch.browsers.length, 2)
  assert.equal(launch.browsers[0]?.config.debugPort, 9400)
  assert.equal(launch.browsers[1]?.config.debugPort, 9401)
  assert.notEqual(launch.browsers[0]?.profileDir, launch.browsers[1]?.profileDir)
})

test('a session in a directory profile gets its own subdirectory', async () => {
  const { pool, launch } = poolWith({ userDataDir: 'D:\\profiles' })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  const [first, second] = launch.browsers
  assert.match(String(first?.profileDir), /profiles[\\/]session-a$/)
  assert.match(String(second?.profileDir), /profiles[\\/]session-b$/)
})

test('one session cannot see another session\'s browser', async () => {
  const { pool } = poolWith()
  await pool.get('session-a').ensure()
  assert.equal(pool.peek('session-b'), undefined)
  assert.equal(pool.peek('session-a')?.status().sessionId, 'session-a')
})

test('reaching the instance limit fails loudly and leaves the others alone', async () => {
  const { pool, launch } = poolWith({ maxInstances: 2 })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  assert.throws(() => pool.get('session-c'), /2 session browsers.*maxInstances/s)
  assert.equal(launch.browsers.length, 2)
  assert.equal(pool.peek('session-c'), undefined)
})

test('a session that is disposed loses its browser and its port', async () => {
  const { pool, launch } = poolWith({ debugPort: 9400 })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  await pool.dispose('session-a')
  assert.equal(launch.browsers[0]?.closed, true)
  assert.equal(launch.browsers[1]?.closed, false)
  assert.equal(pool.peek('session-a'), undefined)
  // The port the closed browser held is free again for the next session.
  const { pool: next, launch: after } = poolWith({ debugPort: 9400 }, launch)
  await next.get('session-c').ensure()
  assert.equal(after.browsers[2]?.config.debugPort, 9400)
})

test('everything is closed when the plugin unloads', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  await pool.closeAll()
  assert.deepEqual(launch.browsers.map(browser => browser.closed), [true, true])
  assert.equal(pool.size, 0)
})

test('a browser that dies on its own is reported and replaced on the next request', async () => {
  const { pool, launch } = poolWith()
  const browser = pool.get('session-a')
  await browser.ensure()
  const closed = new Promise<void>((resolve) => {
    browser.watch(status => {
      if (status.state === 'closed') resolve()
    })
  })
  launch.browsers[0]?.die('the window was closed')
  await closed
  assert.equal(browser.status().state, 'closed')
  // Playwright reports a dead browser without saying why, so the reason is the
  // plugin's own sentence rather than the fake's.
  assert.match(String(browser.status().error), /closed or crashed/)
  assert.equal(browser.hasViewers(), false)
  await browser.ensure()
  assert.equal(launch.browsers.length, 2)
  assert.equal(browser.status().state, 'ready')
})

test('a launch field change restarts the browser it applies to', async () => {
  const { pool, launch } = poolWith({ debugPort: 9400 })
  await pool.get('session-a').ensure()
  await pool.reconfigure(plainConfig(Config({ debugPort: 9500 })))
  assert.equal(launch.browsers[0]?.closed, true)
  await pool.get('session-a').ensure()
  assert.equal(launch.browsers.length, 2)
  assert.equal(launch.browsers[1]?.config.debugPort, 9500)
})

test('an encoding change leaves the running browser alone', async () => {
  const { pool, launch } = poolWith()
  await pool.get('session-a').ensure()
  await pool.reconfigure(plainConfig(Config({ quality: 40 })))
  assert.equal(launch.browsers[0]?.closed, false)
  assert.equal(pool.get('session-a').status().state, 'ready')
})

test('the status report says what is running and what the limit is', async () => {
  const { pool } = poolWith({ maxInstances: 3 })
  await pool.get('session-a').ensure()
  const report = pool.status()
  assert.equal(report.maxInstances, 3)
  assert.deepEqual(report.instances.map(instance => instance.sessionId), ['session-a'])
  assert.equal(report.instances[0]?.state, 'ready')
  assert.equal(report.instances[0]?.debugPort, 9333)
})

test('a session id that cannot name a directory fails before a launch', () => {
  const { pool, launch } = poolWith({ userDataDir: 'D:\\profiles' })
  assert.throws(() => pool.get(''), /empty session id/)
  assert.equal(launch.browsers.length, 0)
})
