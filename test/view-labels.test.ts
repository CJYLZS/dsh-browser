/**
 * What the pages that list browsers call a session.
 *
 * A session id is hexadecimal that means nothing to the person reading the
 * settings page, so the report carries the session's title. These tests pin the
 * three things that make the difference between a name and a leak: which
 * service is asked first, that a composition mounting none still answers, and
 * that the answer is cached because the route is polled.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLabels } from '../src/view/labels.ts'

/**
 * A context whose optional services are whatever a case mounted.
 * @param services - the service names and their faces.
 * @returns the context.
 */
function contextWith(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
  } as unknown as Context
}

/** A clock that only moves when a test moves it. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

test('a live session is named by the title service', async () => {
  const live = { id: 'session-a' }
  const ctx = contextWith({
    sessions: { get: () => live },
    sessionTitle: { get: () => ({ title: '  Release checklist  ' }) },
  })
  assert.equal(await new SessionLabels(ctx).titleOf('session-a'), 'Release checklist')
})

test('a session the process does not have open is still named, from its log', async () => {
  // The case that matters: a browser outlives the conversation view that
  // started it, so the settings page must name sessions the live store lacks.
  const asked: string[] = []
  const ctx = contextWith({
    sessionQuery: {
      readTitle: async (sessionId: string) => {
        asked.push(sessionId)
        return { title: 'Cold but known' }
      },
    },
    sessions: { get: () => undefined },
  })
  assert.equal(await new SessionLabels(ctx).titleOf('session-cold'), 'Cold but known')
  assert.deepEqual(asked, ['session-cold'])
})

test('the log read is asked first, and the live fold only fills in', async () => {
  const order: string[] = []
  const ctx = contextWith({
    sessionQuery: {
      readTitle: async () => {
        order.push('query')
        return undefined
      },
    },
    sessions: { get: () => ({ id: 'session-a' }) },
    sessionTitle: {
      get: () => {
        order.push('title')
        return { title: 'Second source' }
      },
    },
  })
  assert.equal(await new SessionLabels(ctx).titleOf('session-a'), 'Second source')
  assert.deepEqual(order, ['query', 'title'])
})

test('a session with no title is unnamed rather than named by its id', async () => {
  const ctx = contextWith({
    sessionQuery: { readTitle: async () => undefined },
  })
  assert.equal(await new SessionLabels(ctx).titleOf('session-quiet'), undefined)
})

test('a composition with no title service names nothing, and does not throw', async () => {
  assert.equal(await new SessionLabels(contextWith({})).titleOf('session-a'), undefined)
})

test('a read that failed is tried again, and one that found no title is not', async () => {
  let calls = 0
  const time = clock()
  const ctx = contextWith({
    sessionQuery: {
      readTitle: async () => {
        calls += 1
        if (calls === 1) throw new Error('the log is locked')
        return { title: 'Recovered' }
      },
    },
  })
  const labels = new SessionLabels(ctx, time.now)
  assert.equal(await labels.titleOf('session-a'), undefined)
  assert.equal(await labels.titleOf('session-a'), 'Recovered', 'a failed read was cached as an answer')
})

test('a title is cached until it is old enough to be worth re-reading', async () => {
  let calls = 0
  const time = clock()
  const ctx = contextWith({
    sessionQuery: {
      readTitle: async () => {
        calls += 1
        return { title: `title ${String(calls)}` }
      },
    },
  })
  const labels = new SessionLabels(ctx, time.now)
  assert.equal(await labels.titleOf('session-a'), 'title 1')
  // The route is polled every 1.5 s; a title is durable state, so a poll that
  // learned nothing must not fold the log again.
  time.advance(2_000)
  assert.equal(await labels.titleOf('session-a'), 'title 1')
  assert.equal(calls, 1)
  time.advance(4_000)
  assert.equal(await labels.titleOf('session-a'), 'title 2')
  assert.equal(calls, 2)
})

test('a rename is picked up once the cached title is old enough', async () => {
  let title = 'Before'
  const ctx = contextWith({ sessionQuery: { readTitle: async () => ({ title }) } })
  const time = clock()
  const labels = new SessionLabels(ctx, time.now)
  assert.equal(await labels.titleOf('session-a'), 'Before')
  title = 'After'
  time.advance(6_000)
  assert.equal(await labels.titleOf('session-a'), 'After')
})
