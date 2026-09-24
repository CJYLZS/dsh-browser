/**
 * The Agent Notes' own rules, checked mechanically.
 *
 * The tree is path-encoded — `{lifecycle}/{class}/yyyy-mm-dd-slug.md` — and the
 * file format is fixed: an English header block, a `Status:` line that agrees
 * with the folder, and the sections that lifecycle's skeleton requires. What
 * this replaces is a single file nobody could navigate, so the rules that keep
 * the tree navigable are worth a test rather than a convention nobody reads.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

/** Where the notes live, relative to the package root. */
const NOTES = '.agents/notes'

/** The closed set of decision classes. */
const CLASSES = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing']

/** The three lifecycles, which are also the top-level folder names. */
const LIFECYCLES = ['implemented', 'proposed', 'rejected']

/** Sections every note carries, whatever its lifecycle. */
const REQUIRED = ['## Problem', '## Alternatives considered']

/** Sections one lifecycle's skeleton requires on top of those. */
const BY_LIFECYCLE: Record<string, readonly string[]> = {
  implemented: ['## Decision', '## Consequences'],
  proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
  rejected: [],
}

/** One note, as found on disk. */
interface Found {
  /** Path relative to the package root, with forward slashes. */
  readonly path: string
  /** The file's text. */
  readonly text: string
  /** The lifecycle folder it sits in. */
  readonly lifecycle: string
  /** The class folder it sits in. */
  readonly kind: string
}

/**
 * Walk the notes tree and collect every note.
 *
 * The rule files (`README.md`, `AGENTS.md`) sit directly in the notes directory
 * and are not notes; only `{lifecycle}/{class}/*.md` is collected.
 * @returns every note found, in directory order.
 */
function notes(): Found[] {
  const root = resolve(NOTES)
  const found: Found[] = []
  for (const lifecycle of readdirSync(root)) {
    const lifecycleDir = join(root, lifecycle)
    if (lifecycle.endsWith('.md') || !statSync(lifecycleDir).isDirectory()) continue
    for (const kind of readdirSync(lifecycleDir)) {
      const kindDir = join(lifecycleDir, kind)
      if (!statSync(kindDir).isDirectory()) continue
      for (const file of readdirSync(kindDir)) {
        if (!file.endsWith('.md')) continue
        const path = join(kindDir, file)
        found.push({
          path: relative(resolve('.'), path).replaceAll('\\', '/'),
          text: readFileSync(path, 'utf8'),
          lifecycle,
          kind,
        })
      }
    }
  }
  return found
}

test('every note sits in a known lifecycle and class folder, dated in its name', () => {
  const all = notes()
  assert.ok(all.length >= 10, `only ${String(all.length)} notes found`)
  for (const note of all) {
    assert.ok(LIFECYCLES.includes(note.lifecycle), `${note.path}: unknown lifecycle`)
    assert.ok(CLASSES.includes(note.kind), `${note.path}: unknown class`)
    assert.match(note.path.split('/').at(-1) ?? '', /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/, `${note.path}: name`)
  }
})

test('every note carries the header block and its lifecycle skeleton', () => {
  for (const note of notes()) {
    const lines = note.text.split('\n')
    assert.match(lines[0] ?? '', /^# Agent Note: \S/, `${note.path}: the first line is the title`)
    assert.equal(lines[1], '', `${note.path}: the header block needs a blank second line`)
    assert.match(lines[2] ?? '', /^Status: /, `${note.path}: the third line is the status`)
    assert.ok(
      (lines[2] ?? '').includes(note.lifecycle),
      `${note.path}: the status must agree with the ${note.lifecycle} folder`,
    )
    for (const section of [...REQUIRED, ...BY_LIFECYCLE[note.lifecycle] ?? []]) {
      assert.ok(note.text.includes(`\n${section}\n`), `${note.path}: missing ${section}`)
    }
    if (note.lifecycle === 'implemented') {
      assert.ok(
        !/^## (Proposal|Plan|Migration plan|Acceptance criteria)$/mu.test(note.text),
        `${note.path}: an implemented note must not keep proposal sections`,
      )
    }
  }
})

test('every link in a note resolves', () => {
  for (const note of notes()) {
    const dir = dirname(resolve(note.path))
    for (const [, target = ''] of note.text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
      assert.ok(
        statSync(resolve(dir, target), { throwIfNoEntry: false }) !== undefined,
        `${note.path}: ${target} does not exist`,
      )
    }
  }
})
