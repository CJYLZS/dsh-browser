/**
 * The workspace profile mode: one browser process serving several conversations.
 *
 * Everything here is a decision the mode exists to make, so these tests are
 * written against the visible consequences rather than the internals: one
 * process and one port, each conversation seeing only its own pages, refs that
 * do not collide, and a process that closes only when the last conversation
 * leaves. The isolation the other two modes promise is asserted beside it, since
 * the widening must not have leaked into them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { plainConfig, Config, type BrowserConfig } from '../src/config.ts'
import { BrowserPool } from '../src/browser/pool.ts'
import { chooseProfile } from '../src/browser/profile-choice.ts'
import { workspaceProfileDirFor } from '../src/browser/profile.ts'
import { workspaceProfileBase, type WorkspaceFacts } from '../src/browser/workspace.ts'
import { fakeLauncher, type FakeLaunch } from './support/browser.ts'

/** A silent logger. */
const logger = { info: () => {}, warn: () => {} } as unknown as Context['logger']

/** One workspace, in the shape the registry reports. */
const WORKSPACE: WorkspaceFacts = {
  id: 'workspace-1',
  path: 'D:\\project',
  sessionIds: ['session-a', 'session-b'],
}

/** Another workspace, with a session of its own. */
const OTHER: WorkspaceFacts = {
  id: 'workspace-2',
  path: 'D:\\other',
  sessionIds: ['session-c'],
}

/**
 * A workspace lookup over a fixed set, the way the registry answers.
 * @param workspaces - the workspaces that exist.
 * @returns the lookup the profile resolver takes.
 */
function lookupOf(workspaces: readonly WorkspaceFacts[]): (sessionId: string) => WorkspaceFacts | undefined {
  return sessionId => workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
}

/** A pool over a fake launcher, in workspace mode, with a registry behind it. */
function poolWith(
  config: Partial<BrowserConfig> = {},
  workspaces: readonly WorkspaceFacts[] = [WORKSPACE, OTHER],
): { pool: BrowserPool; launch: FakeLaunch } {
  const launch = fakeLauncher()
  const resolved = plainConfig(Config({ profileMode: 'workspace', ...config }))
  // The pool resolves workspaces through its own profile resolver, which reads
  // the plugin context's registry; this is the same seam with a fixed table.
  const pool = new BrowserPool(resolved, logger, launch.launch, async () => true, undefined, lookupOf(workspaces))
  return { pool, launch }
}

test('two conversations in one workspace share one process, port, and profile', async () => {
  const { pool, launch } = poolWith({ debugPortMin: 9400, debugPortMax: 9405 })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()

  assert.equal(launch.browsers.length, 1, 'one workspace started two browsers')
  assert.equal(pool.size, 1)
  assert.equal(pool.sessionCount, 2)
  const [first, second] = pool.status().instances
  assert.equal(first?.debugPort, 9400)
  assert.equal(second?.debugPort, 9400, 'the second conversation got a port of its own')
  assert.equal(first?.browserId, second?.browserId)
})

test('two workspaces get two browsers, and the same workspace is not one of them', async () => {
  const { pool, launch } = poolWith({ debugPortMin: 9400, debugPortMax: 9405 })
  await pool.get('session-a').ensure()
  await pool.get('session-c').ensure()

  assert.equal(launch.browsers.length, 2, 'two workspaces shared one browser')
  assert.notEqual(launch.browsers[0]?.config.debugPort, launch.browsers[1]?.config.debugPort)
  assert.notEqual(pool.status().instances[0]?.browserId, pool.status().instances[1]?.browserId)
})

