/**
 * The inline-image gate: what a screenshot may attach, and when it must not.
 *
 * A tool result carrying an image block is not a local decision. The block rides
 * the conversation, so a route that cannot take images fails the *request* — and
 * because the block is part of an appended tool result, it fails every later
 * request too. That is why the harness's own `read_image` refuses instead of
 * attaching and hoping, and why the same refusal is asserted here rather than
 * left to the adapter to produce a stranger failure.
 *
 * The services are structural: this plugin does not depend on the attachment or
 * LLM packages, and the fake below is the shape it uses rather than a stand-in
 * for a type it imports.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  assertImageRoute,
  attachmentStoreOf,
  imageRefOf,
  llmServiceOf,
  type AttachmentStore,
  type ImageRef,
  type LlmService,
} from '../src/tools/attach.ts'

/** The reference a fake store hands back. */
const REF: ImageRef = {
  attachmentId: 'att-1',
  mediaType: 'image/jpeg',
  bytes: 4,
  width: 300,
  height: 100,
}

/**
 * A context with the named services mounted.
 * @param services - service name to value.
 * @returns the context, as the plugin's own context type.
 */
function contextWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/**
 * The execution a call runs in, with a resolved model route.
 * @param provider - the routed provider.
 * @param model - the routed model.
 * @returns the execution, as the tools package types it.
 */
function executionAt(provider?: string, model?: string): ToolRunContext {
  return {
    agent: {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: { provider: 'default-provider', model: 'default-model' },
    },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

test('an image reference is reported with exactly the fields this plugin declares', () => {
  // A store's record is wider than this plugin's report — the real one answers
  // with `name`, measured 2026-09-29 — and the declared output schema refuses any
  // property it does not name, so what comes back has to be built from the
  // fields that are declared rather than passed through.
  const answered = {
    ...REF,
    name: 'shot-1790661112880.jpg',
    originalDimensions: { width: 600, height: 200 },
    storedAt: 'something only the store knows',
  } as ImageRef
  assert.deepEqual(imageRefOf(answered), {
    attachmentId: 'att-1',
    mediaType: 'image/jpeg',
    bytes: 4,
    width: 300,
    height: 100,
    name: 'shot-1790661112880.jpg',
    originalDimensions: { width: 600, height: 200 },
  })
  // Absent optional fields stay absent rather than arriving as `undefined`,
  // which is not a value the schema can express.
  assert.deepEqual(imageRefOf(REF), REF)
})

test('the attachment service is found only when it can actually store an image', () => {
  const store: AttachmentStore = { saveImage: async () => REF }
  assert.equal(attachmentStoreOf(contextWith({ attachments: store })), store)
  assert.equal(attachmentStoreOf(contextWith({})), undefined)
  // Something else mounted under that name is not this service.
  assert.equal(attachmentStoreOf(contextWith({ attachments: { saveText: async () => {} } })), undefined)
  assert.equal(attachmentStoreOf({} as unknown as Context), undefined)
})

test('the llm service is found only when it can resolve a model', () => {
  const llm: LlmService = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  assert.equal(llmServiceOf(contextWith({ llm })), llm)
  assert.equal(llmServiceOf(contextWith({ llm: { resolveModel: async () => ({}) } })), undefined)
  assert.equal(llmServiceOf(contextWith({})), undefined)
})

test('a route that declares image input may inline', async () => {
  const asked: string[] = []
  const ctx = contextWith({
    llm: {
      resolveModelInfo: async (provider: string, model: string) => {
        asked.push(`${provider}/${model}`)
        return { inputModalities: ['text', 'image'] }
      },
    },
  })
  await assert.doesNotReject(() => assertImageRoute(ctx, executionAt('p', 'vision'), 'the screenshot'))
  // The session's route wins over the agent's defaults: it is the route the
  // request will actually take.
  assert.deepEqual(asked, ['p/vision'])
})

test('a route with no image input is refused, and told what to do instead', async () => {
  const ctx = contextWith({ llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } })
  await assert.rejects(
    () => assertImageRoute(ctx, executionAt('p', 'plain'), 'the screenshot'),
    /model "plain" does not declare image input; drop inline to get the file path instead/,
  )
})

test('a route that cannot be resolved is refused rather than guessed at', async () => {
  const ctx = contextWith({ llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } })
  const unnamed = { agent: {}, signal: new AbortController().signal } as unknown as ToolRunContext
  await assert.rejects(() => assertImageRoute(ctx, unnamed, 'the screenshot'), /route could not be resolved/)
  // A route resolved from the agent's own options is still a route.
  const fallback = { agent: { options: { provider: 'a', model: 'b' } } } as unknown as ToolRunContext
  await assert.doesNotReject(() => assertImageRoute(ctx, fallback, 'the screenshot'))
})

test('a composition with no llm service is refused, because nothing can say the model is capable', async () => {
  await assert.rejects(
    () => assertImageRoute(contextWith({}), executionAt('p', 'vision'), 'the screenshot'),
    /mounts no llm service; drop inline to get the file path instead/,
  )
})
