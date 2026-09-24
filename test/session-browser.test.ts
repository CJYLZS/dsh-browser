/**
 * The three things an agent does to a page beyond running code — reading it,
 * clicking it, typing into it — all resolve through refs a snapshot handed out,
 * and all have to keep working when the page is replaced by a new tab.
 *
 * These tests drive a session browser over the recording launcher, so what they
 * assert is the protocol calls the browser would make.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { plainConfig, Config, type BrowserConfig } from '../src/config.ts'
import { PortAllocator } from '../src/browser/ports.ts'
import { SessionBrowser } from '../src/browser/session-browser.ts'
import { fakeLauncher, HEADFUL_UA, type FakeLaunch, type FakePage } from './support/browser.ts'

/** The page fixture the fake Chrome answers a snapshot with. */
const AX_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 31 },
  ],
}

/** A quads answer describing a 20x20 box whose centre is (20, 30). */
const QUADS = { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }

/** Layout metrics that report a scrolled page, so coordinates must be translated. */
const METRICS = {
  cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
  cssLayoutViewport: { pageX: 5, pageY: 7 },
}

/** A session browser over a fake launcher. */
interface Harness {
  /** The browser under test. */
  readonly browser: SessionBrowser
  /** The launcher's record of started browsers. */
  readonly launch: FakeLaunch
  /** The page the browser starts on. */
  readonly page: FakePage
}

/**
 * Build a session browser with a page that answers snapshot, quads, and metrics.
 * @param config - overrides on top of the schema defaults.
 * @returns the browser and its fakes.
 */
function harness(config: Partial<BrowserConfig> = {}): Harness {
  const launch = fakeLauncher()
  const logger = { info: () => {}, warn: () => {} } as unknown as Context['logger']
  const browser = new SessionBrowser('session-a', {
    config: plainConfig(Config(config)),
    ports: new PortAllocator(9333, [], async () => true),
    launch: launch.launch,
    logger,
  })
  const page = launch.browsers.length === 0
    ? (undefined as unknown as FakePage)
    : (launch.browsers[0]?.pages[0] as FakePage)
  return { browser, launch, page }
}

/**
 * Prepare the first page of the first browser, then answer CDP queries on it.
 * @param config - overrides on top of the schema defaults.
 * @returns the ready browser and its fakes.
 */
async function started(config: Partial<BrowserConfig> = {}): Promise<Harness> {
  const built = harness(config)
  await built.browser.ensure()
  const page = built.launch.browsers[0]?.pages[0]
  assert.ok(page !== undefined)
  page.cdp.answers.set('Accessibility.getFullAXTree', AX_TREE)
  page.cdp.answers.set('DOM.getContentQuads', QUADS)
  page.cdp.answers.set('Page.getLayoutMetrics', METRICS)
  return { ...built, page }
}

/** The pointer calls a click made, in order. */
function pointerCalls(page: FakePage): Record<string, unknown>[] {
  return page.cdp.method('Input.dispatchMouseEvent').map(call => call.params)
}

test('a snapshot prints the page and hands out refs', async () => {
  const { browser } = await started()
  const snapshot = await browser.snapshot()
  assert.equal(snapshot.text, [
    '- RootWebArea "Form"',
    '  - textbox "Email" [ref=e1]',
    '  - button "Send" [ref=e2]',
  ].join('\n'))
  assert.equal(snapshot.refs.get('e2'), 31)
})

test('a click lands on the element a ref names, in viewport coordinates', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.click('e2')
  assert.deepEqual(pointerCalls(page), [
    { type: 'mouseMoved', x: 15, y: 23, button: 'none', clickCount: 0 },
    { type: 'mousePressed', x: 15, y: 23, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 15, y: 23, button: 'left', clickCount: 1 },
  ])
  assert.deepEqual(page.cdp.method('DOM.scrollIntoViewIfNeeded')[0]?.params, { backendNodeId: 31 })
})

test('a click without a snapshot fails and says what to do', async () => {
  const { browser } = await started()
  await assert.rejects(() => browser.click('e2'), /browser_snapshot/)
})

test('a ref the page no longer has fails rather than clicking something else', async () => {
  const { browser } = await started()
  await browser.snapshot()
  await browser.navigate('https://example.test/next')
  await assert.rejects(() => browser.click('e2'), /browser_snapshot/)
})

test('an element with no box to click fails instead of clicking at 0,0', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('DOM.getContentQuads', { quads: [] })
  await browser.snapshot()
  await assert.rejects(() => browser.click('e2'), /no visible box/)
  assert.deepEqual(pointerCalls(page), [])
})

