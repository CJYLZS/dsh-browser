/**
 * What PTC mode asks of a tool that native mode never does.
 *
 * Under `ptc`/`both` the model no longer calls a tool by name; it writes a
 * program that reaches the tools as `tools.<name>(args)` through the SDK the
 * harness generates from the registered schemas. Three parts of the contract
 * change, and each can be broken without any native test noticing:
 *
 * 1. **The schema has to compile to a type, not just pass validation.** Our
 *    schemas are authored in `defineTool`'s DSL, and that DSL refuses any
 *    keyword outside the harness's supported subset at construction time — so
 *    an unsupported keyword is loud, not silent, and that half is not what this
 *    file is for. The rendering is: `jsonSchemaToTs` answers `unknown` for a
 *    schema outside the subset *without throwing*, and `register()` accepts a
 *    hand-built `ToolDefinition` that never went through the DSL — measured
 *    2026-09-29 in `.prove/ptc-loud-or-silent.mjs`, where such a tool is
 *    declared in the generated SDK as `handmade: unknown;`. So the assertions
 *    read the generated text, which is the one place the schema, the DSL, and
 *    the model's view of both meet.
 * 2. **The result must be a value, not a sentence.** A binding resolves to the
 *    tool's canonical value, which has to be lossless JSON, because the program
 *    branches on it. `render` still produces the text a human reads — the
 *    program never sees it, and a result that only makes sense as prose is a
 *    result a program cannot use.
 * 3. **A failure is a rejection inside the program.** A tool that refuses must
 *    reject its binding: catchable, carrying the message the model needs to
 *    self-correct, and never mistakable for a success.
 *
 * A fourth thing is the plugin's own quiet decision: which calls may overlap.
 * Only an exact `true` from `isConcurrencySafe` is parallel and everything else
 * — including silence — is exclusive, so a `Promise.all` of browser calls is
 * serialized. That is asserted rather than assumed, because a later tool that
 * declared otherwise would change what the tool *means*, not just how fast it
 * is.
 *
 * The harness below is the real one: a real `ToolRuntime` in `both` mode, the
 * real `tools:sdk` prompt section, and the real `run_code` transport with its
 * real dispatch bridge, so a sub-call here goes through the same pipeline a
 * program's call goes through in production. Two services are stood in for,
 * both of them seams this plugin does not own: `systemPrompt` (the section
 * registry, which is only asked to render) and `ptcRuntime` (the language
 * backend). The backend is the one piece that cannot run here at all — the real
 * one executes the program in a sandboxed child process — so the stand-in runs
 * the program body in this process, which is faithful for everything a browser
 * tool can observe and unfaithful in exactly two ways that cannot matter for
 * these assertions: there is no isolation, and erasable TypeScript annotations
 * are not stripped, so the programs below are written as plain JavaScript.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { RUN_CODE_NAME, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BrowserPool } from '../src/browser/pool.ts'
import { Config, plainConfig } from '../src/config.ts'
import { INLINE_CHARS } from '../src/tools/spill.ts'
import { registerTools } from '../src/tools/index.ts'
import { fakeLauncher, type FakeLaunch, type FakePage } from './support/browser.ts'

/** The tree the fake Chrome answers a snapshot with: one field and one button, so a ref exists to click. */
const AX_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 31 },
  ],
}

/** A box whose centre is (20, 30), for the fallback path a click only takes when the page cannot answer. */
const QUADS = { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }

/**
 * What the page answers about a press on a ref's element.
 *
 * It is deliberately an answer a *typing* probe cannot read: typing reads
 * `accepts`/`why` from the same call, and an unreadable answer is documented to
 * leave the text unblocked, so one fixture serves both actions the way a real
 * page would answer two different questions with two different shapes.
 */
const PRESS = { ok: true, x: 20, y: 30, moved: false, inView: true, mine: true, over: null }

/** The metrics the snapshot's page info reads; the fake launcher's own answer carries no content size. */
const METRICS = {
  cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
  cssLayoutViewport: { pageX: 5, pageY: 7 },
  cssContentSize: { width: 1280, height: 1440 },
}

/**
 * One lossless-JSON call per tool, in the order a single program must make them.
 *
 * This table is the coverage contract, not a convenience: the suite asserts the
 * registry's visible names equal these keys, so a seventh tool fails here until
 * somebody writes its PTC call — which is the whole point of testing the surface
 * instead of testing six tools. The order is load-bearing and follows the tool
 * semantics: the page must be opened before it can be read, and read before a
 * ref exists to act on.
 */
