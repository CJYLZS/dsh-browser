/**
 * The agent-facing half of the mirror: six tools over the browser belonging to
 * the calling conversation.
 *
 * The set is deliberately small and leans on `browser_evaluate` for everything
 * a short piece of JavaScript expresses better than a parameter list — reading
 * values, scrolling, waiting, going back. What is here is what code cannot do
 * or does badly: a real click (a synthetic `element.click()` is not a trusted
 * event and some sites ignore it), typing that produces input events, reading a
 * page without knowing its selectors first, and a picture.
 *
 * A tool result is written for a model that cannot see the page: it says what
 * the element was, where the page ended up, and whether anything changed, rather
 * than repeating the arguments. A snapshot that had to leave something out says
 * which parameter would have printed it, and a page too large to read inline is
 * written to a file whose path comes back instead (see `spill.ts`).
 *
 * A tool addresses the browser of the session that called it, taken from the
 * execution's agent, so two conversations never touch each other's pages. A
 * call with no session — a scheduled job, or a subagent without one — fails
 * rather than landing in somebody's browser.
 *
 * Every call runs under the caller's cancellation and declares a budget. The
 * harness keeps waiting for the promise a tool body returned, so a body that
 * waits on a browser which never answers is a call that never finishes — and a
 * conversation that cannot be stopped (measured 2026-09-25: a navigation that
 * outlived an interrupt and a turn restart). The body therefore gives up as
 * soon as the signal aborts, and the browser is told to stop what the cancelled
 * call had started.
 *
 * Tools return text and file paths rather than image blocks. An image block
 * carries an attachment reference owned by the attachment service, which a
 * plugin cannot mint for itself, and the shipped adapters declare text-only
 * output besides: a screenshot lands on disk and the model reads it back with
 * its ordinary file tools, which also makes the capture durable in the session
 * log.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { cancelable } from '../browser/cancel.ts'
import type { BrowserPool } from '../browser/pool.ts'
import { formatPageInfo } from '../browser/page-info.ts'
import type { ActionReport, SessionBrowser, TabSummary } from '../browser/session-browser.ts'
import { preview, shouldSpill, spillStoreOf, writeText, type SpillStore } from './spill.ts'

/** Directory screenshots are written to; inside the OS temp area, so it needs no cleanup contract. */
const SHOT_DIR = join(tmpdir(), 'dsh-browser-shots')

/** Directory snapshot spills are written to when the composition mounts no spill store. */
const SNAP_DIR = join(tmpdir(), 'dsh-browser-snapshots')

/**
 * Budget for opening an address, in milliseconds.
 *
 * Larger than the navigation's own 30 s budget on purpose: a page that is merely
 * slow reports Playwright's failure — which names the address and the timeout —
 * and this one is left for a call the browser never comes back from.
 */
const NAVIGATE_TIMEOUT_MS = 45_000

/** Budget for reading or acting on a page, in milliseconds. */
const PAGE_TIMEOUT_MS = 30_000

/**
 * Budget for evaluating in a page, in milliseconds.
 *
 * Larger than the rest because the expression is the caller's own work: waiting
 * for a page, polling an endpoint, and anything else a short program does is a
 * legitimate use of the tool rather than a browser that has stopped answering.
 */
const EVALUATE_TIMEOUT_MS = 120_000

/**
 * Render one evaluated value as text for the model.
 * @param value - the value the page produced.
 * @returns JSON when the value survives encoding, its string form otherwise.
 */
function readable(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    // Only a cyclic or otherwise non-encodable value reaches this: round-tripping
    // such a value is impossible by definition, so its string form is the answer.
    return String(value)
  }
}

/**
 * The open pages, one line each.
 *
 * A tool result carries this because the pages are not the caller's to choose:
 * a link that opens a tab moves the active page, and a caller that could not
 * see that would keep describing the page it left behind.
 * @param tabs - the session's open pages.
 * @returns one line per page, naming the active one.
 */
export function tabsText(tabs: readonly TabSummary[]): string {
  if (tabs.length === 0) return 'No pages are open.'
  return tabs
    .map(tab => `[${tab.active ? 'active' : String(tab.index)}] ${tab.url}`)
    .join('\n')
}

/**
 * What an action did to the page, in the words the model needs.
 *
 * "Nothing changed" is as important as a change: it is the difference between a
 * click that worked and a click that landed on a disabled control, and only the
 * page can say which happened.
 * @param report - what the action reported about the page.
 * @returns one line describing the outcome.
 */
export function changedText(report: ActionReport): string {
  const what = report.changed.length === 0 ? '' : `: ${report.changed.join(', ')}`
  if (!report.settled) {
    return `The page was still changing when this returned${what === '' ? '' : ` (changed${what})`}.`
  }
  if (what === '') return 'The page did not change.'
  return `The page changed${what}.`
}

