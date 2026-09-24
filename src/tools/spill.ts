/**
 * Where a tool result too large to read inline goes.
 *
 * A snapshot of a large page is this plugin's biggest single piece of model
 * input, and every reference implementation answers the same way: put it in a
 * file and hand back the path. chrome-devtools-mcp states the principle ("files
 * are the right location for large amounts of data"); the harness's own spill
 * policy applies it to every oversized tool result.
 *
 * The store is the harness's `spillStore` when the composition mounts one, so
 * the file lands in the session's spill directory and is described with the
 * harness's own retrieval hint. The plugin's own directory is the fallback,
 * because this is an external plugin and a deployment may mount no store at
 * all. A store that refuses to save is not a failed snapshot: the text is
 * written to the fallback directory instead.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * A request to persist text, matching the harness `spillStore` contract.
 *
 * Declared structurally rather than imported: this plugin does not depend on
 * `@deepseek-ai/dsh-spill`, and the shape is the whole of what it uses.
 */
export interface SaveTextRequest {
  readonly owner: { readonly sessionId: string }
  readonly source: {
    readonly kind: 'tool'
    readonly toolName: string
    readonly callId: string
    readonly label: string
  }
  readonly suggestedName: string
  readonly content: string
}

/** The harness spill service, as far as this plugin uses it. */
export interface SpillStore {
  /** Persist one text and describe where it went. */
  saveText(request: SaveTextRequest): Promise<{
    readonly locator: string
    readonly bytes: number
    readonly retrievalHint: string
  }>
}

/** Where a text was written, and how to get it back. */
export interface Spilled {
  /** The path or handle to show the model. */
  readonly path: string
  /** How to read it back. */
  readonly hint: string
  /** Exact bytes written. */
  readonly bytes: number
}

/** Text longer than this is written to a file instead of returned inline. */
export const SNAPSHOT_INLINE_CHARS = 40_000

/** Lines a spill preview keeps inline. */
const PREVIEW_LINES = 20

/** Makes each fallback file name unique within one process. */
let counter = 0

/**
 * Whether a result should be written to a file.
 * @param text - the text the tool produced.
 * @param requested - whether the caller asked for a file.
 * @returns whether to spill.
 */
export function shouldSpill(text: string, requested: boolean): boolean {
  return requested || text.length > SNAPSHOT_INLINE_CHARS
}

/**
 * The harness spill store, when the composition mounts one.
 *
 * Looked up through the context rather than injected: this plugin works in a
 * composition without `dsh-spill-local`, and a missing store is a fallback
 * rather than a failure to load. The lookup is structural because the plugin
 * deliberately does not depend on `@deepseek-ai/dsh-spill`.
 * @param ctx - the plugin context.
 * @returns the store, or `undefined` when the composition has none.
 */
export function spillStoreOf(ctx: Context): SpillStore | undefined {
  const lookup = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  const candidate = lookup.call(ctx, 'spillStore') as Partial<SpillStore> | undefined
  return typeof candidate?.saveText === 'function' ? candidate as SpillStore : undefined
}

/**
 * The head of a text, with the rest announced.
 * @param text - the full text.
 * @param lines - how many lines to keep.
 * @returns the preview, or the text itself when it is short enough.
 */
export function preview(text: string, lines: number = PREVIEW_LINES): string {
  const all = text.split('\n')
  if (all.length <= lines) return text
  return [...all.slice(0, lines), `… ${String(all.length - lines)} more lines are in the file.`].join('\n')
}

/**
 * Write one text where the model can read it back.
 * @param text - the text to persist.
 * @param options - where to write, who the result belongs to, and which store to prefer.
 * @returns the path and the retrieval hint.
 */
export async function writeText(text: string, options: {
  readonly dir: string
  readonly toolName: string
  readonly label: string
  readonly sessionId?: string
  readonly callId?: string
  readonly store?: SpillStore
}): Promise<Spilled> {
  const suggestedName = `${options.toolName}-${options.label}.txt`
  if (options.store !== undefined && options.sessionId !== undefined) {
    try {
      const saved = await options.store.saveText({
        owner: { sessionId: options.sessionId },
        source: { kind: 'tool', toolName: options.toolName, callId: options.callId ?? 'unknown', label: options.label },
        suggestedName,
        content: text,
      })
      return { path: String(saved.locator), hint: saved.retrievalHint, bytes: saved.bytes }
    } catch {
      // A store that is down, full, or unauthorized leaves the snapshot worth
      // having: the fallback directory is on the same machine the agent runs on.
    }
  }
  counter += 1
  const safe = suggestedName.replace(/[^A-Za-z0-9._-]/g, '_')
  const path = join(options.dir, `${String(Date.now())}-${String(counter)}-${safe}`)
  await mkdir(options.dir, { recursive: true })
  await writeFile(path, text, 'utf8')
  return { path, hint: `read ${path} with your file tools; grep it if it is long`, bytes: Buffer.byteLength(text) }
}
