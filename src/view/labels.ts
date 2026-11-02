/**
 * A Session's name, for the page that lists browsers.
 *
 * The settings page answers "who is using a browser", and a session id is not an
 * answer a person can read: every id starts with `session-`, and the eight
 * characters that follow are hexadecimal that means nothing outside the store.
 * A title is what the user named the conversation — or, failing that, the
 * opening of its first prompt, which the harness folds for every session that
 * has said anything.
 *
 * Two sources, in one order, because the plugin is guaranteed neither:
 *
 * 1. `ctx.sessionQuery` answers for a live session *and* for a cold one whose
 *    log is on disk — the case that matters here, because a session whose
 *    browser is still running is not necessarily one this process has open.
 * 2. `ctx.sessionTitle` folds the title out of a live session's own log, which
 *    needs the session object from `ctx.sessions`.
 *
 * Both are optional: a composition that mounts neither is a deployment whose
 * settings page shows the fallback label, not a reason for the route to fail.
 *
 * The answer is cached for a moment because the route is polled — the sidebar
 * reconciles against it every 1.5 seconds, and reading a title means folding a
 * session's log. A title is durable state that changes when a person renames a
 * conversation or a provider produces one, so a few seconds of staleness is
 * invisible; a log fold per poll per browser is not.
 */
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../tools/spill.ts'

/** The `ctx.sessionQuery` face this plugin reads, declared structurally. */
interface SessionQueryService {
  readTitle?(sessionId: string, signal?: AbortSignal): Promise<{ readonly title?: string } | undefined>
}

/** The `ctx.sessionTitle` face this plugin reads. */
interface SessionTitleService {
  get?(session: { readonly id: string }): { readonly title?: string } | undefined
}

/** The `ctx.sessions` face this plugin reads. */
interface SessionStoreService {
  get?(sessionId: string): { readonly id: string } | undefined
}

/** How long one session's title is trusted before it is read again, in milliseconds. */
const TITLE_TTL_MS = 5_000

/**
 * A title worth showing.
 * @param value - whatever a service reported.
 * @returns the trimmed title, or `undefined` when there is nothing to show.
 */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolves Session titles for the browser report.
 *
 * One instance is handed to the route, so the cache lives as long as the route
 * does and no title outlives the plugin.
 */
export class SessionLabels {
  private readonly cache = new Map<string, { at: number; title: string | undefined }>()
  private readonly ctx: Context
  private readonly now: () => number

  /**
   * @param ctx - plugin context, for the optional title services.
   * @param now - the clock; replaced in tests.
   */
  constructor(ctx: Context, now: () => number = Date.now) {
    this.ctx = ctx
    this.now = now
  }

  /**
   * The title of one session.
   *
   * A read that throws is not cached: the next look tries again, and until then
   * the page shows its fallback label. A session that genuinely has no title is
   * cached, because "this conversation has said nothing yet" is an answer that
   * stays right for a while.
   * @param sessionId - the session to name.
   * @returns its title, or `undefined` when there is none to show.
   */
  async titleOf(sessionId: string): Promise<string | undefined> {
    const hit = this.cache.get(sessionId)
    const at = this.now()
    if (hit !== undefined && at - hit.at < TITLE_TTL_MS) return hit.title
    const read = await this.read(sessionId)
    if (read.unavailable === true) return undefined
    this.cache.set(sessionId, { at, title: read.title })
    return read.title
  }

  /**
   * Read one session's title from whichever service can answer.
   * @param sessionId - the session to name.
   * @returns the title, and whether the composition simply cannot tell.
   */
  private async read(sessionId: string): Promise<{ title: string | undefined; unavailable?: true }> {
    const query = serviceOf(this.ctx, 'sessionQuery') as SessionQueryService | undefined
    const titles = serviceOf(this.ctx, 'sessionTitle') as SessionTitleService | undefined
    if (query === undefined && titles === undefined) return { title: undefined, unavailable: true }
    // A read that threw and a session with no title are different answers, and
    // only the second one is worth remembering: the first is a service that may
    // answer on the next look.
    let threw = false
    if (typeof query?.readTitle === 'function') {
      try {
        const title = nonEmpty((await query.readTitle(sessionId))?.title)
        if (title !== undefined) return { title }
      } catch {
        // A cold log that cannot be read is not a reason to stop looking: the
        // live service may still name the session, and the page falls back to
        // its label when neither can.
        threw = true
      }
    }
    if (typeof titles?.get === 'function') {
      const store = serviceOf(this.ctx, 'sessions') as SessionStoreService | undefined
      const live = typeof store?.get === 'function' ? store.get(sessionId) : undefined
      if (live !== undefined) {
        try {
          const title = nonEmpty(titles.get(live)?.title)
          if (title !== undefined) return { title }
        } catch {
          // Same as above: the fallback label is the honest answer.
          threw = true
        }
      }
    }
    return threw ? { title: undefined, unavailable: true } : { title: undefined }
  }
}
