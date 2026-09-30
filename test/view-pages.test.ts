/**
 * The page route: what the two asks a Sidebar tab makes do to the browser.
 *
 * The browser entry's pane asks for a page, and a closing tab asks for a close.
 * Neither is a rendering decision — whether a browser starts, whether a page is
 * added beside the ones already there, and what closing the last page means are
 * the host's to decide — so these tests drive the route's own handler with the
 * bodies the client sends and read what it answered.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserPool } from '../src/browser/pool.ts'
import { plainConfig, Config } from '../src/config.ts'
import { registerPages } from '../src/view/pages.ts'
import { fakeLauncher, type FakeLaunch } from './support/browser.ts'

/** A request body, as the client sends it. */
type Body = Record<string, unknown>

/** What the route wrote, as the client reads it. */
interface Answer {
  /** The status of the response. */
  readonly status: number
  /** The text it wrote, when it wrote one. */
  readonly text: string | undefined
}

/**
 * The JSON body the route wrote.
 * @param answer - what the route answered.
 * @returns the decoded body.
 */
function json(answer: Answer): unknown {
  assert.ok(answer.text !== undefined, 'the route wrote no body')
  return JSON.parse(answer.text) as unknown
}

/** The route as the webserver holds it. */
interface Route {
  readonly path: string
  handler: (request: unknown, response: unknown) => Promise<void>
}

/** The route plus the browser pool behind it. */
interface Harness {
  /** The registered route. */
  readonly route: Route
  /** The browsers every ask acts on. */
  readonly pool: BrowserPool
  /** The fake launcher's record of started browsers. */
  readonly launch: FakeLaunch
  /**
   * Send one body to the route.
   * @param body - the JSON body.
   * @param method - the HTTP method; `POST` unless given.
   * @returns what the route answered.
   */
  send(body: Body, method?: string): Promise<Answer>
  /** The pages the fixture session's browser holds. */
  tabs(): readonly { targetId?: string; active: boolean; url: string }[]
}

/**
 * Register the route on a context whose `inject` runs its callback, the way the
 * loader does once the services it names exist.
 * @param rejection - the status the connection's trust check answers, if any.
 * @returns the route and its pool.
 */
function registered(rejection?: number): Harness {
  const launch = fakeLauncher()
  const logger = { info: () => {}, warn: () => {} } as unknown as Context['logger']
  const pool = new BrowserPool(plainConfig(Config({})), logger, launch.launch, async () => true)
  const routes: Route[] = []
  const scoped = {
    webServer: { register: (route: Route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => rejection },
    effect: (install: () => unknown) => { install(); return () => {} },
  }
  const ctx = {
    inject: (_names: readonly string[], callback: (services: unknown) => void) => { callback(scoped) },
  } as unknown as Context
  registerPages(ctx, pool)
  const route = routes[0]
  assert.ok(route !== undefined, 'the route was never registered')
  return {
    route,
    pool,
    launch,
    tabs: () => pool.peek('session-a')?.status().tabs ?? [],
    async send(body, method = 'POST') {
      const chunks = [Buffer.from(JSON.stringify(body))]
      const request = {
        method,
        headers: {},
        async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
      }
      const answer: { status: number; text: string | undefined } = { status: 0, text: undefined }
      const response = {
        writeHead: (status: number) => { answer.status = status },
        end: (payload?: string) => { answer.text = payload },
      }
      await route.handler(request, response)
      return answer
    },
  }
}

test('a page ask starts the browser and answers with the page it made', async () => {
  const h = registered()
  const answer = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  assert.deepEqual(answer, { status: 200, text: JSON.stringify({ ok: true, targetId: 'target-0' }) })
  assert.equal(h.launch.browsers.length, 1)
  // A browser and its first page are one answer: the ask did not leave a blank
  // page beside the one it asked for.
  assert.equal(h.tabs().length, 1)
})

test('a second page ask adds a page to the browser already running', async () => {
  const h = registered()
  await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  const answer = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-2' })
  assert.deepEqual(answer, { status: 200, text: JSON.stringify({ ok: true, targetId: 'target-1' }) })
  assert.deepEqual(h.tabs().map(tab => tab.active), [false, true], 'the page the user asked for is the one they see')
})

test('one tab asking twice is one page, and a page that is gone is asked for again', async () => {
  const h = registered()
  const first = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  const again = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  assert.deepEqual(json(again), json(first), 'a remounted pane opened a second page')
  await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-2' })
  const targetId = (json(first) as { targetId: string }).targetId
  await h.send({ action: 'close', sessionId: 'session-a', targetId })
  const after = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  assert.notDeepEqual(json(after), json(first), 'the record kept pointing at a page that is gone')
})

test('a close closes one page, and the last page stops the browser', async () => {
  const h = registered()
  await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  const second = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-2' })
  const targetId = (json(second) as { targetId: string }).targetId
  const closed = await h.send({ action: 'close', sessionId: 'session-a', targetId })
  assert.deepEqual(json(closed), { ok: true })
  assert.equal(h.tabs().length, 1)
  const last = h.tabs()[0]
  assert.ok(last?.targetId !== undefined)
  await h.send({ action: 'close', sessionId: 'session-a', targetId: last.targetId })
  assert.equal(h.launch.browsers[0]?.closed, true, 'closing the last page did not stop the browser')
})

test('a close that names no action is the body the shipped client always sent', async () => {
  const h = registered()
  await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-2' })
  const targetId = h.tabs()[1]?.targetId
  assert.ok(targetId !== undefined)
  const answer = await h.send({ sessionId: 'session-a', targetId })
  assert.deepEqual(json(answer), { ok: true })
  assert.equal(h.tabs().length, 1)
})

test('an ask that names neither a page to open nor one to close answers no', async () => {
  const h = registered()
  assert.deepEqual(json(await h.send({ sessionId: 'session-a' })), { ok: false })
  assert.deepEqual(json(await h.send({ action: 'close', sessionId: 'session-a' })), { ok: false })
  assert.deepEqual(json(await h.send({ action: 'open', sessionId: '' })), { ok: false })
  assert.equal(h.launch.browsers.length, 0, 'a body that named nothing started a browser')
})

test('a close for a browser that does not exist reports no page closed', async () => {
  const h = registered()
  const answer = await h.send({ action: 'close', sessionId: 'session-a', targetId: 'target-0' })
  assert.deepEqual(json(answer), { ok: false })
  assert.equal(h.launch.browsers.length, 0, 'a close started a browser')
})

test('the route refuses a method it does not serve', async () => {
  const h = registered()
  const answer = await h.send({ action: 'open', sessionId: 'session-a' }, 'GET')
  assert.deepEqual(answer, { status: 405, text: 'Method Not Allowed' })
})

test('the route carries the connection trust check', async () => {
  const h = registered(403)
  const answer = await h.send({ action: 'open', sessionId: 'session-a', request: 'tab-1' })
  assert.deepEqual(answer, { status: 403, text: 'Forbidden' })
  assert.equal(h.launch.browsers.length, 0, 'an untrusted ask reached the pool')
})
