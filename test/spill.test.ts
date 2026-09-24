/**
 * A snapshot of a large page is the plugin's largest single piece of model
 * input, and the reference implementations all answer the same way: put it in a
 * file and hand back the path (chrome-devtools: "files are the right location
 * for large amounts of data"; the harness's own spill policy does the same for
 * any oversized tool result).
 *
 * The store is the harness's `spillStore` when the composition provides one, so
 * the file lands in the session's spill directory and is described with the
 * harness's own retrieval hint; the plugin's own temp directory is the fallback
 * for a deployment that does not mount one.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  preview,
  shouldSpill,
  spillStoreOf,
  writeText,
  SNAPSHOT_INLINE_CHARS,
  type SaveTextRequest,
  type SpillStore,
} from '../src/tools/spill.ts'

/**
 * A temporary directory for one test.
 * @param prefix - directory name prefix.
 * @returns the directory, and a cleanup callback.
 */
async function scratch(prefix: string): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, done: () => rm(dir, { recursive: true, force: true }) }
}

test('a long text is previewed by its first lines, with the remainder announced', () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n')
  const shown = preview(text, 5)
  assert.equal(shown.split('\n').slice(0, 5).join('\n'), 'line 0\nline 1\nline 2\nline 3\nline 4')
  assert.match(shown, /25 more lines/)
})

test('a text within the preview is returned whole', () => {
  assert.equal(preview('one\ntwo', 5), 'one\ntwo')
})

test('spilling is what the caller asked for, or what the size demands', () => {
  assert.equal(shouldSpill('short', true), true)
  assert.equal(shouldSpill('short', false), false)
  assert.equal(shouldSpill('x'.repeat(SNAPSHOT_INLINE_CHARS + 1), false), true)
  assert.equal(shouldSpill('x'.repeat(SNAPSHOT_INLINE_CHARS), false), false)
})

test('without a spill store the text goes to a file the caller can read', async () => {
  const { dir, done } = await scratch('dsh-browser-spill-test-')
  try {
    const written = await writeText('the whole page', {
      dir,
      toolName: 'browser_snapshot',
      label: 'snapshot',
    })
    assert.equal(await readFile(written.path, 'utf8'), 'the whole page')
    assert.equal(written.bytes, 14)
    assert.match(written.path, /snapshot/)
    assert.match(written.hint, /read/i)
  } finally {
    await done()
  }
})

test('the harness spill store is used when the composition provides one', async () => {
  const { dir, done } = await scratch('dsh-browser-spill-test-')
  const requests: SaveTextRequest[] = []
  const store: SpillStore = {
    saveText: async (request) => {
      requests.push(request)
      return { locator: 'C:\\spill\\snapshot.txt', bytes: 999, retrievalHint: 'read C:\\spill\\snapshot.txt' }
    },
  }
  try {
    const written = await writeText('the whole page', {
      dir,
      toolName: 'browser_snapshot',
      label: 'snapshot',
      sessionId: 'session-a',
      callId: 'call-1',
      store,
    })
    assert.equal(written.path, 'C:\\spill\\snapshot.txt')
    assert.equal(written.hint, 'read C:\\spill\\snapshot.txt')
    assert.equal(written.bytes, 999)
    assert.deepEqual(requests, [{
      owner: { sessionId: 'session-a' },
      source: { kind: 'tool', toolName: 'browser_snapshot', callId: 'call-1', label: 'snapshot' },
      suggestedName: 'browser_snapshot-snapshot.txt',
      content: 'the whole page',
    }])
  } finally {
    await done()
  }
})

test('a spill store that refuses does not turn a snapshot into a failure', async () => {
  const { dir, done } = await scratch('dsh-browser-spill-test-')
  const store: SpillStore = {
    saveText: async () => { throw new Error('disk full') },
  }
  try {
    const written = await writeText('the whole page', { dir, toolName: 'browser_snapshot', label: 'snapshot', store })
    assert.equal(await readFile(written.path, 'utf8'), 'the whole page')
    assert.match(written.path, /snapshot/)
  } finally {
    await done()
  }
})

test('two spills of the same page do not overwrite each other', async () => {
  const { dir, done } = await scratch('dsh-browser-spill-test-')
  try {
    const first = await writeText('first', { dir, toolName: 'browser_snapshot', label: 'snapshot' })
    const second = await writeText('second', { dir, toolName: 'browser_snapshot', label: 'snapshot' })
    assert.notEqual(first.path, second.path)
    assert.equal(await readFile(first.path, 'utf8'), 'first')
    assert.equal(await readFile(second.path, 'utf8'), 'second')
  } finally {
    await done()
  }
})

test('the spill store is found through the context when the composition mounts one', () => {
  const store: SpillStore = { saveText: async () => ({ locator: 'x', bytes: 0, retrievalHint: 'read x' }) }
  const mounted = { get: (name: string) => (name === 'spillStore' ? store : undefined) } as unknown as Context
  assert.equal(spillStoreOf(mounted), store)
})

test('a composition without a spill store, or with something else under that name, falls back', () => {
  const empty = { get: () => undefined } as unknown as Context
  assert.equal(spillStoreOf(empty), undefined)
  const foreign = { get: () => ({ saveText: 'not a function' }) } as unknown as Context
  assert.equal(spillStoreOf(foreign), undefined)
  const bare = {} as unknown as Context
  assert.equal(spillStoreOf(bare), undefined)
})
