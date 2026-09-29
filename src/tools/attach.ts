/**
 * The image half of a screenshot: bytes the model can look at, not just a path.
 *
 * A screenshot written to a file is a fact the caller has to go and fetch, which
 * costs a second call and — when the point of the picture is that something
 * *looks* wrong — a second judgement of the same pixels. The harness's own
 * `read_image` returns an image block beside its text, and its attachments
 * service is what makes that block durable; this module is the same two steps
 * for a capture that was never a file to begin with.
 *
 * Everything here is declared structurally rather than imported, the way the
 * spill store is: this plugin does not depend on the attachment or LLM packages,
 * their peer range is not this plugin's to widen, and the shapes below are the
 * whole of what it uses. The one thing that is *not* optional is the route gate:
 * an image block sent to a model that does not declare image input fails the
 * request, and because the block is part of the tool result it would fail every
 * later request in the conversation too.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { serviceOf } from './spill.ts'

/** A durable reference to one stored image, as the attachment service returns it. */
export interface ImageRef {
  /** Opaque storage identifier. */
  readonly attachmentId: string
  /** Media type verified from the stored bytes. */
  readonly mediaType: string
  /** Exact encoded byte length. */
  readonly bytes: number
  /** Intrinsic encoded width in pixels. */
  readonly width: number
  /** Intrinsic encoded height in pixels. */
  readonly height: number
  /** Optional display name. */
  readonly name?: string
  /** Dimensions before storage normalized the image; present only when it reduced them. */
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/**
 * One image reference as this plugin reports it.
 *
 * The store's record is copied field by field rather than passed through. The
 * declared output schema refuses any property it does not name, so a store that
 * answers with one field more than this plugin reports turns a capture that
 * already happened into an invalid tool result: measured 2026-09-29 in this GUI,
 * the real store answers with `name` (`ImageAttachmentRef` carries `name?` and
 * `originalDimensions?`) while this plugin declared five fields, and the
 * screenshot came back as `"value.image.name" is not a declared property`. The
 * harness's own `read_image` maps its reference the same way, for the same
 * reason: what this plugin reports is this plugin's decision, not the store's
 * record shape.
 * @param saved - the reference the attachment service returned.
 * @returns the reference narrowed to the fields this plugin declares.
 */
export function imageRefOf(saved: ImageRef): ImageRef {
  return {
    attachmentId: saved.attachmentId,
    mediaType: saved.mediaType,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
    ...saved.name === undefined ? {} : { name: saved.name },
    ...saved.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...saved.originalDimensions } },
  }
}

/**
 * The harness attachment service, as far as this plugin uses it.
 *
 * Declared structurally rather than imported: the shape is the whole of the
 * contract, and a composition without the service is a capability this plugin
 * reports rather than a reason not to load.
 */
export interface AttachmentStore {
  /**
   * Persist one image.
   * @param input - the encoded bytes, their media type, and an optional name.
   * @returns the durable reference the image block carries.
   */
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<ImageRef>
}

/** The harness LLM service, as far as this plugin uses it. */
export interface LlmService {
  /**
   * Resolve what a provider and model can do.
   * @param provider - the provider id.
   * @param model - the model id.
   * @param signal - the calling tool's cancellation.
   * @returns the model's declared capabilities.
   */
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly inputModalities?: readonly string[] }>
}

/**
 * The attachment service, when the composition mounts one.
 * @param ctx - the plugin context.
 * @returns the store, or `undefined` when the composition has none.
 */
export function attachmentStoreOf(ctx: Context): AttachmentStore | undefined {
  const candidate = serviceOf(ctx, 'attachments') as Partial<AttachmentStore> | undefined
  return typeof candidate?.saveImage === 'function' ? candidate as AttachmentStore : undefined
}

/**
 * The LLM service, when the composition mounts one.
 * @param ctx - the plugin context.
 * @returns the service, or `undefined` when the composition has none.
 */
export function llmServiceOf(ctx: Context): LlmService | undefined {
  const candidate = serviceOf(ctx, 'llm') as Partial<LlmService> | undefined
  return typeof candidate?.resolveModelInfo === 'function' ? candidate as LlmService : undefined
}

/**
 * The model route a call is running under, as the plugin can read it.
 * @param exec - the execution the call runs in.
 * @returns the provider and model, each when the route names one.
 */
function routeOf(exec: ToolRunContext): { provider: string | undefined; model: string | undefined } {
  // Structural on purpose: the agent's own type belongs to another package, and
  // only these three fields are read.
  const agent = exec.agent as unknown as {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    options?: { provider?: string; model?: string }
  } | undefined
  const routed = agent?.session?.requestHeader?.()?.config
  // A route set for the session wins over the agent's own defaults, because that
  // is the route the request will actually take.
  return { provider: routed?.provider ?? agent?.options?.provider, model: routed?.model ?? agent?.options?.model }
}

/**
 * Refuse to inline an image the calling model could not look at.
 *
 * The harness states the rule in `read_image`: an image block is useful only
 * when the exact calling route can inspect its result, and the failure mode is
 * not a wasted token — the block rides the tool result into every later request,
 * so a route that cannot take images breaks the conversation rather than the
 * call. The refusal names the way out, which is the file the caller can still
 * read.
 * @param ctx - the plugin context, for the optional `llm` service.
 * @param exec - the execution the call runs in.
 * @param subject - what is being inlined, for the refusal text.
 * @throws {Error} when the route cannot be resolved, or does not declare image input.
 */
export async function assertImageRoute(ctx: Context, exec: ToolRunContext, subject: string): Promise<void> {
  const llm = llmServiceOf(ctx)
  if (llm === undefined) {
    throw new Error(
      `dsh-browser: ${subject} cannot be inlined because this composition mounts no llm service; `
      + 'drop inline to get the file path instead',
    )
  }
  const { provider, model } = routeOf(exec)
  if (provider === undefined || model === undefined) {
    throw new Error(
      `dsh-browser: ${subject} cannot be inlined because the current model route could not be resolved; `
      + 'drop inline to get the file path instead',
    )
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `dsh-browser: ${subject} cannot be inlined because model "${model}" does not declare image input; `
      + 'drop inline to get the file path instead',
    )
  }
}