/**
 * One action result as text: what was acted on, where the page is, what changed.
 * @param subject - the verb and element, e.g. `Clicked button "Send"`.
 * @param report - what the action reported.
 * @param tabs - the session's open pages.
 * @returns the text block a tool result renders.
 */
export function actionText(
  subject: string,
  report: ActionReport,
  tabs: readonly TabSummary[],
): string {
  const title = report.title === '' ? '' : ` — ${JSON.stringify(report.title)}`
  const recovered = report.recovered === true
    ? '\nThe element had been replaced by the page; it was found again by its role and name.'
    : ''
  // A click goes to a point, so saying what was at that point is the difference
  // between "this element does nothing" and "an open menu took the click".
  const covered = report.obstructed === undefined
    ? ''
    : `\nThe click was received by ${describeElement(report.obstructed)}, which is over the element the ref named.`
  return `${subject}.\nPage: ${report.url}${title}\n${changedText(report)}${covered}${recovered}\n\n${tabsText(tabs)}`
}

/**
 * One snapshot result as text: where in the page it was taken, the tree itself,
 * and where the rest of it went when it was too large to return.
 * @param value - the snapshot a tool produced.
 * @returns the text block a tool result renders.
 */
export function snapshotText(value: {
  readonly info: string
  readonly text: string
  readonly path?: string
  readonly hint?: string
  readonly tabs: readonly TabSummary[]
}): string {
  const head = value.info === '' ? '' : `${value.info}\n\n`
  const spilled = value.path === undefined
    ? ''
    : `\n\nThe snapshot is too large to read here; the whole of it is in ${value.path}.`
      + `${value.hint === undefined ? '' : `\n${value.hint}`}`
  return `${head}${value.text}${spilled}\n\n${tabsText(value.tabs)}`
}

/** The reported shape of the page list every navigation-shaped result carries. */
const TABS_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      index: { type: 'integer', required: true },
      url: { type: 'string', required: true },
      active: { type: 'boolean', required: true },
    },
  },
} as const