const PTC_CALLS: Readonly<Record<string, unknown>> = {
  browser_navigate: { url: 'https://example.test/form' },
  browser_snapshot: {},
  browser_click: { ref: 'e2' },
  browser_type: { ref: 'e1', value: 'a@b.c' },
  browser_wait: { text: 'Send', timeoutMs: 200 },
  browser_console: {},
  browser_evaluate: { expression: '1 + 1' },
  browser_screenshot: {},
}

/** What a program is handed as its bindings: one async callable per visible tool. */
type Bindings = Record<string, (args: unknown) => Promise<unknown>>

/** The stand-in language backend, plus the record this suite asserts against. */
interface FakeRuntime {
  /** The language whose SDK and `run_code` flavor the registry must select. */
  readonly language: string
  /** The provider's own resolve step: it supplies the directory and deadline it requires. */
  resolve(request: Record<string, unknown>): Record<string, unknown>
  /** Run one program body against the bindings, the way a backend does. */
  run(spec: { program: string; bindings: { functions: Bindings }[] }): Promise<unknown>
  /** Every binding the last program called, in order. */
  readonly called: string[]
  /** The program text the registry last asked to run. */
  lastProgram: string | undefined
}

/** One prompt section registration, kept so the suite can render the real text. */
interface PromptStub {
  section(section: { name: string; text: (context: { scope?: unknown }) => string }): void
  tools(provider: unknown): void
  getSectionOrder(name: string): number
}

/**
 * What one program did, with the transport's own envelope taken off.
 *
 * `run_code` resolves `{ logs, result }` rather than the program's value, so an
 * assertion that read the envelope would pass on `[object Object]`. Unwrapping
 * once here keeps every test below speaking about the program.
 */
interface RunOutcome {
  /** Whether the run failed — an uncaught rejection, a budget, or a dead backend. */
  readonly failed: boolean
  /** The program's completion value, absent when it returned nothing or failed. */
  readonly value: unknown
  /** The failure text the model would read. */
  readonly message: string
  /** The structured failure code, when the harness classified one. */
  readonly code: string | undefined
}

/** The harness a PTC test drives. */
interface Harness {
  /** The context carrying the real registry. */
  readonly ctx: Context
  /** The browsers the tools drive, one per session. */
  readonly pool: BrowserPool
  /** The fake launcher's record of started browsers. */
  readonly launch: FakeLaunch
  /** The page the fixture session's browser starts on, with the CDP answers set. */
  readonly page: FakePage
  /** Every visible tool name except the transport's own. */
  readonly names: string[]
  /** The registered definitions, for the schema assertions. */
  readonly definitions: ToolDefinition[]
  /** The stand-in backend, for asserting what a program called. */
  readonly runtime: FakeRuntime
  /**
   * The `tools:sdk` section text — exactly what a PTC mode model is handed.
   * @returns the generated SDK, or throws when the section was never registered.
   */
  sdk(): string
  /**
   * Run one program through the real `run_code` transport.
   * @param code - the body of an async function, as the SDK asks for it.
   * @param agent - the calling session; `null` models a call with none.
   * @returns what the program did, with the transport's envelope removed.
   */
  run(code: string, agent?: Agent | null): Promise<RunOutcome>
  /**
   * How the registry would schedule one call.
   * @param name - the tool name.
   * @param args - the arguments the call declares.
   * @returns the scheduling mode.
   */
  mode(name: string, args: unknown): { kind: 'parallel' | 'exclusive' }
}

/** A logger the tests do not read; nothing here is expected to log. */
function quietLogger(): Context['logger'] {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Context['logger']
}

/**
 * A structural stand-in for the calling agent.
 *
 * Only two facts are read from it: the id the tools attribute a browser to, and
 * the session the transport reads a working directory and appends dispatch
 * events to.
 * @param id - the session id.
 * @returns the agent, as the registry's input type.
 */
function agentFor(id: string): Agent {
  return { id, session: { header: {}, append: () => {} } } as unknown as Agent
}

/**
 * Teach one fake page the protocol calls the six tools make.
 *
 * A snapshot needs the tree, a click needs the page to say where its box is and
 * what a press there reaches, and both need layout metrics for the page info.
 * @param page - the fake page to answer on.
 */
function answerPage(page: FakePage): void {
  page.cdp.answers.set('Accessibility.getFullAXTree', AX_TREE)
  page.cdp.answers.set('Page.getLayoutMetrics', METRICS)
  page.cdp.answers.set('DOM.getContentQuads', QUADS)
  page.cdp.answers.set('DOM.resolveNode', { object: { objectId: 'ref-node' } })
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: PRESS } })
}

/**
 * Build the harness: a real registry in PTC-presentation mode over a fake browser.
 * @param options - the presentation mode, and whether to start and answer the fixture browser up front.
 * @returns the ready harness.
 */
