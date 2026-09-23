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
 * A tool addresses the browser of the session that called it, taken from the
 * execution's agent, so two conversations never touch each other's pages. A
 * call with no session — a scheduled job, or a subagent without one — fails
 * rather than landing in somebody's browser.
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
import type { BrowserPool } from '../browser/pool.ts'
import type { SessionBrowser, TabSummary } from '../browser/session-browser.ts'

/** Directory screenshots are written to; inside the OS temp area, so it needs no cleanup contract. */
const SHOT_DIR = join(tmpdir(), 'dsh-browser-shots')

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
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}\n\n${tabsText(value.tabs)}` }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      const url = await browser.navigate(args.url)
      const title = await browser.evaluate('document.title')
      return { url, title: typeof title === 'string' ? title : '', tabs: [...browser.status().tabs] }
    },
  })), 'dsh-browser: browser_navigate')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Read the current page as a tree of roles, names, and refs. Refs name elements for browser_click and browser_type, and belong to this snapshot: take a new one after the page changes.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.text}\n\n${tabsText(value.tabs)}`,
      }],
    },
    async execute(_args, exec) {
      const browser = browserFor(pool, exec)
      const snapshot = await browser.snapshot()
      return { text: snapshot.text, truncated: snapshot.truncated, tabs: [...browser.status().tabs] }
    },
  })), 'dsh-browser: browser_snapshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element named by a ref from browser_snapshot, with real mouse events at the element\'s own position.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref from the latest browser_snapshot, such as e3.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Clicked ${value.ref}. The active page is now ${value.url}` }],
    },
    async execute(args, exec) {
      const browser = browserFor(pool, exec)
      await browser.click(args.ref)
      return { ref: args.ref, url: browser.status().url ?? '' }
    },
  })), 'dsh-browser: browser_click')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an element named by a ref from browser_snapshot, replacing what the field holds. Pass a key such as Enter to submit after typing.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref from the latest browser_snapshot, such as e3.' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Typed ${JSON.stringify(value.text)} into ${value.ref}.` }],
    },
    async execute(args, exec) {
      await browserFor(pool, exec).type(args.ref, args.text, {
        ...args.clear === undefined ? {} : { clear: args.clear },
        ...args.key === undefined ? {} : { key: args.key },
      })
      return { ref: args.ref, text: args.text }
    },
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
      const shot = await browserFor(pool, exec).screenshot()
      await mkdir(SHOT_DIR, { recursive: true })
      const path = join(SHOT_DIR, `shot-${Date.now()}.jpg`)
      await writeFile(path, shot.jpeg)
      return { path, width: shot.width, height: shot.height, bytes: shot.jpeg.length }
    },
  })), 'dsh-browser: browser_screenshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in this conversation\'s browser page and return its value. The general-purpose tool: use it to read values, scroll, wait for something, or go back in history.',
    parameters: {
      expression: { type: 'string', required: true, description: 'Expression evaluated in the page; awaited when it returns a promise.' },
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
      return { result: readable(await browserFor(pool, exec).evaluate(args.expression)) }
    },
  })), 'dsh-browser: browser_evaluate')
}
