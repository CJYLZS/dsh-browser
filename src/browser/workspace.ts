/**
 * Which workspace a session belongs to, when the profile mode needs to know.
 *
 * `session` mode never asks: the unit is the conversation. `workspace` mode
 * asks every time it is about to start a browser or look one up, because the
 * answer is what selects both the profile directory and the browser instance
 * key — two conversations in one project must resolve to the same one, and two
 * projects must never.
 *
 * The registry is read structurally rather than imported. This plugin is an
 * external one and takes no dependency on `@deepseek-ai/dsh-workspace`; the
 * shape it needs is one synchronous `list()`, and a composition that does not
 * mount the registry is a deployment where `workspace` mode cannot work — which
 * is reported as a failure rather than quietly degraded to per-session
 * profiles, because a user who chose the mode chose shared sign-ins.
 *
 * `sessionIds` is the membership the registry already validates against each
 * session's own working directory, so this module never re-derives "which
 * project is this" from paths: doing that twice is how the two answers start to
 * disagree.
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { serviceOf } from '../tools/spill.ts'

/** One workspace, as far as this plugin reads it. */
export interface WorkspaceFacts {
  /** The durable workspace id: stable across renames and path normalization. */
  readonly id: string
  /** The canonical project directory. */
  readonly path: string
  /** The sessions the registry accounts to it. */
  readonly sessionIds: readonly string[]
}

/** The `ctx.workspaceRegistry` face this plugin reads, declared structurally. */
interface WorkspaceRegistryService {
  /**
   * Every registered workspace, in registry order.
   * @returns the workspaces; synchronous, because the registry caches them.
   */
  list?(): readonly WorkspaceFacts[]
}

/**
 * The subdirectory a workspace-mode profile lives in, under the project.
 *
 * The profile follows the project, so a directory inside it is what makes the
 * mode work without anyone choosing a path — and `.dsh` is the convention the
 * harness already uses for its own per-project state.
 */
export const WORKSPACE_PROFILE_SUBDIR = join('.dsh', 'browser')

/**
 * The workspace registry, when the composition mounts one.
 * @param ctx - the plugin context.
 * @returns the registry, or `undefined` when this deployment has none.
 */
export function workspaceRegistryOf(ctx: Context): WorkspaceRegistryService | undefined {
  const candidate = serviceOf(ctx, 'workspaceRegistry') as Partial<WorkspaceRegistryService> | undefined
  return typeof candidate?.list === 'function' ? candidate as WorkspaceRegistryService : undefined
}

/**
 * The workspaces that exist, or none when the registry cannot be read.
 *
 * A registry whose `list()` throws is treated as absent rather than as empty:
 * "this project has no workspace" and "the registry is broken" lead to the same
 * action — refuse to start a shared browser, and say which one it was — while
 * an empty list would silently give the session a private browser instead.
 * @param ctx - the plugin context.
 * @returns the workspaces, empty when nothing can be read.
 */
function workspacesOf(ctx: Context): readonly WorkspaceFacts[] {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) return []
  try {
    return registry.list?.() ?? []
  } catch {
    return []
  }
}

/** Why a session in `workspace` mode has no workspace to share. */
export const NO_WORKSPACE_REASON =
  'the workspace profile mode needs a workspace, and this deployment could not resolve one for the session'

/**
 * The workspace a session belongs to.
 *
 * Membership is the registry's answer, not a path comparison: the registry
 * decides which sessions belong to which project, and it filters that account
 * against each session's own recorded working directory. A session the registry
 * does not account for has no workspace, which in `workspace` mode is a refusal.
 * @param ctx - the plugin context.
 * @param sessionId - the session asking.
 * @returns the workspace, or `undefined` when none accounts for the session.
 */
export function workspaceOf(ctx: Context, sessionId: string): WorkspaceFacts | undefined {
  for (const workspace of workspacesOf(ctx)) {
    if (workspace.sessionIds.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * The profile directory a workspace shares, from the configuration.
 *
 * A configured parent is used as it is; an empty one derives
 * `<workspace.path>/.dsh/browser`, so the profile follows the project without
 * anyone naming a directory. That derivation is what makes the mode usable out
 * of the box, and it is also why the directory is not a launch field the
 * settings page can leave blank: blank means "here, with the project".
 * @param configuredBase - the configured `userDataDir`, empty when unset.
 * @param workspace - the workspace whose profile this is.
 * @returns the directory every session of the workspace opens.
 */
export function workspaceProfileBase(configuredBase: string, workspace: WorkspaceFacts): string {
  return configuredBase === '' ? join(workspace.path, WORKSPACE_PROFILE_SUBDIR) : configuredBase
}
