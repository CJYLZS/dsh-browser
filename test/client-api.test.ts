/**
 * What the client asks the host, and what it makes of the answer.
 *
 * A Sidebar tab makes two asks over plain POSTs — one for a page to hold, one to
 * close the page it mirrored — and each body is a contract with the host's
 * route: the action, the session, and the record asking. The route is tested on
 * its own side; what is asserted here is that this half sends what it documents
 * and reads the page id back.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { closePageRequest, openPageRequest } from '../src/client/api.ts'

/** The real fetch, restored after every test. */
const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

/**
 * Answer every request with one response, recording what was sent.
 * @param answer - the status and JSON body to answer with.
 * @returns the recorded requests.
 */
function recordingFetch(answer: { status?: number; body?: unknown }): { url: string; body: unknown }[] {
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown })
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
  }) as typeof fetch
  return calls
}

test('asking for a page names the tab that asked, and answers the page id', async () => {
  const calls = recordingFetch({ body: { ok: true, targetId: 'target-7' } })
  const targetId = await openPageRequest('session-a', 'tab-3')
  assert.deepEqual(calls, [{
    url: '/dsh-browser/pages',
    body: { action: 'open', sessionId: 'session-a', request: 'tab-3' },
  }])
  assert.equal(targetId, 'target-7')
})

test('an ask that names an address carries it, and one that names none leaves it out', async () => {
  const calls = recordingFetch({ body: { ok: true } })
  await openPageRequest('session-a', 'tab-3', 'https://example.test/two')
  assert.deepEqual(calls, [{
    url: '/dsh-browser/pages',
    body: {
      action: 'open',
      sessionId: 'session-a',
      request: 'tab-3',
      url: 'https://example.test/two',
    },
  }])
})

test('an answer that names no page is no id', async () => {
  recordingFetch({ body: { ok: true } })
  assert.equal(await openPageRequest('session-a', 'tab-3'), undefined)
})

test('a refused ask throws rather than reporting a page', async () => {
  recordingFetch({ status: 401 })
  await assert.rejects(() => openPageRequest('session-a', 'tab-3'), /HTTP 401/)
  await assert.rejects(() => closePageRequest('session-a', 'target-7'), /HTTP 401/)
})

test('closing a page names the page, not the tab that showed it', async () => {
  const calls = recordingFetch({ body: { ok: true } })
  await closePageRequest('session-a', 'target-7')
  assert.deepEqual(calls, [{
    url: '/dsh-browser/pages',
    body: { sessionId: 'session-a', targetId: 'target-7' },
  }])
})