test('typing focuses the element, replaces its content, and inserts the text', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'a@b.c')
  assert.deepEqual(page.cdp.method('DOM.focus')[0]?.params, { backendNodeId: 21 })
  assert.deepEqual(page.cdp.method('Input.insertText')[0]?.params, { text: 'a@b.c' })
  const evaluations = page.cdp.method('Runtime.evaluate').map(call => String(call.params.expression))
  assert.ok(evaluations.some(expression => expression.includes('select')), 'the old value was not replaced')
})

test('typing without clearing appends at the caret', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'more', { clear: false })
  const evaluations = page.cdp.method('Runtime.evaluate').map(call => String(call.params.expression))
  assert.equal(evaluations.some(expression => expression.includes('select')), false)
  assert.deepEqual(page.cdp.method('Input.insertText')[0]?.params, { text: 'more' })
})

test('a submitting key is pressed after the text', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'a@b.c', { key: 'Enter' })
  const order = page.cdp.calls.map(call => call.method)
  assert.ok(order.indexOf('Input.insertText') < order.indexOf('Input.dispatchKeyEvent'))
  assert.equal(page.cdp.method('Input.dispatchKeyEvent').length, 2)
})

test('a new tab becomes the page the tools act on', async () => {
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  await browser.evaluate('1 + 1')
  assert.equal(opened.cdp.method('Runtime.evaluate').length, 1)
  assert.deepEqual(browser.status().tabs.map(tab => tab.active), [false, true])
})

test('closing the active tab moves to the one that is left', async () => {
  const { browser, launch } = await started()
  const first = launch.browsers[0]?.pages[0]
  launch.browsers[0]?.openPage('https://example.test/new')
  await new Promise(resolve => { setImmediate(resolve) })
  await first?.page.close()
  await new Promise(resolve => { setImmediate(resolve) })
  assert.equal(browser.status().url, 'https://example.test/new')
  assert.equal(browser.status().tabs.length, 1)
})

test('a restart replaces the browser and keeps the session', async () => {
  const { browser, launch } = await started()
  await browser.restart()
  assert.equal(launch.browsers[0]?.closed, true)
  assert.equal(launch.browsers.length, 2)
  assert.equal(browser.status().state, 'ready')
  assert.equal(browser.status().sessionId, 'session-a')
})

/**
 * Wait until a condition holds, so an assertion does not race a `void`ed
 * asynchronous path.
 * @param condition - the predicate to wait on.
 * @param what - description used in the failure message.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** One frame's worth of payload, as Chrome sends it. */
const FRAME = { data: Buffer.from('jpeg').toString('base64'), sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }

test('a viewer that stays subscribed gets frames again after a restart', async () => {
  const { browser, launch } = await started()
  const frames: unknown[] = []
  browser.addViewer(frame => frames.push(frame))
  const first = launch.browsers[0]?.pages[0]
  await until(() => (first?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the first screen cast')
  first?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 1)

  await browser.restart()
  const second = launch.browsers[1]?.pages[0]
  // The screen cast belonged to the old CDP session, so it has to be attached
  // to the new one even though the viewer count never changed.
  await until(() => (second?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the screen cast on the new browser')
  second?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 2)
})

test('a viewer that stays subscribed gets frames again after the browser dies', async () => {
  const { browser, launch } = await started()
  const frames: unknown[] = []
  browser.addViewer(frame => frames.push(frame))
  await until(() => (launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the first screen cast')

  launch.browsers[0]?.die('the window was closed')
  await browser.ensure()
  const second = launch.browsers[1]?.pages[0]
  await until(() => (second?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the screen cast on the replacement')
  second?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 1)
})

test('a viewer keeps getting frames when a launch setting changes', async () => {
  const { browser, launch } = await started({ debugPort: 9333 })
  const frames: unknown[] = []
  browser.addViewer(frame => frames.push(frame))
  await until(() => (launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the first screen cast')

  await browser.reconfigure(plainConfig(Config({ debugPort: 9400 })))
  const second = launch.browsers[1]?.pages[0]
  await until(() => (second?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the screen cast after the restart')
  second?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 1)
})

test('a headless user agent is rewritten when stealth is on', async () => {
  const { page } = await started({ headless: true, stealth: true })
  assert.deepEqual(page.cdp.method('Network.setUserAgentOverride')[0]?.params, { userAgent: HEADFUL_UA })
})

test('stealth off leaves the user agent alone', async () => {
  const { page } = await started({ headless: true, stealth: false })
  assert.deepEqual(page.cdp.method('Network.setUserAgentOverride'), [])
})

test('a browser with a window is not rewritten', async () => {
  const { page } = await started({ headless: false, stealth: true })
  assert.deepEqual(page.cdp.method('Network.setUserAgentOverride'), [])
})
