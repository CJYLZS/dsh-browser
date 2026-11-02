/**
 * Which profile directory a browser opens, and therefore who shares a process.
 *
 * The decision is one function so its two readers cannot disagree: the pool asks
 * it to *key* browsers, and the browser asks it to *launch*. Two conversations
 * that resolve to the same directory must share one process — Chrome hands a
 * second launch on a held directory to the first process and then Playwright
 * refuses it — so the key and the directory are one decision, not two.
 *
 * The three modes answer two independent questions and this is the only place
 * that combination is written down:
 *
 * | mode        | directory starts from            | who shares a sign-in |
 * | ----------- | -------------------------------- | -------------------- |
 * | `temp`      | a fresh temporary directory      | nobody               |
 * | `session`   | `<parent>/<session>`             | one conversation     |
 * | `workspace` | `<parent>/workspace-<workspace>` | every conversation in the project |
 *
 * Only the last two keep anything after the process exits, and that is the mode's
 * job to say — not the directory's. A configured directory is the *parent* for
 * whichever mode is in force, never a second answer to "should this be kept":
 * `temp` ignores it, which is what stops "Temporary" from quietly writing a
 * profile to disk because a path was left in the field.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserConfig, ProfileMode } from '../config.ts'
import { profileDirOf } from './profile.ts'
import { workspaceProfileBase, type WorkspaceFacts } from './workspace.ts'

/**
 * Where a kept profile goes when no parent directory is configured.
 *
 * Under the temporary directory rather than inside the harness home: this plugin
 * is external and does not resolve `$DSH_HOME` itself, and the temporary
 * directory is the one location that exists on every deployment and is already
 * the browser's working area. A deployment that wants the profiles somewhere
 * durable names a directory.
 */
export const DEFAULT_PROFILE_BASE = join(tmpdir(), 'dsh-browser-profiles')

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
 * Reject a relative parent directory, naming the consequence.
 *
 * Checked here rather than in the configuration schema on purpose. The schema
 * crosses a wire — the settings shell rehydrates `Config.toJSON()` into a live
 * schema in the browser — and a `transform()` does not survive that trip: its
 * callback travels as source text and is re-evaluated where nothing it mentions
 * exists, which took the whole browser settings section down (2026-11-02). This
 * is the point where the value is actually used, so a bad one fails the launch
 * with a message instead of breaking the page that edits it.
 * @param base - the configured parent directory.
 * @returns the same directory.
 * @throws {Error} when the directory is relative.
 */
function requireAbsoluteDirectory(base: string): string {
  if (!/^(?:$|[A-Za-z]:[\\/]|\\\\|\/)/.test(base)) {
    throw new Error(
      `dsh-browser: the profile directory must be absolute, but got "${base}". `
      + 'A relative path is resolved against whatever directory the host was started in, which is the '
      + 'application directory on Desktop and the shell\'s directory under the web profile. '
      + 'Set a full path such as D:\\\\chrome-profile, or leave it empty to use this mode\'s default.',
    )
  }
  return base
}

/**
 * The parent directory a mode keeps its profiles under.
 *
 * One function because the answer is read in two places that must agree: the
 * resolution below, and the settings page telling the user where a blank field
 * lands.
 * @param config - the configuration in force.
 * @param workspace - the session's workspace, for `workspace` mode.
 * @returns the configured parent, or the mode's own default when none is set.
 * @throws {Error} when the configured directory is relative.
 */
export function profileBaseOf(config: BrowserConfig, workspace?: WorkspaceFacts): string {
  const configured = requireAbsoluteDirectory(config.userDataDir)
  if (config.profileMode === 'workspace') {
    // An empty base derives from the project, so the profile follows it.
    if (configured === '' && workspace !== undefined) return workspaceProfileBase('', workspace)
  }
  return configured === '' ? DEFAULT_PROFILE_BASE : configured
}

/**
 * The profile directory and pool key a session resolves to.
 *
 * A `temp` browser is per conversation all the same: the isolation unit did not
 * change, only whether anything survives the process. That is why `temp` and
 * `session` share a key even though only one of them keeps its directory.
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
  // Temporary means temporary: whatever is in the directory field does not apply,
  // because a mode that says "nothing is kept" must not write to disk anyway.
  if (config.profileMode === 'temp') return { dir: undefined, key: sessionId }
  if (config.profileMode === 'session') {
    return { dir: profileDirOf({ mode: 'session', base: profileBaseOf(config), sessionId }), key: sessionId }
  }
  const workspace = lookup(sessionId)
  if (workspace === undefined) {
    throw new Error(
      `dsh-browser: the workspace profile mode shares one browser per workspace, and session `
      + `${sessionId} is not accounted to any workspace; switch the profile mode to "session" to give `
      + 'each conversation its own browser, or open the conversation inside a workspace',
    )
  }
  return {
    dir: profileDirOf({ mode: 'workspace', base: profileBaseOf(config, workspace), sessionId, workspaceId: workspace.id }),
    key: workspace.id,
  }
}

/**
 * Whether a mode keeps its profile after the browser closes.
 * @param mode - the profile mode.
 * @returns whether anything survives the process.
 */
export function keepsProfile(mode: ProfileMode): boolean {
  return mode !== 'temp'
}
