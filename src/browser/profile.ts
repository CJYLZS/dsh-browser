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
 *
 * A workspace-mode profile is the same directory shape one unit coarser: one
 * directory per workspace instead of per session, so every conversation in a
 * project opens the same sign-ins. The prefix is not decoration — it keeps a
 * workspace id from ever naming the same directory as a session id, which is
 * the difference between "shared on purpose" and "shared by accident".
 */
import { join } from 'node:path'
import type { ProfileMode } from '../config.ts'

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
 * The prefix a workspace's own directory segment carries.
 *
 * A workspace id and a session id are both opaque harness ids, and they are
 * drawn from different generators: nothing stops `workspace-<x>` and a session
 * called `workspace-<x>` from colliding if the two ever shared a parent. The
 * prefix makes the two namespaces disjoint by construction, so "these two
 * conversations share a profile" is always the mode's doing.
 */
const WORKSPACE_PREFIX = 'workspace-'

/**
 * The profile directory one workspace's browser opens.
 *
 * Every session in the workspace resolves to this one directory, which is the
 * whole point of the mode: a site signed into in one conversation is signed in
 * for the next one. It is also why only one browser may open it — a second
 * launch on a directory another process holds is handed off and Playwright
 * refuses it — so the pool keys browsers by this directory's unit rather than
 * by session.
 * @param base - the configured parent directory.
 * @param workspaceId - the workspace sharing the browser.
 * @returns the directory every session of that workspace opens.
 * @throws {Error} when the id is empty.
 */
export function workspaceProfileDirFor(base: string, workspaceId: string): string {
  return join(base, WORKSPACE_PREFIX + encodeSessionSegment(workspaceId))
}

/**
 * The profile directory one session's browser opens, whatever the mode.
 *
 * The one place the mode becomes a path, so the three modes cannot disagree
 * about where a browser's profile lives.
 * @param options - the mode, the configured parent, and the ids that name it.
 * @returns the directory, which the caller creates by launching into it.
 * @throws {Error} when the mode needs an id it was not given.
 */
export function profileDirOf(options: {
  readonly mode: ProfileMode
  readonly base: string
  readonly sessionId: string
  readonly workspaceId?: string
}): string {
  if (options.mode === 'workspace') {
    const workspaceId = options.workspaceId
    if (workspaceId === undefined || workspaceId === '') {
      throw new Error(
        'dsh-browser: the workspace profile mode needs a workspace id, and this session resolved to none',
      )
    }
    return workspaceProfileDirFor(options.base, workspaceId)
  }
  return profileDirFor(options.base, options.sessionId)
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