async function ptcHarness(options: { mode?: 'ptc' | 'both'; warm?: boolean } = {}): Promise<Harness> {
  const launch = fakeLauncher()
  const ctx = new Context()

  /** Section bodies by name, so the suite can render what a model would be given. */
  const sections = new Map<string, (context: { scope?: unknown }) => string>()
  const systemPrompt: PromptStub = {
    // The registry publishes its visible schemas through this provider. Nothing
    // here asserts on that projection — `schemas()` and `get()` are the same
    // view and are easier to read — so the callback is only swallowed.
    tools: () => {},
    section: (section) => { sections.set(section.name, section.text) },
    getSectionOrder: (name) => name === 'PTC_ONLY' ? 10 : 20,
  }
  ctx.provide('systemPrompt', systemPrompt)

  /** Every binding the last program called, in order. */
  const called: string[] = []
  const runtime: FakeRuntime = {
    language: 'typescript',
    called,
    lastProgram: undefined,
    resolve: request => ({ ...request, cwd: process.cwd(), timeoutMs: 120_000 }),
    async run(spec) {
      runtime.lastProgram = spec.program
      const supplied = spec.bindings[0]?.functions ?? {}
      const bindings: Bindings = {}
      for (const [name, call] of Object.entries(supplied)) {
        bindings[name] = (args) => { called.push(name); return call(args) }
      }
      try {
        // The program body is the body of an async function, exactly as the
        // `run_code` schema describes it, so `return` and `await` are available
        // at its top level. Erasable annotations are NOT stripped here, which is
        // why the programs in this file are plain JavaScript.
        const program = new Function('tools', `"use strict"; return (async () => {\n${spec.program}\n})()`) as (tools: Bindings) => Promise<unknown>
        const value = await program(bindings)
        // A real backend fails the run rather than substituting a rendered
        // string when the completion value cannot cross the JSON boundary.
        if (value !== undefined) {
          try {
            if (JSON.stringify(value) === undefined) {
              return { logs: [], error: { kind: 'invalid-output', message: 'the program returned a value that is not JSON' } }
            }
          } catch {
            return { logs: [], error: { kind: 'invalid-output', message: 'the program returned a value that could not be encoded' } }
          }
        }
        return { logs: [], ...value === undefined ? {} : { value } }
      } catch (error) {
        return {
          logs: [],
          error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) },
        }
      }
    },
  }
  ctx.provide('ptcRuntime', runtime)

  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'both' })

  const pool = new BrowserPool(plainConfig(Config({})), quietLogger(), launch.launch, async () => true)
  registerTools(ctx, pool)

  // A fake page only exists once its browser has launched, and the tools launch
  // lazily on first use — so the fixture session is started here, which is also
  // what lets every CDP answer be in place before the first program runs.
  if (options.warm !== false) {
    await pool.get('session-a').ensure()
    const page = launch.browsers[0]?.pages[0]
    assert.ok(page !== undefined, 'the fixture browser did not start')
    answerPage(page)
  }

  const names = ctx.tools.schemas()
    .map(schema => schema.name)
    .filter(name => name !== RUN_CODE_NAME)
  const definitions = names.map((name) => {
    const definition = ctx.tools.get(name)
    assert.ok(definition !== undefined, `"${name}" is visible but has no definition`)
    return definition
  })

  let calls = 0
  return {
    ctx,
    pool,
    launch,
    page: launch.browsers[0]?.pages[0] as FakePage,
    names,
    definitions,
    runtime,
    sdk: () => {
      const render = sections.get('tools:sdk')
      assert.ok(render !== undefined, 'the registry registered no tools:sdk section')
      return render({ scope: undefined })
    },
    run: async (code, agent = agentFor('session-a')) => {
      const outcome = await ctx.tools.execute({
        callId: `call-${String(++calls)}`,
        name: RUN_CODE_NAME,
        arguments: { code, description: 'drive the browser tools' },
        signal: new AbortController().signal,
        ...agent === null ? {} : { agent },
      }) as {
        isError: boolean
        value?: { logs?: string[]; result?: unknown }
        error?: { message: string; info?: { code?: string } }
      }
      return {
        failed: outcome.isError,
        value: outcome.isError ? undefined : outcome.value?.result,
        message: outcome.error?.message ?? '',
        code: outcome.error?.info?.code,
      }
    },
    mode: (name, args) => ctx.tools.executionMode({
      callId: 'mode-probe',
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: agentFor('session-a'),
    }),
  }
}

/**
 * A program that calls every tool once, in the table's order.
 * @returns the program body.
 */