test('each conversation sees only the pages it opened', async () => {
  const { pool } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()

  const pageOfA = await a.openPage({ url: 'https://example.test/a' })
  const pageOfB = await b.openPage({ url: 'https://example.test/b' })
  assert.ok(pageOfA?.targetId !== undefined)
  assert.ok(pageOfB?.targetId !== undefined)

  const ofA = a.status().tabs.map(tab => tab.targetId)
  const ofB = b.status().tabs.map(tab => tab.targetId)
  // The page each conversation opened is in its own list and not in the
  // other's; either may also hold the page its browser came up on.
  assert.equal(ofA.includes(pageOfA.targetId), true)
  assert.equal(ofB.includes(pageOfB.targetId), true)
  assert.equal(ofB.includes(pageOfA.targetId), false, 'a page leaked into the other conversation\'s list')
  assert.equal(ofA.includes(pageOfB.targetId), false, 'a page leaked into the other conversation\'s list')
  assert.equal(a.status().ownedPages, ofA.length)
  assert.equal(b.status().ownedPages, ofB.length)
})

test('a conversation cannot name another conversation\'s page', async () => {
  const { pool } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()
  const pageOfA = await a.openPage({ url: 'https://example.test/a' })
  assert.ok(pageOfA?.targetId !== undefined)

  // Every path that turns an id into a page asks the same question: selecting,
  // closing, and navigating a page all refuse somebody else's.
  await assert.rejects(b.selectPage(pageOfA.targetId), /has no page/u)
  await assert.rejects(b.navigatePage(pageOfA.targetId, 'https://example.test/x'), /has no page/u)
  await b.closePage(pageOfA.targetId)
  assert.equal(a.status().tabs.some(tab => tab.targetId === pageOfA.targetId), true, 'another conversation closed a page it does not own')
})

test('each conversation selects its own page without moving the other', async () => {
  const { pool } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()
  const first = await a.openPage({ url: 'https://example.test/one' })
  const second = await a.openPage({ url: 'https://example.test/two' })
  assert.ok(first?.targetId !== undefined)
  assert.ok(second?.targetId !== undefined)

  await a.selectPage(first.targetId)
  await b.openPage({ url: 'https://example.test/other' })
  assert.equal(a.status().url, 'https://example.test/one', 'another conversation moved this one\'s active page')

  await a.selectPage(second.targetId)
  assert.equal(a.status().url, 'https://example.test/two')
})

test('a ref one conversation minted is refused by the other', async () => {
  const { pool, launch } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()
  // Two pages of one browser, each read by the conversation that owns it. Each
  // snapshot numbers from `e1`, so the registries have to be per conversation:
  // a shared one would have B's snapshot renumbering A's answer.
  await a.openPage({ url: 'https://example.test/a' })
  await b.openPage({ url: 'https://example.test/b' })

  // A page with one element a snapshot can label, on each side: a ref is only
  // minted for a node the accessibility tree describes.
  const tree = {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 21 },
    ],
  }
  for (const fake of launch.browsers[0]?.pages ?? []) {
    fake.cdp.answers.set('Accessibility.getFullAXTree', tree)
  }

  const snapshotA = await a.snapshot()
  const minted = [...snapshotA.refs.keys()][0]
  assert.ok(minted !== undefined, 'the snapshot handed out no refs to test with')

  // The registry is per conversation, so B refuses the ref it never handed out
  // rather than resolving it against its own page. That refusal is the only
  // thing between two conversations and silently acting on each other's
  // elements.
  await assert.rejects(
    () => b.click(minted),
    /not a ref from a snapshot of the current page/u,
  )
})

test('closing one conversation\'s last page leaves the browser and the other page up', async () => {
  const { pool, launch } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()
  const pageOfA = await a.openPage({ url: 'https://example.test/a' })
  const pageOfB = await b.openPage({ url: 'https://example.test/b' })
  assert.ok(pageOfA?.targetId !== undefined)
  assert.ok(pageOfB?.targetId !== undefined)

  await a.closePage(pageOfA.targetId)

  assert.equal(launch.browsers.length, 1, 'closing a page started or stopped a process')
  assert.equal(launch.browsers[0]?.closed, false, 'one conversation\'s last page closed the shared browser')
  assert.equal(b.status().tabs.some(tab => tab.targetId === pageOfB.targetId), true)
  assert.equal(a.status().tabs.some(tab => tab.targetId === pageOfA.targetId), false)
})

