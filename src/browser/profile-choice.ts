/**
 * Which profile directory a browser opens, and therefore who shares a process.
 *
 * The decision is one function so its two readers cannot disagree: the pool asks
 * it to *key* browsers, and the browser asks it to *launch*. Two conversations
 * that resolve to the same directory must share one process — Chrome hands a
 * second launch on a held directory to the first process and then Playwright
 * refuses it — so the key and the directory are one decision, not two.
 *
 * `temp` and `session` both resolve per conversation; they differ only in
 * whether anything survives the process. `workspace` resolves per workspace, and
 * a session that belongs to no workspace fails rather than silently getting a
 * private browser: a user who chose shared sign-ins would otherwise get today's
 * behaviour with no way to see why the logins never carried over.
 */
import type { BrowserConfig } from '../config.ts'
import { profileDirOf } from './profile.ts'
import { workspaceProfileBase, type WorkspaceFacts } from './workspace.ts'

/** What a session's profile resolution produced. */
export interface ProfileChoice {
  /**
   * The directory the browser opens, or `undefined` for a temporary one.
   *
   * A temporary directory is deliberately not named here: the browser creates it
   * at launch and removes it when it closes, and naming one now would mean
   * holding a directory nothing has created.
   */
  readonly dir: string | undefined
  /** The pool key: sessions resolving to the same key share one process. */
  readonly key: string
}

/** Finds the workspace a session belongs to; `undefined` when none does. */
export type WorkspaceLookup = (sessionId: string) => WorkspaceFacts | undefined

/**
 * The profile directory and pool key a session resolves to.
 *
 * A `temp` browser is per conversation all the same: the isolation unit did not
 * change, only whether anything survives the process. That is why `temp` and
 * `session` share a key even though one of them keeps its directory.
 * @param config - the configuration in force.
 * @param sessionId - the session asking.
 * @param lookup - how to resolve the workspace, for `workspace` mode.
 * @returns its directory (or `undefined` for a temporary one) and its pool key.
 * @throws {Error} when the mode is `workspace` and the session has no workspace.
 */
export function chooseProfile(
  config: BrowserConfig,
  sessionId: string,
  lookup: WorkspaceLookup,
): ProfileChoice {
  if (config.profileMode !== 'workspace') {
    if (config.userDataDir === '') return { dir: undefined, key: sessionId }
    return { dir: profileDirOf({ mode: 'session', base: config.userDataDir, sessionId }), key: sessionId }
  }
  const workspace = lookup(sessionId)
  if (workspace === undefined) {
    throw new Error(
      `dsh-browser: the workspace profile mode shares one browser per workspace, and session `
      + `${sessionId} is not accounted to any workspace; switch the profile mode to "session" to give `
      + 'each conversation its own browser, or open the conversation inside a workspace',
    )
  }
  const base = workspaceProfileBase(config.userDataDir, workspace)
  return {
    dir: profileDirOf({ mode: 'workspace', base, sessionId, workspaceId: workspace.id }),
    key: workspace.id,
  }
}