/** The reported shape of what an action did to the page. */
const ACTION_PROPERTIES = {
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
  changed: {
    type: 'array',
    required: true,
    items: { type: 'string' },
  },
  settled: { type: 'boolean', required: true },
  mutations: { type: 'integer', required: true },
  recovered: { type: 'boolean' },
  element: {
    type: 'object',
    additionalProperties: false,
    properties: {
      role: { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
  },
  obstructed: {
    type: 'object',
    additionalProperties: false,
    properties: {
      role: { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
  },
} as const

/**
 * The browser belonging to the calling session.
 * @param pool - every session's browser.
 * @param exec - the execution the call runs in.
 * @returns the caller's browser, not yet started.
 * @throws {Error} when the call has no session to attribute a browser to.
 */
function browserFor(pool: BrowserPool, exec: ToolRunContext): SessionBrowser {
  const sessionId = exec.agent?.id
  if (sessionId === undefined) {
    throw new Error(
      'dsh-browser: this tool drives the browser of the conversation it was called from, '
      + 'and this call has no session',
    )
  }
  return pool.get(sessionId)
}

/**
 * Register the browser tools for the plugin's lifetime.
 * @param ctx - plugin context carrying the tool registry.
 * @param pool - the browsers the tools drive.
 */
export function registerTools(ctx: Context, pool: BrowserPool): void {
  /** The harness spill store, when the composition mounts one. */
  const store: SpillStore | undefined = spillStoreOf(ctx)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open an address in this conversation\'s local browser. The same browser is mirrored in the Sidebar, so the user sees the page the call lands on.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) address to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ACTION_PROPERTIES,
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\n${changedText(value)}\n\n${tabsText(value.tabs)}`,
      }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      const report = await cancelable(browser, exec.signal, `opening ${args.url}`, () => browser.navigate(args.url))
      return { ...report, changed: [...report.changed], tabs: [...browser.status().tabs] }
    },
    timeoutMs: NAVIGATE_TIMEOUT_MS,
  })), 'dsh-browser: browser_navigate')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Read the current page as a tree of roles, names, and refs. Refs name elements for browser_click and browser_type and stay valid while the page is loaded. Narrow a large page with target or depth; write one too large to read to a file with file.',
    parameters: {
      target: { type: 'string', description: 'A ref from an earlier snapshot, or a CSS selector, to print only that element and what is inside it.' },
      depth: { type: 'integer', description: 'Deepest level to print, counting the top of the tree as 0.' },
      file: { type: 'boolean', description: 'Write the whole snapshot to a file and return its path, for a page too large to read inline.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          info: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          nodes: { type: 'integer', required: true },
          path: { type: 'string' },
          hint: { type: 'string' },
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: snapshotText(value) }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      const snapshot = await cancelable(browser, exec.signal, 'reading the page', () => browser.snapshot({
        ...args.target === undefined ? {} : { target: args.target },
        ...args.depth === undefined ? {} : { depth: args.depth },
      }))
      const info = formatPageInfo(snapshot.info)
      const tabs = [...browser.status().tabs]
      if (!shouldSpill(snapshot.text, args.file === true)) {
        return { text: snapshot.text, info, truncated: snapshot.truncated, nodes: snapshot.nodes, tabs }
      }
      const written = await writeText(snapshot.text, {
        dir: SNAP_DIR,
        toolName: 'browser_snapshot',
        label: 'snapshot',
        ...exec.agent?.id === undefined ? {} : { sessionId: exec.agent.id },
        callId: String(exec.callId),
        ...store === undefined ? {} : { store },
      })
      return {
        text: preview(snapshot.text),
        info,
        truncated: snapshot.truncated,
        nodes: snapshot.nodes,
        path: written.path,
        hint: written.hint,
        tabs,
      }
    },
    timeoutMs: PAGE_TIMEOUT_MS,
  })), 'dsh-browser: browser_snapshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element named by a ref from browser_snapshot, with real mouse events at the element\'s own position. Reports the element, the address the page ended on, whether the page changed, and what received the click when something was over it. A press the page says another element would receive is refused; pass force to send it anyway.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref from a browser_snapshot of the current page, such as e3.' },
      force: { type: 'boolean', description: 'Click even when the page says another element would receive the press, such as an overlay. What received it is then reported instead of refused.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          ...ACTION_PROPERTIES,
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: actionText(`Clicked ${describeElement(value.element)}`, value, value.tabs),
      }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      const report = await cancelable(browser, exec.signal, `clicking ${args.ref}`, () => browser.click(args.ref, {
        ...args.force === undefined ? {} : { force: args.force },
      }))
      return { ref: args.ref, ...report, changed: [...report.changed], tabs: [...browser.status().tabs] }
    },
    timeoutMs: PAGE_TIMEOUT_MS,
  })), 'dsh-browser: browser_click')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an element named by a ref from browser_snapshot, replacing what the field holds. Pass a key such as Enter to submit after typing. An element the page says cannot take text — read-only, disabled, or not a text control — is refused instead of reported as typed into.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref from a browser_snapshot of the current page, such as e3.' },
      text: { type: 'string', required: true, description: 'Text to insert; non-Latin text is inserted as characters, not keystrokes.' },
      key: { type: 'string', description: 'Key to press after typing, such as Enter or Tab.' },
      clear: { type: 'boolean', description: 'Whether to replace the field\'s current content first; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          text: { type: 'string', required: true },
          ...ACTION_PROPERTIES,
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: actionText(`Typed ${JSON.stringify(value.text)} into ${describeElement(value.element)}`, value, value.tabs),
      }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      const report = await cancelable(browser, exec.signal, `typing into ${args.ref}`, () =>
        browser.type(args.ref, args.text, {
          ...args.clear === undefined ? {} : { clear: args.clear },
          ...args.key === undefined ? {} : { key: args.key },
        }))
      return {
        ref: args.ref,
        text: args.text,
        ...report,
        changed: [...report.changed],
        tabs: [...browser.status().tabs],
      }
    },
    timeoutMs: PAGE_TIMEOUT_MS,
  })), 'dsh-browser: browser_type')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture this conversation\'s browser page to a JPEG file and return its path. Read that file to look at the page.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Captured ${value.width}x${value.height} to ${value.path} (${value.bytes} bytes).`,
      }],
    },
    async execute(_args, exec) {
      const browser = browserFor(pool, exec)
      const shot = await cancelable(browser, exec.signal, 'capturing the page', () => browser.screenshot())
      await mkdir(SHOT_DIR, { recursive: true })
      const path = join(SHOT_DIR, `shot-${Date.now()}.jpg`)
      await writeFile(path, shot.jpeg)
      return { path, width: shot.width, height: shot.height, bytes: shot.jpeg.length }
    },
    timeoutMs: PAGE_TIMEOUT_MS,
  })), 'dsh-browser: browser_screenshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript in this conversation\'s browser page and return its value, awaiting it when it is a promise and calling it when it is a function. Top-level await is allowed. The general-purpose tool: use it to read values, scroll, wait for something, or go back in history.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript to evaluate in the page; a returned promise is awaited and a returned function is called.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      return {
        result: readable(await cancelable(browser, exec.signal, 'evaluating in the page', () =>
          browser.evaluate(args.expression))),
      }
    },
    timeoutMs: EVALUATE_TIMEOUT_MS,
  })), 'dsh-browser: browser_evaluate')
}

/**
 * Name an element the way a snapshot line names it.
 * @param element - the element an action reported, when it named one.
 * @returns the element as role and quoted name, or a neutral stand-in.
 */
function describeElement(element: ActionReport['element']): string {
  if (element === undefined) return 'the element'
  return `${element.role} ${JSON.stringify(element.name)}`
}