function programCallingEveryTool(): string {
  return [
    'const answers = {}',
    ...Object.entries(PTC_CALLS).map(([name, args]) =>
      `answers[${JSON.stringify(name)}] = await tools[${JSON.stringify(name)}](${JSON.stringify(args)})`),
    'return answers',
  ].join('\n')
}

test('the visible tool surface is exactly the six the PTC call table covers', async () => {
  const h = await ptcHarness()
  // Not a count for its own sake: this is what makes the suite a gate. A new
  // tool changes this set, the table above has to gain its PTC call, and the
  // program test below then drives it like the rest.
  assert.deepEqual([...h.names].sort(), Object.keys(PTC_CALLS).sort())
})

test('every tool name is a bare identifier the SDK can declare without quotes', async () => {
  const h = await ptcHarness()
  for (const name of h.names) {
    assert.match(
      name,
      /^[A-Za-z_$][A-Za-z0-9_$]*$/,
      `"${name}" would be declared as tools["${name}"]; the skill tells the model to write tools.${name}`,
    )
  }
})

test('the generated SDK declares every tool with an argument type a program can use', async () => {
  const h = await ptcHarness()
  const sdk = h.sdk()
  assert.match(sdk, /declare const tools:/)
  // The program's error type is the SDK's, so a tool failure is typed where the
  // model reads it; the registry's bridge is what makes a rejection carry it.
  assert.match(sdk, /declare class ToolCallError extends Error/)
  for (const definition of h.definitions) {
    const args = jsonSchemaToTs(definition.parameters, 1)
    const output = jsonSchemaToTs(definition.output.schema, 1)
    assert.notEqual(
      args,
      'unknown',
      `${definition.name}'s parameters render as unknown, so a program cannot see its arguments`,
    )
    assert.notEqual(
      output,
      'unknown',
      `${definition.name}'s output renders as unknown, so a program cannot use its result`,
    )
    // Present in both maps: the call signature and the resolved value.
    assert.match(sdk, new RegExp(`\\n  ${definition.name}: `), `${definition.name} is missing from the SDK`)
    // A parameter the tool requires must not be declared optional: a program
    // that omits it would be refused at dispatch instead of by its own editor.
    const required = (definition.parameters as { required?: string[] }).required ?? []
    for (const parameter of required) {
      assert.match(
        args,
        new RegExp(`\\n\\s*${parameter}: `),
        `${definition.name}.${parameter} is required but the SDK declares it optional`,
      )
    }
  }
})