test('the process closes only when the last conversation leaves', async () => {
  const { pool, launch } = poolWith()
  const a = pool.get('session-a')
  await pool.get('session-b').ensure()
  await a.ensure()
  const shared = a.host
  assert.equal(shared.refCount, 2)

  await pool.dispose('session-a')
  assert.equal(launch.browsers[0]?.closed, false, 'the first conversation out closed the shared process')
  assert.equal(shared.refCount, 1)

  await pool.dispose('session-b')
  assert.equal(launch.browsers[0]?.closed, true, 'the last conversation out left the process running')
  assert.equal(pool.size, 0)
})

test('disposing a conversation closes its pages and only its pages', async () => {
  const { pool, launch } = poolWith()
  const a = pool.get('session-a')
  const b = pool.get('session-b')
  await a.ensure()
  await b.ensure()
  const pageOfA = await a.openPage({ url: 'https://example.test/a' })
  const pageOfB = await b.openPage({ url: 'https://example.test/b' })
  assert.ok(pageOfA?.targetId !== undefined)
  assert.ok(pageOfB?.targetId !== undefined)

  await pool.dispose('session-a')

  assert.equal(pageOfA.targetId === undefined ? true : launch.browsers[0]?.pages.some(page => page.closed && page.targetId === pageOfA.targetId), true)
  const survivor = launch.browsers[0]?.pages.find(page => page.targetId === pageOfB.targetId)
  assert.equal(survivor?.closed, false, 'another conversation\'s page was closed with it')
})

test('a conversation in no workspace fails instead of getting a private browser', () => {
  const { pool } = poolWith({}, [WORKSPACE])
  assert.throws(() => pool.get('session-nowhere'), /not accounted to any workspace/u)
})

test('the session mode still gives every conversation its own browser', async () => {
  const { pool, launch } = poolWith({ profileMode: 'session' })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  assert.equal(launch.browsers.length, 2, 'the session mode started sharing browsers')
  assert.notEqual(launch.browsers[0]?.profileDir, launch.browsers[1]?.profileDir)
})

test('the temp mode still gives every conversation its own browser', async () => {
  const { pool, launch } = poolWith({ profileMode: 'temp', userDataDir: '' })
  await pool.get('session-a').ensure()
  await pool.get('session-b').ensure()
  assert.equal(launch.browsers.length, 2)
  assert.notEqual(launch.browsers[0]?.profileDir, launch.browsers[1]?.profileDir)
})

test('a workspace profile derives its directory from the project when none is configured', () => {
  const choice = chooseProfile(
    plainConfig(Config({ profileMode: 'workspace', userDataDir: '' })),
    'session-a',
    lookupOf([WORKSPACE]),
  )
  assert.equal(choice.key, WORKSPACE.id)
  assert.ok(choice.dir?.includes('project'), choice.dir)
  assert.ok(choice.dir?.includes('browser'), choice.dir)
})

test('a configured directory is used as the parent, one subdirectory per workspace', () => {
  const choice = chooseProfile(
    plainConfig(Config({ profileMode: 'workspace', userDataDir: 'D:\\profiles' })),
    'session-a',
    lookupOf([WORKSPACE]),
  )
  assert.equal(choice.dir, workspaceProfileDirFor('D:\\profiles', WORKSPACE.id))
  // Two workspaces must not share a directory: one directory is one process.
  const other = chooseProfile(
    plainConfig(Config({ profileMode: 'workspace', userDataDir: 'D:\\profiles' })),
    'session-c',
    lookupOf([WORKSPACE, OTHER]),
  )
  assert.notEqual(choice.dir, other.dir)
})

test('an empty configured base derives from the workspace path', () => {
  assert.equal(workspaceProfileBase('', WORKSPACE), workspaceProfileBase('', WORKSPACE))
  assert.notEqual(workspaceProfileBase('', WORKSPACE), workspaceProfileBase('', OTHER))
  assert.equal(workspaceProfileBase('D:\\profiles', WORKSPACE), 'D:\\profiles')
})
