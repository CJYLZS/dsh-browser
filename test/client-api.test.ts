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
import { closeBrowserRequest, closePageRequest, openPageRequest, restartRoute } from '../src/client/api.ts'

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

test('closing a browser names the session rather than a page, and asks for all of it', async () => {
  // The settings page's control is about a conversation, not about the page the
  // user happens to be looking at, so the body carries no target id at all.
  const calls = recordingFetch({ body: { ok: true } })
  await closeBrowserRequest('session-a')
  assert.deepEqual(calls, [{
    url: '/dsh-browser/pages',
    body: { action: 'close', sessionId: 'session-a', all: true },
  }])
  // A refused close must not look like one that happened.
  recordingFetch({ status: 401 })
  await assert.rejects(() => closeBrowserRequest('session-a'), /HTTP 401/)
})

test('the restart control falls back to the page ask when there is no socket', () => {
  // The regression this exists for: watching never starts a browser, so after a
  // close from the settings page the host closes the socket. A message sent then
  // is dropped by send() in silence, and the one control that could bring the
  // browser back did nothing — exactly when it was needed.
  assert.deepEqual(restartRoute(false, 'tab-1'), { via: 'http' })
  // The page ask must carry a tab id, because that is what keeps a second click
  // from opening a second page; a pane that cannot name its tab has nothing to
  // ask with and must not pretend otherwise.
  assert.deepEqual(restartRoute(false, undefined), { via: 'none' })
  assert.deepEqual(restartRoute(false, ''), { via: 'none' })
})

test('a socket that is up carries the restart, because the host already holds it', () => {
  // Asking over HTTP while a viewer socket is live would open a page the pane
  // is not watching; the socket is the connection the host knows this pane by.
  assert.deepEqual(restartRoute(true, 'tab-1'), { via: 'socket' })
  assert.deepEqual(restartRoute(true, undefined), { via: 'socket' })
})