test('the arguments a tool needs are named in the SDK, not erased', async () => {
  const h = await ptcHarness()
  const navigate = h.definitions.find(definition => definition.name === 'browser_navigate')
  const click = h.definitions.find(definition => definition.name === 'browser_click')
  assert.ok(navigate !== undefined && click !== undefined)
  assert.match(jsonSchemaToTs(navigate.parameters, 1), /url: string/)
  // An enum keeps its literals, which is what tells a program which buttons exist.
  assert.match(jsonSchemaToTs(click.parameters, 1), /button\?: "left" \| "right" \| "middle"/)
  // The output side carries the fields a program branches on.
  assert.match(jsonSchemaToTs(click.output.schema, 1), /changed: string\[\]/)
  assert.match(jsonSchemaToTs(click.output.schema, 1), /settled: boolean/)
  // A change is an object a program reads fields off, not prose it has to parse,
  // and its kind keeps its literals so a program can switch on what happened.
  assert.match(
    jsonSchemaToTs(click.output.schema, 1),
    /changes\?: \(\{\s+kind: "added" \| "removed" \| "attribute" \| "text";/,
  )
  assert.match(jsonSchemaToTs(click.output.schema, 1), /preview\?: string/)
})

test('a program can branch on what the page changed', async () => {
  const h = await ptcHarness()
  // The record a settled page hands back, as the page itself would answer it.
  const observation = {
    mutations: 1,
    settled: true,
    changes: [{ kind: 'added', tag: 'div', role: 'status', preview: 'Saved' }],
    omitted: 2,
  }
  h.page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'])
    if (expression.includes('MutationObserver')) return { result: { value: 0 } }
    if (expression.includes('__dshSettle')) return { result: { value: observation } }
    return { result: { value: 'evaluated' } }
  })
  const result = await h.run([
    'await tools.browser_snapshot({})',
    'const report = await tools.browser_click({ ref: "e2" })',
    'const first = report.changes[0]',
    'return { changed: report.changed, kind: first.kind, role: first.role, preview: first.preview, omitted: report.changesOmitted }',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  assert.deepEqual(result.value, {
    changed: ['dom'],
    kind: 'added',
    role: 'status',
    preview: 'Saved',
    omitted: 2,
  })
})

test('one program can drive every tool, and each answers with a value', async () => {
  const h = await ptcHarness()
  const result = await h.run(programCallingEveryTool())
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  const answers = result.value as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(answers).sort(), Object.keys(PTC_CALLS).sort())

  for (const [name, answer] of Object.entries(answers)) {
    assert.equal(typeof answer, 'object', `${name} resolved to ${JSON.stringify(answer)} instead of a value`)
    assert.notEqual(answer, null, `${name} resolved to null`)
  }

  // The page's address, as a value rather than the sentence `render` writes.
  assert.equal(answers.browser_navigate?.['url'], 'https://example.test/form')
  // Reading the page is what mints the refs the next two calls used, in a
  // different sub-dispatch: refs belong to the page, not to the call.
  assert.match(String(answers.browser_snapshot?.['text']), /button "Send" \[ref=e2\]/)
  assert.deepEqual(answers.browser_click?.['element'], { role: 'button', name: 'Send' })
  assert.equal(answers.browser_click?.['ref'], 'e2')
  assert.equal(answers.browser_type?.['value'], 'a@b.c')
  assert.deepEqual(answers.browser_type?.['element'], { role: 'textbox', name: 'Email' })
  // A wait answers with a value a program branches on: whether it matched, and
  // how long it took to find out.
  assert.equal(answers.browser_wait?.['matched'], true)
  assert.equal(typeof answers.browser_wait?.['waitedMs'], 'number')
  assert.equal(typeof answers.browser_evaluate?.['result'], 'string')
  // The console is a value too: a program branches on what the page said about
  // itself rather than reading a sentence about it.
  assert.equal(Array.isArray(answers.browser_console?.['entries']), true)
  assert.equal(typeof answers.browser_console?.['total'], 'number')

  // A screenshot's value is a path and a size, and both are true.
  const path = String(answers.browser_screenshot?.['path'])
  assert.match(path, /\.jpg$/)
  assert.ok(existsSync(path), `the screenshot was not written to ${path}`)
  assert.equal(statSync(path).size, answers.browser_screenshot?.['bytes'])

  // The binding boundary promises lossless JSON, so the value has to survive it.
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), answers)
  // And the program text reached the backend as written, because the registry
  // hands the body to the runtime rather than interpreting it.
  assert.match(String(h.runtime.lastProgram), /answers\["browser_snapshot"\] = await tools\["browser_snapshot"\]\(\{\}\)/)
  assert.deepEqual(h.runtime.called, Object.keys(PTC_CALLS))
})

test('a program can read why an action left no trace', async () => {
  const h = await ptcHarness()
  // The failure this exists for: a click whose handler threw before it could
  // change anything. The change list is empty and the accessibility tree is
  // unchanged, so the console is the only evidence there is.
  h.page.cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1_700_000_000_000,
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'TypeError: save is not a function' },
      url: 'https://example.test/app.js',
      lineNumber: 3,
    },
  })
  h.page.cdp.emit('Runtime.consoleAPICalled', {
    type: 'error',
    timestamp: 1_700_000_000_001,
    args: [{ type: 'string', value: 'save failed' }],
  })
  const result = await h.run([
    'await tools.browser_snapshot({})',
    'const report = await tools.browser_click({ ref: "e2" })',
    'if (report.changed.length > 0) return { explained: true, why: "the page changed" }',
    'const said = await tools.browser_console({ levels: ["error"] })',
    'return { explained: said.entries.length > 0, first: said.entries[0].message, level: said.entries[0].level }',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  assert.deepEqual(result.value, {
    explained: true,
    first: 'TypeError: save is not a function',
    level: 'error',
  })
})

