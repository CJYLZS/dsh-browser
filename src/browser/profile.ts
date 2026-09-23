/**
 * Where one session's browser keeps its profile.
 *
 * A Chrome profile directory belongs to exactly one running process, so the
 * per-session browsers cannot share one: each session gets a directory of its
 * own under the configured parent. That is also what makes the isolation real
 * — separate cookies, separate storage, separate sign-ins — and it is why a
 * session's logins do not carry over to another session.
 *
 * Session ids are opaque strings from the harness, so the segment naming one is
 * encoded before it touches the filesystem. The escape is the harness's own
 * (`encodeSegment` in `session-persistence-jsonl`): safe characters pass
 * through, everything else becomes `~XXXX`, which is reversible and therefore
 * cannot merge two ids into one directory.
 */
import { join } from 'node:path'

/**
 * Longest encoded segment kept verbatim.
 *
 * Session ids are short today, but a profile path is also a Windows path with
 * its own limits, so an unusually long id is hashed instead of trusted.
 */
export const SESSION_SEGMENT_MAX = 96

/** Characters that can appear in a path segment as themselves. */
const SAFE = /^[A-Za-z0-9._-]$/

/**
 * Encode one session id as a single path segment.
 * @param sessionId - the session id, as the harness minted it.
 * @returns a segment that names one directory and cannot traverse.
 * @throws {Error} when the id is empty.
 */
export function encodeSessionSegment(sessionId: string): string {
  if (sessionId.length === 0) throw new Error('dsh-browser: cannot name a profile directory after an empty session id')
  if (sessionId === '.') return '~002E'
  if (sessionId === '..') return '~002E~002E'
  let encoded = ''
  for (const character of sessionId) {
    encoded += character !== '~' && SAFE.test(character)
      ? character
      : `~${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '0000'}`
  }
  if (encoded.length <= SESSION_SEGMENT_MAX) return encoded
  // Truncation alone would let two long ids with a shared prefix share a
  // profile, which fails the second launch; the hash keeps them apart, and it
  // is budgeted for inside the cap rather than added to it.
  const suffix = `~${hash(sessionId)}`
  return encoded.slice(0, SESSION_SEGMENT_MAX - suffix.length) + suffix
}

/**
 * Stable short hash of an id, used only to keep truncated segments distinct.
 * @param value - the id being hashed.
 * @returns eight hexadecimal digits.
 */
function hash(value: string): string {
  let state = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    state = Math.imul(state ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return state.toString(16).padStart(8, '0')
}

/**
 * The profile directory one session's browser opens.
 * @param base - the configured parent directory.
 * @param sessionId - the session owning the browser.
 * @returns the directory, which the caller creates by launching into it.
 */
export function profileDirFor(base: string, sessionId: string): string {
  return join(base, encodeSessionSegment(sessionId))
}
