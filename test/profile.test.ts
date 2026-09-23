/**
 * A session's profile directory is named after its session id, and a session
 * id is an opaque string this plugin does not mint. The encoding is therefore
 * a safety property first — a session id must never be able to name a path
 * outside the configured parent — and a uniqueness property second, since two
 * sessions sharing one profile directory would fail to launch the second time.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeSessionSegment, profileDirFor, SESSION_SEGMENT_MAX } from '../src/browser/profile.ts'

test('an ordinary id is its own directory name', () => {
  assert.equal(encodeSessionSegment('01J8Z4K2M3N4P5Q6R7S8T9V0W1'), '01J8Z4K2M3N4P5Q6R7S8T9V0W1')
})

test('a separator cannot survive into the path', () => {
  for (const id of ['a/b', 'a\\b', '../x', '..', '.', 'C:\\Windows']) {
    const segment = encodeSessionSegment(id)
    assert.ok(!segment.includes('/'), `${id} kept a slash`)
    assert.ok(!segment.includes('\\'), `${id} kept a backslash`)
    assert.notEqual(segment, '.')
    assert.notEqual(segment, '..')
  }
})

test('encoding distinguishes ids a naive replacement would merge', () => {
  assert.notEqual(encodeSessionSegment('a/b'), encodeSessionSegment('a~002Fb'))
  assert.notEqual(encodeSessionSegment('a~002Fb'), 'a/b')
})

test('a long id stays within a filesystem component and stays distinct', () => {
  const long = 'x'.repeat(500)
  const other = `${'x'.repeat(499)}y`
  const first = encodeSessionSegment(long)
  assert.ok(first.length <= SESSION_SEGMENT_MAX, `${first.length} exceeds the cap`)
  assert.notEqual(first, encodeSessionSegment(other))
})

test('an empty id is refused rather than turned into a stray directory', () => {
  assert.throws(() => encodeSessionSegment(''), /empty/)
})

test('the profile directory is the parent plus one segment', () => {
  assert.equal(profileDirFor('D:\\profiles', 'abc'), join('D:\\profiles', 'abc'))
  assert.equal(profileDirFor('/tmp/profiles', 'a/b'), join('/tmp/profiles', 'a~002Fb'))
})

test('the profile directory cannot escape its parent', () => {
  const base = join('/tmp', 'profiles')
  for (const id of ['..', '../..', '../../etc', '..\\..\\windows']) {
    const resolved = profileDirFor(base, id)
    assert.equal(resolved.startsWith(`${base}/`) || resolved.startsWith(`${base}\\`), true, resolved)
  }
})