test('a result too large to print crosses the bridge as a preview and a path', async () => {
  const h = await ptcHarness()
  // The reference runtime puts no cap on a program's return value at all, and
  // measured friction is what a cap is for here: one expression that read a whole
  // document returned 387 KB. The value is written whole, never cut, so the
  // program can still get all of it — it just has to ask the filesystem.
  const whole = 'line of the document\n'.repeat(4_000)
  assert.ok(whole.length > INLINE_CHARS, 'the fixture is not large enough to spill')
  h.page.cdp.answers.set('Runtime.evaluate', { result: { value: whole } })
  const result = await h.run([
    'const answer = await tools.browser_evaluate({ expression: "document.body.textContent" })',
    'return { truncated: answer.truncated, path: answer.path, kept: answer.result.length }',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  const value = result.value as { truncated: boolean; path: string; kept: number }
  assert.equal(value.truncated, true, 'a spilling result did not say it was cut')
  assert.ok(value.kept < whole.length, 'the whole result came back inline anyway')
  try {
    assert.equal(readFileSync(value.path, 'utf8'), whole)
  } finally {
    rmSync(value.path, { force: true })
  }
})

test('a tool that refuses rejects its binding, and the program can catch it', async () => {
  const h = await ptcHarness()
  // No snapshot has been taken, so the ref names nothing. That is the refusal a
  // model meets, reached here through the bridge instead of a native call.
  const result = await h.run([
    'try {',
    '  await tools.browser_click({ ref: "e9" })',
    '  return "the click was accepted"',
    '} catch (error) {',
    '  return "caught " + error.message',
    '}',
  ].join('\n'))
  assert.equal(result.failed, false, 'a caught tool failure failed the whole run')
  assert.match(String(result.value), /^caught /)
  // The message has to be the one that tells the model what to do next, since
  // the program's only recovery is to read it.
  assert.match(String(result.value), /browser_snapshot/)
})

test('a tool that refuses fails the run when the program does not catch it', async () => {
  const h = await ptcHarness()
  const result = await h.run('return await tools.browser_click({ ref: "e9" })')
  assert.equal(result.failed, true, 'a tool failure the program never caught was reported as a success')
  assert.equal(result.code, 'CODE_RUN_FAILED')
  assert.match(result.message, /code run failed \(exception\)/)
  assert.match(result.message, /browser_snapshot/)
})

test('an argument the tool does not accept is refused at the binding', async () => {
  const h = await ptcHarness()
  // Arguments cross the same validation as a native call: a program that passes
  // a number where an address belongs gets a rejection, not a navigation.
  const result = await h.run([
    'try {',
    '  await tools.browser_navigate({ url: 42 })',
    '  return "accepted"',
    '} catch (error) {',
    '  return error.message',
    '}',
  ].join('\n'))
  assert.equal(result.failed, false)
  assert.notEqual(result.value, 'accepted')
  assert.match(String(result.value), /url/)
})

test('under ptc the model cannot call a browser tool directly, and a program still can', async () => {
  const h = await ptcHarness({ mode: 'ptc' })
  const direct = await h.ctx.tools.execute({
    callId: 'direct-1',
    name: 'browser_snapshot',
    arguments: {},
    signal: new AbortController().signal,
    agent: agentFor('session-a'),
  }) as { isError: boolean; error?: { info?: { code?: string } } }
  // This is what makes the surface a PTC surface: the name is visible in the
  // prompt and still refused as a model-direct call.
  assert.equal(direct.isError, true)
  assert.equal(direct.error?.info?.code, 'UNKNOWN_TOOL')
  // The same name, one sub-dispatch deeper, runs — so the tools do not depend on
  // being reachable by name.
  const result = await h.run('return await tools.browser_snapshot({})')
  assert.equal(result.failed, false, `the sub-dispatch was refused too: ${result.message}`)
})

test('every tool is exclusive, so a program cannot put two calls in the page at once', async () => {
  const h = await ptcHarness()
  for (const definition of h.definitions) {
    // Silence is the mechanism, and it is the right one for a tool that drives a
    // single mutable browser: only an exact `true` would opt a call into a
    // parallel group, so nothing here may ever return one.
    assert.equal(
      definition.isConcurrencySafe,
      undefined,
      `${definition.name} declares a concurrency classifier; a browser call that overlaps another changes what the tool means`,
    )
    assert.deepEqual(
      h.mode(definition.name, {}),
      { kind: 'exclusive' },
      `${definition.name} is classified parallel by the registry`,
    )
  }
})

test('two calls a program starts together reach the page one at a time', async () => {
  const h = await ptcHarness()
  let inFlight = 0
  let peak = 0
  h.page.cdp.answers.set('Runtime.evaluate', async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => { setTimeout(resolve, 5) })
    inFlight -= 1
    return { result: { value: 'evaluated' } }
  })
  const result = await h.run([
    'return await Promise.all([',
    '  tools.browser_evaluate({ expression: "1" }),',
    '  tools.browser_evaluate({ expression: "2" }),',
    '])',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  assert.equal(peak, 1, 'two browser calls were in the page at the same time')
  assert.deepEqual(h.runtime.called, ['browser_evaluate', 'browser_evaluate'])
})

test('a program drives the browser of the session that ran it, not another one', async () => {
  const h = await ptcHarness()
  await h.run('return await tools.browser_evaluate({ expression: "location.href" })', agentFor('session-a'))
  const first = h.launch.browsers[0]?.pages[0]?.cdp.method('Runtime.evaluate').length ?? 0
  assert.ok(first > 0, 'the fixture session\'s program never reached its own browser')

  await h.run('return await tools.browser_evaluate({ expression: "location.href" })', agentFor('session-b'))
  assert.equal(h.launch.browsers.length, 2, 'the second session was handed the first session\'s browser')
  assert.equal(
    h.launch.browsers[0]?.pages[0]?.cdp.method('Runtime.evaluate').length,
    first,
    "session-b's program ran inside session-a's browser",
  )
  assert.ok((h.launch.browsers[1]?.pages[0]?.cdp.method('Runtime.evaluate').length ?? 0) > 0)
})

test('a program with no session fails instead of driving somebody else\'s browser', async () => {
  const h = await ptcHarness({ warm: false })
  const result = await h.run([
    'try {',
    '  await tools.browser_snapshot({})',
    '  return "accepted"',
    '} catch (error) {',
    '  return error.message',
    '}',
  ].join('\n'), null)
  assert.equal(result.failed, false)
  assert.match(String(result.value), /this call has no session/)
  // The refusal has to come before the pool is ever asked: a scheduled job that
  // landed in a conversation's browser would be the isolation bug this checks for.
  assert.equal(h.launch.browsers.length, 0, 'a browser was started for a program with no session')
})

test('a failure a tool reports is not mistaken for a result the program can use', async () => {
  const h = await ptcHarness()
  // A refusal resolves the binding as a rejection rather than as a value, so a
  // program that ignores the distinction cannot end up with prose where it
  // expected a page. Returning what it caught proves the difference is visible.
  const result = await h.run([
    'const answers = {}',
    'for (const ref of ["e9"]) {',
    '  try {',
    '    answers[ref] = await tools.browser_click({ ref })',
    '  } catch (error) {',
    '    answers[ref] = { refused: true }',
    '  }',
    '}',
    'return answers',
  ].join('\n'))
  assert.equal(result.failed, false)
  assert.deepEqual(result.value, { e9: { refused: true } })
})

test('a locator is an argument a program can pass, and the refusal is catchable', async () => {
  const h = await ptcHarness()
  // The locator crosses the same lossless-JSON boundary a ref does, and the
  // tool refuses an ambiguous one inside the program rather than choosing.
  const result = await h.run([
    'const answers = {}',
    'try {',
    '  answers.click = await tools.browser_click({ role: "button", name: "Send" })',
    '} catch (error) {',
    '  answers.click = { refused: error.message }',
    '}',
    'try {',
    '  await tools.browser_click({ ref: "e2", role: "button" })',
    '  answers.mixed = "accepted"',
    '} catch (error) {',
    '  answers.mixed = error.message',
    '}',
    'try {',
    '  await tools.browser_click({ name: "Send" })',
    '  answers.orphanName = "accepted"',
    '} catch (error) {',
    '  answers.orphanName = error.message',
    '}',
    'return answers',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  const answers = result.value as Record<string, Record<string, unknown> | string>
  // A role and name resolved against the page the program is looking at.
  assert.equal((answers['click'] as Record<string, unknown>)['element'] !== undefined, true)
  assert.deepEqual((answers['click'] as Record<string, unknown>)['element'], { role: 'button', name: 'Send' })
  // Both refusals arrive as messages the program can read and branch on.
  assert.match(String(answers['mixed']), /both ref and a locator/)
  assert.match(String(answers['orphanName']), /name without role/)
})

test('both element-naming tools offer the same locator set, and text is a locator on both', async () => {
  const h = await ptcHarness()
  const sdk = h.sdk()
  const click = h.definitions.find(definition => definition.name === 'browser_click')
  const type = h.definitions.find(definition => definition.name === 'browser_type')
  assert.ok(click !== undefined && type !== undefined)
  const clickArgs = jsonSchemaToTs(click.parameters, 1)
  const typeArgs = jsonSchemaToTs(type.parameters, 1)
  // One vocabulary applied to whatever action follows — the shape Playwright's
  // shared locator axes have. `text` names an element on both, so the content
  // parameter had to stop being called `text`: `value` is what the ecosystem
  // calls it (`locator.fill(value)`), and it is what leaves `text` free.
  for (const parameter of ['ref?: ', 'role?: ', 'name?: ', 'text?: ', 'selector?: ']) {
    assert.ok(clickArgs.includes(parameter), `browser_click does not declare ${parameter.trim()}`)
    assert.ok(typeArgs.includes(parameter), `browser_type does not declare ${parameter.trim()}`)
  }
  assert.ok(typeArgs.includes('value?: '), 'browser_type does not declare its content parameter')
  // `text` must be documented as a locator, not as the characters to insert.
  assert.match(sdk, /\n {4}\/\*\* Accessible name to match[^\n]*\n {4}text\?: string;/)
  assert.ok(sdk.includes('role?: string'))
})

test('browser_type can find its field by text without guessing the role', async () => {
  const h = await ptcHarness()
  // The reason `text` had to become a locator on this tool too: naming a field
  // by its role means guessing the role, and the roles that carry a field are
  // `textbox`, `searchbox`, `combobox`, `spinbutton`. A caller that guesses
  // wrong gets "no element matches" and has to snapshot — which is the round
  // trip the locator exists to remove. Here no role is named at all.
  const result = await h.run([
    'return await tools.browser_type({ text: "Email", value: "a@b.c" })',
  ].join('\n'))
  assert.equal(result.failed, false, `the program failed: ${result.message}`)
  const answer = result.value as Record<string, unknown>
  assert.deepEqual(answer['element'], { role: 'textbox', name: 'Email' })
  assert.equal(answer['value'], 'a@b.c')
  // The characters went into the field the text match found, not somewhere else.
  assert.deepEqual(h.runtime.called, ['browser_type'])
})

test('a browser_type call that types text at a ref is told where the characters go', async () => {
  const h = await ptcHarness()
  // The shape a caller trained on the flat `browser_type(text: …)` writes: a ref
  // and the characters together. `text` is a locator now, so this is refused —
  // and the refusal has to name `value`, or it reads as a complaint about
  // locators while the caller's actual mistake was one parameter name.
  const result = await h.run([
    'try {',
    '  await tools.browser_type({ ref: "e1", text: "a@b.c" })',
    '  return "accepted"',
    '} catch (error) {',
    '  return error.message',
    '}',
  ].join('\n'))
  assert.equal(result.failed, false)
  assert.match(String(result.value), /both ref and a locator/)
  assert.match(String(result.value), /pass them as value/)
})

/**
 * The two tests below are about the registry rather than about PTC, and they live
 * here because this is the only suite with a real one: a rendered result's
 * *content blocks* and an argument refusal are both invisible from a pure
 * function, and standing up a second registry harness to observe them would be
 * two homes for one fact.
 */
test('an inlined capture asks the attachments service, and renders its image block', async () => {
  const h = await ptcHarness()
  const saved: { data: Uint8Array; mediaType: string; name?: string }[] = []
  const stored = { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 3, width: 11, height: 9 }
  h.ctx.provide('attachments', {
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      saved.push(input)
      return stored
    },
  })
  h.ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  const result = await h.ctx.tools.execute({
    callId: 'inline-1',
    name: 'browser_screenshot',
    arguments: { inline: true },
    signal: new AbortController().signal,
    // The route the request will take is what the gate reads.
    agent: {
      id: 'session-a',
      session: { header: {}, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'vision' } }) },
    } as unknown as Agent,
  }) as { isError: boolean; content?: { type: string; text?: string; attachment?: unknown }[] }
  assert.equal(result.isError, false)
  assert.deepEqual(saved.map(entry => entry.mediaType), ['image/jpeg'])
  // The fake browser's capture, so this says the bytes went to the store rather
  // than something else having been encoded a second time.
  assert.equal(saved[0]?.data.length, Buffer.from('shot').length)
  assert.deepEqual(saved[0]?.name?.endsWith('.jpg'), true)
  assert.deepEqual(result.content?.[0]?.type, 'text')
  assert.match(String(result.content?.[0]?.text), /The image itself is attached\./)
  assert.deepEqual(result.content?.[1], { type: 'image', attachment: stored })
})

test('an inlined capture on a model without image input is refused before anything is captured', async () => {
  const h = await ptcHarness()
  h.ctx.provide('attachments', { saveImage: async () => ({}) })
  h.ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) })
  const result = await h.ctx.tools.execute({
    callId: 'inline-2',
    name: 'browser_screenshot',
    arguments: { inline: true },
    signal: new AbortController().signal,
    agent: {
      id: 'session-a',
      session: { header: {}, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'plain' } }) },
    } as unknown as Agent,
  }) as { isError: boolean; error?: { message: string } }
  assert.equal(result.isError, true)
  // The whole point of gating first: a route that cannot take an image should not
  // make the page draw one, and the refusal has to name the option that works.
  assert.match(result.error?.message ?? '', /does not declare image input/)
  assert.match(result.error?.message ?? '', /drop inline/)
  assert.deepEqual(h.page.cdp.method('Page.captureScreenshot'), [])
})

test('a capture cannot ask for the whole page and one element at once', async () => {
  const h = await ptcHarness()
  const result = await h.run([
    'try {',
    '  await tools.browser_screenshot({ ref: "e2", fullPage: true })',
    '  return "accepted"',
    '} catch (error) {',
    '  return error.message',
    '}',
  ].join('\n'))
  assert.equal(result.failed, false)
  assert.match(String(result.value), /the whole page and one element are two different pictures/)
})
