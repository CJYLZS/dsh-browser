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
import { PortAllocator, portWindow } from '../src/browser/ports.ts'
import { SessionBrowser } from '../src/browser/session-browser.ts'
import { formatPageInfo } from '../src/browser/page-info.ts'
import { fakeLauncher, HEADFUL_UA, type FakeLaunch, type FakePage } from './support/browser.ts'

/** The page fixture the fake Chrome answers a snapshot with. */
const AX_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 31 },
  ],
}

/**
 * The same page, with an iframe element in it.
 *
 * Chrome answers the page-level tree with the iframe carrying no children
 * (measured 2026-09-29 on a same-origin pair), so this is the shape the splice
 * starts from.
 */
const AX_TREE_WITH_FRAME = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3', '4'] },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 31 },
    { nodeId: '4', role: { value: 'Iframe' }, name: { value: 'iframe 1' }, childIds: [], backendDOMNodeId: 41 },
  ],
}

/** The frame's own tree, as `getFullAXTree({ frameId })` answers it. */
const FRAME_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'I am iFrame 1' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'I am iFrame 1' } },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'CLick Me' }, backendDOMNodeId: 51 },
  ],
}

/** A quads answer describing a 20x20 box whose centre is (20, 30). */
const QUADS = { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }

/**
 * What the page answers about a press on this element.
 *
 * The page is the authority on both halves: where its box is (`20, 30` here) and
 * what a press at that point reaches (`mine`).
 */
const PRESS = { ok: true, x: 20, y: 30, moved: false, inView: true, mine: true, over: null }

/**
 * The document instant the observed pages answer with.
 *
 * One number for every page a test observes, because an observation does not
 * replace the document: before and after read the same document, which is what
 * makes "the page did not change" the right answer in those tests.
 */
const OBSERVED_ORIGIN = 1_700_000_000_000

/**
 * The document instant of a document that replaced the one the action began on.
 *
 * One more than `OBSERVED_ORIGIN`: the only fact a replaced document carries
 * when the address and the title it replaced are identical.
 */
const REPLACED_ORIGIN = 1_700_000_000_001

/**
 * Layout metrics for a scrolled page.
 *
 * The snapshot's page info reads these. A click must not: CDP reports a box in
 * the frame's viewport pixels already, which is what a real browser measured on
 * 2026-09-24 — on a scrolled Google result page the quad for an element 2471 px
 * down the document was 433, so subtracting `pageY` (2038) put every click on
 * that page at a negative y, where it reached nothing and was still reported as
 * a success.
 */
const METRICS = {
  cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
  cssLayoutViewport: { pageX: 5, pageY: 7 },
  cssContentSize: { width: 1280, height: 1440 },
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
    ports: new PortAllocator(portWindow(9333, 9340), [], async () => true),
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
  // A click asks the page where its box is; these are the two calls that let it.
  page.cdp.answers.set('DOM.resolveNode', { object: { objectId: 'ref-node' } })
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: PRESS } })
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

test('a click presses the point the page reports for the element', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.click('e2')
  assert.deepEqual(pointerCalls(page), [
    { type: 'mouseMoved', x: 20, y: 30, button: 'none', clickCount: 0 },
    { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 1 },
  ])
  assert.deepEqual(page.cdp.method('DOM.scrollIntoViewIfNeeded')[0]?.params, { backendNodeId: 31 })
  assert.deepEqual(
    page.cdp.method('DOM.getContentQuads'),
    [],
    'the click translated a CDP box instead of asking the page where the element is',
  )
  assert.equal(page.cdp.method('Runtime.callFunctionOn')[0]?.params['awaitPromise'], true)
})

test('a page that reacts inside the click handler is reported as changed', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // A page whose whole reaction happens inside the handler — a `<details>`
  // opening, a class toggled by script — has finished by the time the protocol
  // call returns. The fake answers with what an observer armed at that moment
  // could have seen, so it can only report the change if the plugin was already
  // watching when the events went out.
  let armedBeforeInput = false
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params.expression)
    if (expression.includes('MutationObserver')) {
      armedBeforeInput = page.cdp.method('Input.dispatchMouseEvent').length === 0
      return { result: { value: 0 } }
    }
    return { result: { value: { mutations: armedBeforeInput ? 1 : 0, settled: true } } }
  })
  const report = await browser.click('e2')
  assert.deepEqual(report.changed, ['dom'], 'the change made inside the handler was not seen')
  const order = page.cdp.calls.map(call => call.method)
  assert.ok(
    order.indexOf('Runtime.evaluate') < order.indexOf('Input.dispatchMouseEvent'),
    'the observer was installed after the events it was meant to watch',
  )
})

test('typing watches the page before the text arrives', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'abc')
  const armed = page.cdp.calls.findIndex(call => String(call.params.expression).includes('MutationObserver'))
  const inserted = page.cdp.calls.map(call => call.method).indexOf('Input.insertText')
  assert.ok(armed !== -1, 'typing never watched the page')
  assert.ok(armed < inserted, 'typing installed its observer after the text arrived')
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

test('a ref from the page before fails even when the new page hands out that ref', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.navigate('https://example.test/next')
  // Snapshotting the new page before using the old ref is the order that made
  // the old ref name whatever element now wore its number — on a real page,
  // the footer heading, and the tool reported the click as a success.
  await browser.snapshot()
  await assert.rejects(
    () => browser.click('e2'),
    /not a ref from a snapshot of the current page/,
  )
  assert.deepEqual(pointerCalls(page), [], 'the stale ref clicked something')
})

test('an element with no box to click fails instead of clicking at 0,0', async () => {
  const { browser, page } = await started()
  // The page is what says a box is there, so this is how a boxless element —
  // `display: none`, or a collapsed container — answers for itself.
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { ok: false } } })
  await browser.snapshot()
  await assert.rejects(() => browser.click('e2'), /no visible box/)
  assert.deepEqual(pointerCalls(page), [])
  assert.deepEqual(page.cdp.method('DOM.getContentQuads'), [], 'a boxless element was still measured by CDP')
})

test('typing focuses the element, replaces its content, and inserts the text', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'a@b.c')
  assert.deepEqual(page.cdp.method('DOM.focus')[0]?.params, { backendNodeId: 21 })
  assert.deepEqual(page.cdp.method('Input.insertText')[0]?.params, { text: 'a@b.c' })
  const evaluations = page.cdp.method('Runtime.evaluate').map(call => String(call.params.expression))
  assert.ok(evaluations.some(expression => expression.includes('.select?.()')), 'the old value was not replaced')
})

test('typing without clearing appends at the caret', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'more', { clear: false })
  const evaluations = page.cdp.method('Runtime.evaluate').map(call => String(call.params.expression))
  // The old value is replaced by selecting it first; a page-side selector walk
  // also says "selector", so the question is asked of the call that does it.
  assert.equal(evaluations.some(expression => expression.includes('.select?.()')), false)
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

test('typing into a field the page says is read-only is refused, not reported as typed', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // Measured 2026-09-24 in real Chrome: `Input.insertText` into a read-only
  // input inserts nothing at all, and the report still said the text had been
  // typed — the same shape as the click that was reported as a success.
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { accepts: false, why: 'it is read-only' } },
  })
  await assert.rejects(() => browser.type('e1', 'x'), /textbox "Email" would not take the text because it is read-only/)
  assert.deepEqual(page.cdp.method('Input.insertText'), [], 'text went into a field the page had refused')
})

test('typing into an element the page never focused is refused', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { accepts: false, why: 'the page did not focus it' } },
  })
  await assert.rejects(() => browser.type('e1', 'x'), /the page did not focus it/)
  assert.deepEqual(page.cdp.method('Input.insertText'), [])
})

test('typing into an element the page will not focus is refused in this tool\'s words, not the protocol\'s', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // Measured 2026-09-29 on the-internet's dynamic-controls page: a disabled
  // input makes `DOM.focus` itself reject — `Element is not focusable` — so the
  // page's own answer was never asked for and the caller got
  // `cdpSession.send: Protocol error (DOM.focus): Element is not focusable`,
  // which names neither the element nor the reason nor a next move.
  page.cdp.failWith('DOM.focus', 'cdpSession.send: Protocol error (DOM.focus): Element is not focusable')
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { accepts: false, why: 'it is disabled' } },
  })
  await assert.rejects(() => browser.type('e1', 'x'), /textbox "Email" would not take the text because it is disabled/)
  assert.deepEqual(page.cdp.method('Input.insertText'), [], 'text went into an element the page had refused to focus')
})

test('a page that will not focus an element and cannot say why is still refused by name', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.failWith('DOM.focus', 'cdpSession.send: Protocol error (DOM.focus): Element is not focusable')
  // The default answer here is the shape a press probe reads, which says nothing
  // about typing: the page has no reason to give, so the protocol's own words are
  // the reason, and the refusal still has to name the element and the way out.
  await assert.rejects(
    () => browser.type('e1', 'x'),
    /would not focus textbox "Email" \(Element is not focusable\); nothing was typed/,
  )
  assert.deepEqual(page.cdp.method('Input.insertText'), [])
})

test('a page that answers nothing about typing does not block the text', async () => {
  // The page is asked, not obeyed: an answer this code cannot read — the press
  // answer the fake hands out by default is exactly that — leaves the old
  // behaviour in place rather than refusing an element that may be fine.
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.type('e1', 'x')
  assert.deepEqual(page.cdp.method('Input.insertText')[0]?.params, { text: 'x' })
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

test('status names every page by its CDP target id and title', async () => {
  // The sidebar's tab list is 1:1 with the browser's pages, and a tab has to
  // keep naming its page across navigations and active-page changes — so the
  // identity is the CDP target id (what external DevTools sees too), not the
  // address or the position, and the title rides along with it.
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const tabs = browser.status().tabs
  assert.deepEqual(tabs.map(tab => tab.targetId), ['target-0', 'target-1'])
  assert.deepEqual(
    tabs.map(tab => tab.title),
    ['title of about:blank', 'title of https://example.test/new'],
  )
  assert.deepEqual(tabs.map(tab => tab.active), [false, true])
})

test('a status read answers the titles the pages carry now', async () => {
  // The title a page reported when it was adopted is already out of date the
  // moment the page renames itself, and the sidebar's tab chips read what the
  // status route answers. `Target.getTargets` is one browser-level call — it
  // never touches a renderer, so a busy page cannot hold the answer — and it
  // is what makes the read fresh rather than a memory of adoption time.
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  launch.browsers[0]?.browserCdp.answers.set('Target.getTargets', () => ({
    targetInfos: [
      { targetId: 'target-0', type: 'page', url: 'about:blank', title: 'Renamed blank' },
      { targetId: 'target-1', type: 'page', url: 'https://example.test/new', title: 'Fresh title' },
    ],
  }))
  const status = await browser.statusAsync()
  assert.deepEqual(status.tabs.map(tab => tab.title), ['Renamed blank', 'Fresh title'])
  assert.deepEqual(status.tabs.map(tab => tab.targetId), ['target-0', 'target-1'])
})

test('a status read falls back to what adoption learned when the target list refuses', async () => {
  const { browser, launch } = await started()
  launch.browsers[0]?.openPage('https://example.test/new')
  await new Promise(resolve => { setImmediate(resolve) })
  launch.browsers[0]?.browserCdp.failWith('Target.getTargets', 'not attached')
  const status = await browser.statusAsync()
  assert.deepEqual(
    status.tabs.map(tab => tab.title),
    ['title of about:blank', 'title of https://example.test/new'],
  )
  assert.deepEqual(status.tabs.map(tab => tab.targetId), ['target-0', 'target-1'])
})

test('a browser without a browser-level session still reports its pages', async () => {
  // A context created outside a browser answers `browser()` with null; the tab
  // list is then what adoption cached, which is still a list.
  const { browser, launch } = await started()
  launch.browsers[0]?.openPage('https://example.test/new')
  await new Promise(resolve => { setImmediate(resolve) })
  const context = launch.browsers[0]?.session.context as unknown as { browser?: () => null }
  context.browser = () => null
  const status = await browser.statusAsync()
  assert.equal(status.tabs.length, 2)
  assert.deepEqual(status.tabs.map(tab => tab.title), ['title of about:blank', 'title of https://example.test/new'])
})

test('closing a page by its target id closes that page and keeps the browser', async () => {
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  await browser.closePage('target-0')
  await new Promise(resolve => { setImmediate(resolve) })
  assert.equal(launch.browsers[0]?.pages[0]?.closed, true, 'the page the tab named is the page that closed')
  assert.equal(opened.closed, false, 'the other page is untouched')
  assert.equal(browser.status().state, 'ready', 'the browser outlives one of its pages')
  assert.equal(browser.status().url, 'https://example.test/new', 'the tools moved to the page that is left')
})

test('closing the last page stops the browser the user closed', async () => {
  // Chrome exits when its last tab goes, so the close of the only page is the
  // deliberate stop: a viewer coming back must not start a new one over it,
  // exactly as for the pane's own close before tabs named their pages.
  const { browser, launch } = await started()
  await browser.closePage('target-0')
  assert.equal(browser.status().state, 'closed')
  assert.equal(launch.browsers[0]?.closed, true)
  browser.addViewer(() => {})
  await quiet()
  assert.equal(launch.browsers.length, 1, 'a viewer restarted a browser the user closed')
  await browser.evaluate('1 + 1')
  assert.equal(launch.browsers.length, 2, 'a tool call is a request for a browser, and brings one back')
})

test('closing a target the browser does not hold changes nothing', async () => {
  // A sidebar tab can name a page that is already gone — the page closed
  // itself while the tab was still up. That is not a reason to stop the
  // browser that outlived it.
  const { browser, launch } = await started()
  await browser.closePage('target-9')
  assert.equal(browser.status().state, 'ready')
  assert.equal(launch.browsers[0]?.closed, false)
})

test('a viewer names its page and is sent that page alone', async () => {
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const frames: unknown[] = []
  const stop = await browser.addPageViewer(frame => frames.push(frame), 'target-1')
  await until(() => (opened.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the named page screen cast')
  assert.equal(
    launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0,
    0,
    'the page nobody named is not being mirrored',
  )
  opened.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 1)
  stop()
  await until(() => (opened.cdp.method('Page.stopScreencast').length ?? 0) > 0, 'the named page stream stopping')
})

test('two viewers of one page share one screen cast', async () => {
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  const first: unknown[] = []
  const second: unknown[] = []
  const stopFirst = await browser.addPageViewer(frame => first.push(frame), 'target-1')
  const stopSecond = await browser.addPageViewer(frame => second.push(frame), 'target-1')
  await until(() => (opened.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the shared screen cast')
  assert.equal(opened.cdp.method('Page.startScreencast').length, 1, 'one page, one stream')
  opened.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  stopFirst()
  stopSecond()
  await until(() => (opened.cdp.method('Page.stopScreencast').length ?? 0) > 0, 'the stream stopping after the last viewer')
})

test('a viewer naming a page the browser does not hold is refused', async () => {
  const { browser } = await started()
  await assert.rejects(
    () => browser.addPageViewer(() => {}, 'target-9'),
    /has no page target-9/,
  )
})

test('input and navigation go to the page the viewer names', async () => {
  const { browser, launch } = await started()
  const opened = launch.browsers[0]?.openPage('https://example.test/new')
  assert.ok(opened !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  // A later tab takes the active seat, which is what makes the first one a
  // page a pane can mirror without the tools acting on it.
  const newest = launch.browsers[0]?.openPage('https://example.test/third')
  assert.ok(newest !== undefined)
  await new Promise(resolve => { setImmediate(resolve) })
  await browser.input({ type: 'mouse', action: 'down', x: 0.5, y: 0.5 }, 'target-1')
  await browser.navigatePage('target-1', 'https://example.test/next')
  assert.ok(opened.cdp.method('Input.dispatchMouseEvent').length > 0, 'the named page got the press')
  assert.equal(
    newest.cdp.method('Input.dispatchMouseEvent').length,
    0,
    'the page nobody named got nothing',
  )
  assert.equal(opened.url, 'https://example.test/next')
  assert.equal(browser.status().url, 'https://example.test/third', 'the active page is the tools’ business, not the pane’s')
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

/**
 * Give a `void`ed asynchronous path time to do something it must not.
 *
 * The mirror's subscription path starts a browser behind `void`, so a
 * must-not-happen assertion has to wait a window rather than fail on the next
 * line, where the wrong behaviour has not run yet either way.
 */
async function quiet(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 50) })
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
  const { browser, launch } = await started()
  const frames: unknown[] = []
  browser.addViewer(frame => frames.push(frame))
  await until(() => (launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the first screen cast')

  await browser.reconfigure(plainConfig(Config({ headless: false })))
  const second = launch.browsers[1]?.pages[0]
  await until(() => (second?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the screen cast after the restart')
  second?.cdp.emit('Page.screencastFrame', FRAME)
  assert.equal(frames.length, 1)
})

test('a viewer reconnecting does not start a browser the user stopped', async () => {
  const { browser, launch } = await started()
  const stopWatching = browser.addViewer(() => {})
  await until(() => (launch.browsers[0]?.pages[0]?.cdp.method('Page.startScreencast').length ?? 0) > 0, 'the screen cast')

  await browser.stop()
  assert.equal(browser.status().state, 'closed')
  assert.equal(launch.browsers[0]?.closed, true)

  // Switching Sidebar tabs and back, hiding the column and showing it again, or
  // a client reload all arrive as the same thing here: this viewer goes away
  // and a fresh one subscribes. None of them is a request for a browser.
  stopWatching()
  browser.addViewer(() => {})
  await quiet()
  assert.equal(launch.browsers.length, 1, 'a viewer restarted a browser the user had stopped')
  assert.equal(browser.status().state, 'closed')
})

test('a tool call starts a new browser after the user stopped one', async () => {
  const { browser, launch } = await started()
  await browser.stop()

  await browser.navigate('https://example.com')
  assert.equal(launch.browsers.length, 2, 'the tool call did not ask for a browser')
  assert.equal(browser.status().state, 'ready')
  assert.equal(launch.browsers[1]?.pages[0]?.url, 'https://example.com')
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

/**
 * Answer the settle probe with a fixed observation.
 *
 * The probe is the one pair of evaluations an action makes without being asked:
 * the one that installs the observer, and the one that reads what it saw. The
 * fake tells them apart from the caller's own code, and answers the second with
 * whatever the first was told to observe — a record no armed probe could give
 * is a record the page never made.
 *
 * The record is page-supplied, so it is also how a test hands over something a
 * page should not be able to say: whatever is passed here is what the plugin
 * has to make sense of.
 * @param page - the page whose CDP session to program.
 * @param mutations - how many mutation records the page is reported to have made.
 * @param extra - what the page says it changed, and how much it left out.
 */
function observe(
  page: FakePage,
  mutations: number,
  extra: { settled?: boolean; changes?: readonly unknown[]; omitted?: number } = {},
): void {
  let seen: unknown = { mutations: 0, settled: true, changes: [], omitted: 0 }
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'])
    if (expression.includes('MutationObserver')) {
      seen = {
        mutations,
        settled: extra.settled ?? true,
        ...extra.changes === undefined ? {} : { changes: extra.changes },
        ...extra.omitted === undefined ? {} : { omitted: extra.omitted },
      }
      return { result: { value: 0 } }
    }
    if (expression.includes('__dshSettle')) return { result: { value: seen } }
    // The state reads go through the document probe (see `stateOf`); answering
    // it keeps a page that is only being observed from reading as one that
    // cannot answer at all.
    if (expression.includes('performance.timeOrigin')) {
      return {
        result: { value: { url: page.url, title: `title of ${page.url}`, origin: OBSERVED_ORIGIN } },
      }
    }
    return { result: { value: 'evaluated' } }
  })
}

test('a snapshot reports where in the page it was taken', async () => {
  const { browser } = await started()
  const snapshot = await browser.snapshot()
  assert.deepEqual(snapshot.info, {
    viewportWidth: 1280, viewportHeight: 720, pageWidth: 1280, pageHeight: 1440, scrolledY: 7,
  })
  assert.equal(
    formatPageInfo(snapshot.info),
    'Page info: 1280x720 viewport, page 1280x1440 (2 screens) — 7 px scrolled (0%), 713 px below, screen 1 of 2',
  )
})

test('a snapshot can be narrowed to the subtree of a ref it already handed out', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  const narrowed = await browser.snapshot({ target: 'e2' })
  assert.equal(narrowed.text, '- button "Send" [ref=e2]')
  assert.deepEqual(page.cdp.method('DOM.querySelector'), [], 'a ref was looked up as a selector')
})

test('a snapshot target that is not a ref is looked up through the page', async () => {
  const { browser, page } = await started()
  answerSelectors(page, { '#send': [31] })
  const snapshot = await browser.snapshot({ target: '#send' })
  assert.equal(snapshot.text, '- button "Send" [ref=e1]')
  // The walk is the page's own, so an open shadow root and a same-origin frame
  // are in scope; a query rooted at the document answers neither.
  assert.deepEqual(page.cdp.method('DOM.querySelector'), [], 'the DOM agent was asked instead of the page')
  assert.ok(
    page.cdp.method('Runtime.evaluate').some(call => String(call.params['expression']).includes('shadowRoot')),
    'the selector was not walked through the page',
  )
})

test('a target selector the page cannot parse is refused as a selector', async () => {
  const { browser, page } = await started()
  answerSelectors(page, {}, new Set(['a[[']))
  await assert.rejects(() => browser.snapshot({ target: 'a[[' }), /the page refused the selector/)
})

test('a selector that matches nothing fails saying which selector it was', async () => {
  const { browser, page } = await started()
  answerSelectors(page, {})
  await assert.rejects(() => browser.snapshot({ target: '#nope' }), /no element matches #nope/)
})

test('a ref-shaped target this page never handed out fails as a ref', async () => {
  const { browser } = await started()
  await assert.rejects(() => browser.snapshot({ target: 'e9' }), /browser_snapshot/)
})

test('a depth limit reads only the levels asked for and counts the rest', async () => {
  const { browser } = await started()
  const snapshot = await browser.snapshot({ depth: 0 })
  assert.equal(snapshot.text.split('\n')[0], '- RootWebArea "Form"')
  assert.equal(snapshot.elided.depth, 2)
  assert.equal(snapshot.truncated, true)
})

test('the configured ignore selectors keep whole elements out of a snapshot', async () => {
  const { browser, page } = await started({ snapshotIgnore: '[data-dsh-browser-ignore], .ads' })
  answerSelectors(page, { '.ads': [31] })
  const snapshot = await browser.snapshot()
  assert.ok(!snapshot.text.includes('button'), 'an ignored element was printed')
  // The page's own walk finds the element, and `pierce` is what makes the drop
  // cover what is inside it — its open shadow root and the frames within it.
  assert.deepEqual(page.cdp.method('DOM.querySelectorAll'), [], 'the DOM agent was asked instead of the page')
  assert.deepEqual(page.cdp.method('DOM.describeNode')[0]?.params, { objectId: 'handle-0', depth: -1, pierce: true })
})

test('refs keep their labels when a new snapshot shows a changed page', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // A menu opens ahead of the form. Renumbering would move every label after it.
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['9', '2', '3'] },
      { nodeId: '9', role: { value: 'menuitem' }, name: { value: 'This week' }, backendDOMNodeId: 41 },
      ...AX_TREE.nodes.slice(1),
    ],
  })
  const second = await browser.snapshot()
  assert.deepEqual([...second.refs], [['e3', 41], ['e1', 21], ['e2', 31]])
  assert.deepEqual([...second.fresh], ['e3'])
  await browser.click('e2')
  assert.equal(page.cdp.method('DOM.scrollIntoViewIfNeeded')[0]?.params['backendNodeId'], 31)
})

test('a ref whose element was replaced is found again by its role and name', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('DOM.resolveNode', (params: Record<string, unknown>) => {
    if (params['backendNodeId'] === 31) throw new Error('No node with given id found')
    return { object: { objectId: 'replacement' } }
  })
  page.cdp.answers.set('DOM.getContentQuads', (params: Record<string, unknown>) => {
    if (params['backendNodeId'] === 31) throw new Error('No node with given id found')
    return QUADS
  })
  // The button was re-rendered: same role and name, a different DOM node.
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 77 },
    ],
  })
  const report = await browser.click('e2')
  assert.equal(report.recovered, true)
  assert.deepEqual(page.cdp.method('DOM.resolveNode').at(-1)?.params, { backendNodeId: 77 })
  assert.equal(pointerCalls(page).length, 3)
})

test('a click reports the element it acted on, the address it ended on, and what changed', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 2)
  const report = await browser.click('e2')
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
  assert.equal(report.mutations, 2)
  assert.equal(report.settled, true)
  assert.deepEqual([...report.changed], ['dom'])
  assert.equal(report.url, 'about:blank')
})

test('a click reports what the page changed, not just that it changed', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 3, {
    changes: [
      { kind: 'added', tag: 'div', role: 'status', preview: '先在实例表里点一行' },
      { kind: 'attribute', tag: 'button', preview: '启动并连接', attribute: 'disabled', from: 'true' },
      { kind: 'text', tag: 'p', from: '24.1k', to: '24.2k' },
    ],
  })
  const report = await browser.click('e2')
  assert.deepEqual(report.changes, [
    { kind: 'added', tag: 'div', role: 'status', preview: '先在实例表里点一行' },
    { kind: 'attribute', tag: 'button', preview: '启动并连接', attribute: 'disabled', from: 'true' },
    { kind: 'text', tag: 'p', from: '24.1k', to: '24.2k' },
  ])
  assert.deepEqual([...report.changed], ['dom'], 'the change list still says the page moved')
})

test('a boolean attribute keeps the empty value that says it was there', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // Measured 2026-09-29: `disabled` is an attribute whose value IS the empty
  // string, so Chrome reports `oldValue: ""` when it is removed and
  // `getAttribute` answers `""` right after it is added. Reading "" as "the
  // page said nothing" printed an addition and a removal as the same line.
  observe(page, 2, {
    changes: [
      { kind: 'attribute', tag: 'button', attribute: 'disabled', from: '' },
      { kind: 'attribute', tag: 'button', attribute: 'hidden', to: '' },
    ],
  })
  const report = await browser.click('e2')
  assert.deepEqual(report.changes, [
    { kind: 'attribute', tag: 'button', attribute: 'disabled', from: '' },
    { kind: 'attribute', tag: 'button', attribute: 'hidden', to: '' },
  ])
})

test('a field that is empty and means nothing is still dropped', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 1, { changes: [{ kind: 'added', tag: 'div', preview: '', role: '' }] })
  const report = await browser.click('e2')
  assert.deepEqual(report.changes, [{ kind: 'added', tag: 'div' }], 'an empty preview is not a description')
})

test('a result says how many changes it did not itemise', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 9, { changes: [{ kind: 'added', tag: 'li' }], omitted: 8 })
  const report = await browser.click('e2')
  assert.equal(report.changesOmitted, 8)
})

test('a page that changed nothing carries no change list at all', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 0, { changes: [] })
  const report = await browser.click('e2')
  assert.ok(!('changes' in report), 'an empty change list is noise on every result')
  assert.ok(!('changesOmitted' in report))
})

test('a page cannot invent a change the plugin does not understand', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // The record is page-supplied: whatever a page answers with has to be read as
  // data. An entry the result schema would not accept is dropped instead of
  // failing the call, and a field that is not the type it should be is dropped
  // from an entry that is otherwise usable.
  observe(page, 4, {
    changes: [
      null,
      'a change',
      { kind: 'nonsense', tag: 'div' },
      { kind: 'added', tag: 42, preview: 'kept', extra: 'not in the schema' },
    ],
  })
  const report = await browser.click('e2')
  assert.deepEqual(report.changes, [{ kind: 'added', preview: 'kept' }])
})

test('a page cannot widen a change past the fields the result declares', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 20, {
    changes: [
      { kind: 'added', tag: 'div', preview: 'x'.repeat(500) },
      ...Array.from({ length: 9 }, () => ({ kind: 'removed', tag: 'li' })),
    ],
    omitted: 2,
  })
  const report = await browser.click('e2')
  assert.equal(report.changes?.length, 5, 'the cap is enforced by the plugin, not promised by the page')
  const first = report.changes?.[0]
  assert.equal(first?.preview?.length, 61)
  assert.ok(first?.preview?.endsWith('…'))
  assert.equal(report.changesOmitted, 2 + 5, 'the entries past the cap are counted as omitted')
})

test('a wait stops as soon as the page matches, not when the budget runs out', async () => {
  const { browser, page } = await started()
  // The page answers with nothing twice and then with the tree. A wait is what
  // makes "it is not there yet" a different answer from "it is not there", and
  // only a wait that asks again can tell them apart.
  let reads = 0
  page.cdp.answers.set('Accessibility.getFullAXTree', () => {
    reads += 1
    return reads < 3 ? { nodes: [] } : AX_TREE
  })
  const report = await browser.wait({ locator: { text: 'Send' } }, { timeoutMs: 1_000, pollMs: 1 })
  assert.equal(report.matched, true)
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
  assert.equal(report.matches, 1)
  assert.ok(reads >= 3, `the wait asked the page ${String(reads)} time(s)`)
  assert.ok(report.waitedMs < 1_000, 'the wait spent its whole budget although the page matched early')
})

test('a wait that never matches reports the wait instead of failing', async () => {
  const { browser, page } = await started()
  let reads = 0
  page.cdp.answers.set('Accessibility.getFullAXTree', () => {
    reads += 1
    return { nodes: [] }
  })
  const report = await browser.wait({ locator: { text: 'never' } }, { timeoutMs: 30, pollMs: 1 })
  assert.equal(report.matched, false, 'a condition that has not held yet is a result, not an error')
  assert.ok(report.waitedMs >= 30, `it waited ${String(report.waitedMs)} ms of a 30 ms budget`)
  assert.ok(reads >= 2, 'the page was only asked once')
  assert.equal(report.url, 'about:blank')
  assert.equal(typeof report.title, 'string')
})

test('a wait can ask for an element it can actually act on', async () => {
  // The button is on the page the whole time; what changes is whether it can
  // take a press. A wait that counted "on the page" would have returned at once
  // with an element the click is about to refuse — measured 2026-09-29 on a real
  // page whose own copy says "Button becomes enabled 3 seconds after arming".
  const { browser, page } = await started()
  let asked = 0
  page.cdp.answers.set('Runtime.callFunctionOn', () => {
    asked += 1
    return { result: { value: { dis: asked < 3 } } }
  })
  const report = await browser.wait(
    { locator: { role: 'button', name: 'Send' }, enabled: true },
    { timeoutMs: 1_000, pollMs: 1 },
  )
  assert.equal(report.matched, true)
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
  assert.ok(asked >= 3, `the page was asked whether it can be pressed ${String(asked)} time(s)`)
  assert.equal(report.disabled, undefined, 'a wait that held says nothing about disabled elements')
})

test('a wait for a usable element says when it is there but disabled', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { dis: true } } })
  const report = await browser.wait(
    { locator: { role: 'button', name: 'Send' }, enabled: true },
    { timeoutMs: 20, pollMs: 1 },
  )
  assert.equal(report.matched, false)
  assert.equal(report.matches, 1, 'the element was on the page the whole time')
  assert.equal(report.disabled, 1, 'and the page said it could not be pressed')
})

test('a wait that did not ask for a usable element asks the page nothing extra', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { dis: true } } })
  const report = await browser.wait({ locator: { role: 'button', name: 'Send' } }, { timeoutMs: 20, pollMs: 1 })
  assert.equal(report.matched, true)
  assert.equal(report.disabled, undefined)
  assert.deepEqual(page.cdp.method('Runtime.callFunctionOn'), [], 'a plain wait has no business asking')
})

test('a wait on an address reads the address the page shows', async () => {
  const { browser, page } = await started()
  page.url = 'https://example.test/engine/READY'
  const report = await browser.wait({ url: 'engine/ready' }, { timeoutMs: 100, pollMs: 1 })
  assert.equal(report.matched, true)
  assert.equal(report.url, 'https://example.test/engine/READY')
  assert.equal(report.element, undefined, 'an address condition names no element')
  assert.deepEqual(page.cdp.method('Accessibility.getFullAXTree'), [], 'an address needs no tree')
})

test('a wait on an address that never arrives runs out of time', async () => {
  const { browser } = await started()
  const report = await browser.wait({ url: 'never-here' }, { timeoutMs: 20, pollMs: 1 })
  assert.equal(report.matched, false)
})

test('a fixed wait is a wait with nothing to observe', async () => {
  const { browser, page } = await started()
  const report = await browser.wait({ timeMs: 20 }, { timeoutMs: 1_000, pollMs: 1 })
  assert.equal(report.matched, true)
  assert.ok(report.waitedMs >= 20, `it waited ${String(report.waitedMs)} ms`)
  assert.deepEqual(page.cdp.method('Accessibility.getFullAXTree'), [], 'a fixed wait asked the page a question')
})

test('a wait refuses to start on a page that is not open', async () => {
  const { browser } = harness()
  await assert.rejects(
    () => browser.wait({ url: 'ready' }, { timeoutMs: 50 }),
    /nothing is open to wait on/,
  )
})

test('a wait carries what the page changed while it waited', async () => {
  const { browser, page } = await started()
  observe(page, 2, {
    changes: [{ kind: 'added', tag: 'div', role: 'status', preview: 'engine starting' }],
  })
  page.cdp.answers.set('Accessibility.getFullAXTree', { nodes: [] })
  const report = await browser.wait({ locator: { text: 'ready' } }, { timeoutMs: 20, pollMs: 1 })
  assert.equal(report.matched, false)
  assert.deepEqual(report.changes, [
    { kind: 'added', tag: 'div', role: 'status', preview: 'engine starting' },
  ], 'what the page did while the caller waited is the answer to "why is it not ready"')
})

test('a selector the page refuses fails the wait instead of polling a typo', async () => {
  const { browser, page } = await started()
  answerSelectors(page, {}, new Set(['$$$']))
  await assert.rejects(
    () => browser.wait({ locator: { selector: '$$$' } }, { timeoutMs: 20, pollMs: 1 }),
    /refused the selector/,
  )
  assert.equal(page.cdp.method('Runtime.evaluate').filter(call => String(call.params['expression']).includes('const selector')).length, 1,
    'the page was asked the same typo again')
})

test('a wait that matches several elements says how many', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Start' }, backendDOMNodeId: 41 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Start over' }, backendDOMNodeId: 42 },
    ],
  })
  const report = await browser.wait({ locator: { role: 'button', name: 'Start' } }, { timeoutMs: 100, pollMs: 1 })
  assert.equal(report.matched, true, 'the condition is "such an element is there", and two of them are')
  assert.equal(report.matches, 2, 'the count is what tells the caller a click would be refused as ambiguous')
  assert.deepEqual(report.element, { role: 'button', name: 'Start' })
})

test('a wait matches the element, not the text run inside it', async () => {
  const { browser, page } = await started()
  // The shape a real page produced on 2026-09-29: a button takes its accessible
  // name from its own contents, so the element and the text run under it say the
  // same words. A wait that answered with the run would report something nobody
  // can act on, and one that counted two would report an ambiguity that is not
  // there — and the click that follows would be refused for it.
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Wait' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'engine ready' }, backendDOMNodeId: 70, childIds: ['2a'] },
      { nodeId: '2a', role: { value: 'StaticText' }, name: { value: 'engine ready' }, backendDOMNodeId: 71 },
    ],
  })
  const report = await browser.wait({ locator: { text: 'engine ready' } }, { timeoutMs: 200, pollMs: 1 })
  assert.equal(report.matched, true)
  assert.equal(report.matches, 1)
  assert.deepEqual(report.element, { role: 'button', name: 'engine ready' })
})

test('a click that navigates reports the address it landed on, not the one it left', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Input.dispatchMouseEvent', (params: Record<string, unknown>) => {
    if (params['type'] === 'mouseReleased') {
      page.url = 'https://example.test/trending?since=weekly'
      page.emit('framenavigated')
    }
    return {}
  })
  const report = await browser.click('e2')
  assert.equal(report.url, 'https://example.test/trending?since=weekly')
  assert.ok(report.changed.includes('url'), `changed was ${report.changed.join(', ')}`)
})

test('a click the page says would be received by something else is refused', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { ...PRESS, mine: false, over: { role: 'generic', name: 'View all solutions' } } },
  })
  await assert.rejects(
    () => browser.click('e2'),
    /would be received by generic "View all solutions", not button "Send".*force: true/,
  )
  assert.deepEqual(pointerCalls(page), [], 'a refused click was dispatched anyway')
})

test('a forced click goes out even when the page says something else receives it', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { ...PRESS, mine: false, over: { role: 'generic', name: 'View all solutions' } } },
  })
  const report = await browser.click('e2', { force: true })
  assert.deepEqual(report.obstructed, { role: 'generic', name: 'View all solutions' })
  assert.equal(pointerCalls(page).length, 3)
})

test('a click that lands on the element itself reports no obstruction', async () => {
  const { browser } = await started()
  await browser.snapshot()
  const report = await browser.click('e2')
  assert.equal(report.obstructed, undefined)
})

test('a click on a point outside the viewport is refused, forced or not', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // What the page says when its own coordinates put the point above the fold —
  // the shape of the scrolled-page bug this replaced, where the press went out
  // at y = -1589 and the report still called it a click.
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { ...PRESS, x: 440, y: -1589, inView: false, mine: false } },
  })
  await assert.rejects(() => browser.click('e2'), /outside the viewport/)
  await assert.rejects(() => browser.click('e2', { force: true }), /outside the viewport/)
  assert.deepEqual(pointerCalls(page), [])
})

test('a click the page says the element is disabled is refused, force or not', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // Measured 2026-09-29: a real disabled button answered `Clicked button
  // "Submit"` and the page ignored the press, while the sibling refusal for
  // typing has named "it is disabled" since the round before. `force` is about
  // what receives the press, so it does not turn this verdict off.
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { ...PRESS, dis: true } } })
  await assert.rejects(
    () => browser.click('e2'),
    /button "Send" is disabled.*nothing was clicked.*force does not bypass this/,
  )
  await assert.rejects(() => browser.click('e2', { force: true }), /is disabled/)
  assert.deepEqual(pointerCalls(page), [], 'a refused click was dispatched anyway')
})

test('a click is not turned into a refusal when the page said nothing about it', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // The field is absent rather than false in every answer that predates it, and
  // an answer this plugin cannot read is not evidence that the element is dead.
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { ...PRESS, dis: 'yes' } } })
  const report = await browser.click('e2')
  assert.equal(report.element?.name, 'Send')
  assert.equal(pointerCalls(page).length, 3)
})

test('a click reads a moving element again instead of pressing where it was', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  let asked = 0
  page.cdp.answers.set('Runtime.callFunctionOn', () => {
    asked += 1
    return { result: { value: { ...PRESS, x: asked === 1 ? 20 : 40, moved: asked === 1 } } }
  })
  await browser.click('e2')
  assert.equal(asked, 2, 'the element was pressed on a box it had already left')
  assert.deepEqual(pointerCalls(page)[1], { type: 'mousePressed', x: 40, y: 30, button: 'left', clickCount: 1 })
})

test('a point the page will not describe still gets its click', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.failWith('DOM.resolveNode', 'No node with given id')
  const report = await browser.click('e2')
  assert.equal(report.obstructed, undefined)
  // The box CDP reports is already in the coordinates input is dispatched in,
  // so the fallback uses it exactly as it comes.
  assert.deepEqual(page.cdp.method('DOM.getContentQuads').at(-1)?.params, { backendNodeId: 31 })
  assert.deepEqual(pointerCalls(page)[1], { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 })
})

test('typing reports the element it typed into', async () => {
  const { browser } = await started()
  await browser.snapshot()
  const report = await browser.type('e1', 'a@b.c')
  assert.deepEqual(report.element, { role: 'textbox', name: 'Email' })
})

test('an action the page never answered reports that it could not settle', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  observe(page, 0, { settled: false })
  const report = await browser.click('e2')
  assert.equal(report.settled, false)
  assert.deepEqual([...report.changed], [])
})

test('navigate reports the address and title it landed on', async () => {
  const { browser } = await started()
  const report = await browser.navigate('https://example.test/next')
  assert.equal(report.url, 'https://example.test/next')
  assert.equal(report.title, 'title of https://example.test/next')
  assert.ok(report.changed.includes('url'))
})

test('a click that replaced the document says so even when nothing else changed', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // A form POST that answers with the same page replaces the document and
  // changes neither the address nor the title — measured 2026-09-29 on a real
  // login form, where the report claimed a title change that never happened
  // and said nothing about the replacement.
  let reads = 0
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'])
    if (expression.includes('MutationObserver')) return { result: { value: 0 } }
    if (expression.includes('__dshSettle')) {
      return { result: { value: { mutations: 0, settled: true, changes: [], omitted: 0 } } }
    }
    if (expression.includes('performance.timeOrigin')) {
      reads += 1
      return {
        result: {
          value: {
            url: page.url,
            title: `title of ${page.url}`,
            origin: reads === 1 ? OBSERVED_ORIGIN : REPLACED_ORIGIN,
          },
        },
      }
    }
    return { result: { value: 'evaluated' } }
  })
  const report = await browser.click('e2')
  assert.deepEqual([...report.changed], ['document'], 'the only change was the document itself')
})

test('a state read waits for the document instead of printing a placeholder', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // What the protocol's convenience answers while a document replaces itself:
  // `Loading <url>` — its own placeholder for "the evaluation could not run"
  // (measured 2026-09-29). The report carries the title the page gives, or
  // none; never one it invented.
  let reads = 0
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'])
    if (expression.includes('MutationObserver')) return { result: { value: 0 } }
    if (expression.includes('__dshSettle')) {
      return { result: { value: { mutations: 0, settled: true, changes: [], omitted: 0 } } }
    }
    if (expression.includes('performance.timeOrigin')) {
      reads += 1
      if (reads === 1) {
        throw new Error('Execution context was destroyed, most likely because of a navigation')
      }
      return {
        result: { value: { url: page.url, title: 'The Internet', origin: OBSERVED_ORIGIN } },
      }
    }
    return { result: { value: 'evaluated' } }
  })
  const report = await browser.click('e2')
  assert.equal(report.title, 'The Internet')
  assert.equal(report.url, page.url)
})

test('a click that opens a tab reports the tab, not the page it left behind', async () => {
  const { browser, launch, page } = await started()
  await browser.snapshot()
  const first = launch.browsers[0]
  assert.ok(first !== undefined)
  // The tab opens while the action is settling, the way a real `window.open`
  // lands a beat after the press returns (measured 2026-09-29: two of three
  // such clicks described the page they left behind).
  page.cdp.answers.set('Runtime.callFunctionOn', () => {
    void first.openPage('https://example.test/opened')
    return { result: { value: PRESS } }
  })
  const report = await browser.click('e2')
  assert.equal(report.url, 'https://example.test/opened')
  assert.deepEqual([...report.changed], ['url', 'title', 'document'])
})

test('a frame\u2019s content is in the snapshot and acts like any other element', async () => {
  const { browser, page } = await started()
  // Chrome answers the page-level tree with the iframe element carrying no
  // children (measured 2026-09-29 on a same-origin pair); the frame's own tree
  // is a separate answer, and the splice is what puts its control in front of
  // the caller.
  // The fake is the real shape: a `Page.Frame` names itself `id`, and Chrome
  // has no `frameId` (measured 2026-09-29). Written the other way this fixture
  // — and the source it was copied from — agreed with each other and disagreed
  // with the browser, which is how the splice stayed broken with the suite green.
  page.cdp.answers.set('Page.getFrameTree', {
    frameTree: { frame: { id: 'root' }, childFrames: [{ frame: { id: 'f1' } }] },
  })
  page.cdp.answers.set('Accessibility.getFullAXTree', (params: Record<string, unknown>) => (
    params['frameId'] === 'f1' ? FRAME_TREE : AX_TREE_WITH_FRAME
  ))
  page.cdp.answers.set('DOM.getFrameOwner', { backendNodeId: 41 })
  const snapshot = await browser.snapshot()
  const ref = /button "CLick Me" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1]
  assert.ok(ref !== undefined, `the frame\u2019s control had no ref: ${snapshot.text}`)
  // Acting on the ref goes through the same protocol path any element's does.
  const report = await browser.click(ref)
  assert.deepEqual(report.element, { role: 'button', name: 'CLick Me' })
  assert.equal(page.cdp.method('Input.dispatchMouseEvent').length, 3)
})

test('an evaluation that awaits at the top level is retried in REPL mode', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    if (params['replMode'] !== true) {
      throw new Error('SyntaxError: await is only valid in async functions and the top level bodies of modules')
    }
    return { result: { value: 42 } }
  })
  assert.equal(await browser.evaluate('await Promise.resolve(42)'), 42)
  const calls = page.cdp.method('Runtime.evaluate')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.params['replMode'], undefined, 'the first attempt skipped the plain form')
  assert.equal(calls[1]?.params['replMode'], true)
})

test('a function evaluated on the page is called rather than answered as {}', async () => {
  const { browser, page } = await started()
  // What a real `() => 1` answers with: a function is not a value, so it comes
  // back as `{}` unless something calls it.
  page.cdp.answers.set('Runtime.evaluate', {
    result: { type: 'function', className: 'Function', description: '() => 1', objectId: 'fn-1' },
  })
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: 1 } })
  assert.equal(await browser.evaluate('() => 1'), 1)
  assert.equal(page.cdp.method('Runtime.callFunctionOn')[0]?.params.objectId, 'fn-1')
})

test('a function with no handle to call is called through its own expression', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => (
    String(params['expression']) === '(() => 1)()'
      ? { result: { value: 1 } }
      : { result: { type: 'function', description: '() => 1' } }
  ))
  assert.equal(await browser.evaluate('() => 1'), 1)
})

test('an evaluation that fails for another reason is reported once, as it is', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.evaluate', {
    exceptionDetails: { exception: { description: 'TypeError: x is not a function' } },
  })
  await assert.rejects(() => browser.evaluate('await x()'), /x is not a function/)
  assert.equal(page.cdp.method('Runtime.evaluate').length, 1)
})

test('a declaration the page already has is retried in a scope of its own', async () => {
  const { browser, page } = await started()
  // The page's global scope keeps whatever an earlier call declared, so the
  // second `const el` is a SyntaxError before a single statement runs — which is
  // what an agent iterating on one snippet hits, and it reads as if the snippet
  // were wrong.
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => (
    String(params['expression']).startsWith('{')
      ? { result: { value: 'scoped' } }
      : {
          exceptionDetails: {
            exception: { description: "SyntaxError: Identifier 'el' has already been declared" },
          },
        }
  ))
  assert.equal(await browser.evaluate('const el = 1; el'), 'scoped')
  const calls = page.cdp.method('Runtime.evaluate')
  assert.equal(calls.length, 2, 'the redeclaration must be retried, not reported')
  assert.match(String(calls[1]?.params['expression']), /^\{\n/)
})

test('a top-level return is retried as an async function body', async () => {
  const { browser, page } = await started()
  // What "run this and give me what it returns" gets on a page: a bare `return`
  // is a statement where only an expression is allowed, so the page refuses the
  // whole snippet before anything runs — while the reference runtime's program
  // form allows exactly this.
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => (
    String(params['expression']).startsWith('(async () =>')
      ? { result: { value: 'returned' } }
      : { exceptionDetails: { exception: { description: 'SyntaxError: Illegal return statement' } } }
  ))
  assert.equal(await browser.evaluate('const el = document.body; return el.textContent'), 'returned')
  const calls = page.cdp.method('Runtime.evaluate')
  assert.equal(calls.length, 2, 'a top-level return must be retried, not reported')
  assert.equal(calls[1]?.params['expression'], '(async () => {\nconst el = document.body; return el.textContent\n})()')
})

test('a top-level return is retried once, not in a loop', async () => {
  const { browser, page } = await started()
  // The wrapper is the retry, so a page that refuses the wrapped form too has
  // said something about the code; reporting it beats wrapping it again.
  page.cdp.answers.set('Runtime.evaluate', {
    exceptionDetails: { exception: { description: 'SyntaxError: Illegal return statement' } },
  })
  await assert.rejects(() => browser.evaluate('return 1'), /Illegal return statement/)
  assert.equal(page.cdp.method('Runtime.evaluate').length, 2, 'the wrapped form was retried more than once')
})

test('a cancelled call stops the page instead of leaving it busy', async () => {
  const { browser, page } = await started()
  await browser.interrupt()
  assert.equal(page.cdp.method('Page.stopLoading').length, 1, 'a load in flight was not stopped')
  assert.equal(page.cdp.method('Runtime.terminateExecution').length, 1, 'a script was left running')
  assert.equal(browser.status().state, 'ready', 'a browser that answered must be kept')
})

test('a browser that does not answer a cancelled call is dropped for a fresh one', async () => {
  const { browser, launch, page } = await started()
  // A wedged renderer, not a busy one: neither of the two calls that stop it
  // comes back at all.
  page.cdp.answers.set('Page.stopLoading', () => new Promise(() => {}))
  page.cdp.answers.set('Runtime.terminateExecution', () => new Promise(() => {}))
  await browser.interrupt()
  assert.equal(browser.status().state, 'closed', 'a browser that answers nothing is not usable')
  assert.match(browser.status().error ?? '', /did not answer/)
  // The point of dropping it: the next call starts a browser rather than
  // inheriting one that hangs every call from here on.
  await browser.ensure()
  assert.equal(launch.browsers.length, 2)
})

test('a right click presses the right button, so the page sees a context menu request', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.click('e2', { button: 'right' })
  assert.deepEqual(pointerCalls(page).slice(1), [
    { type: 'mousePressed', x: 20, y: 30, button: 'right', clickCount: 1 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'right', clickCount: 1 },
  ])
})

test('a double click sends the two press-release pairs a browser sends', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.click('e2', { double: true })
  // The second pair carries click count 2, which is what makes the page treat
  // the two as one double click rather than two clicks.
  assert.deepEqual(pointerCalls(page).slice(1), [
    { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 1 },
    { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 2 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 2 },
  ])
})

test('a key pressed with no element goes to wherever the page has focus', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.press('Escape')
  // Pressing a key is not typing: naming no element leaves the focus alone and
  // replaces nothing, which is what makes Escape close a menu the page opened.
  assert.deepEqual(page.cdp.method('DOM.focus'), [], 'a key press moved the focus')
  assert.deepEqual(page.cdp.method('Input.insertText'), [], 'a key press inserted text')
  assert.deepEqual(
    page.cdp.method('Input.dispatchKeyEvent').map(call => call.params['type']),
    ['rawKeyDown', 'keyUp'],
  )
})

test('a chord pressed with no element carries its modifiers', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.press('Control+A')
  const events = page.cdp.method('Input.dispatchKeyEvent').map(call => call.params)
  assert.equal(events[0]?.['modifiers'], 2)
  assert.equal(events[0]?.['key'], 'a')
})

test('a dialog a click opens is answered, reported, and never left open', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  let opened: ReturnType<FakePage['dialog']> | undefined
  page.cdp.answers.set('Input.dispatchMouseEvent', (params: Record<string, unknown>) => {
    if (params['type'] === 'mousePressed') opened = page.dialog('confirm', 'Delete this item?')
    return {}
  })
  const report = await browser.click('e2')
  // A page that never gets an answer never runs again, so leaving it open is
  // not an option; dismissing is the answer that changes nothing, and the
  // report is what stops it from being invisible.
  assert.equal(opened?.handled, 'dismissed')
  assert.deepEqual(report.dialogs, [{
    type: 'confirm',
    message: 'Delete this item?',
    defaultValue: '',
    handled: 'dismissed',
  }])
  assert.deepEqual(report.changed, ['dialog'], 'the dialog was not reported as the change it was')
})

test('a call that declares it will accept answers the dialog that way', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  let opened: ReturnType<FakePage['dialog']> | undefined
  page.cdp.answers.set('Input.dispatchMouseEvent', (params: Record<string, unknown>) => {
    if (params['type'] === 'mousePressed') opened = page.dialog('confirm', 'Delete this item?')
    return {}
  })
  const report = await browser.click('e2', { dialog: { action: 'accept' } })
  assert.equal(opened?.handled, 'accepted')
  assert.equal(report.dialogs?.[0]?.handled, 'accepted')
})

test('a prompt is accepted with the text the call declared', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  let opened: ReturnType<FakePage['dialog']> | undefined
  page.cdp.answers.set('Input.dispatchMouseEvent', (params: Record<string, unknown>) => {
    if (params['type'] === 'mousePressed') opened = page.dialog('prompt', 'Your name?', 'Anonymous')
    return {}
  })
  const report = await browser.click('e2', { dialog: { action: 'accept', text: 'Ada' } })
  assert.equal(opened?.answer, 'Ada')
  assert.equal(report.dialogs?.[0]?.answer, 'Ada')
  assert.equal(report.dialogs?.[0]?.defaultValue, 'Anonymous')
})

test('a dialog opened while the page is idle is kept until a tool reports it', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.dialog('alert', 'Your session is expiring')
  const reported = browser.takeDialogs()
  assert.deepEqual(reported.map(dialog => dialog.message), ['Your session is expiring'])
  assert.equal(reported[0]?.handled, 'dismissed', 'an unannounced dialog must still be answered')
  assert.deepEqual(browser.takeDialogs(), [], 'the same dialog was reported twice')
})

test('a call that met no dialog carries no dialogs and no dialog change', async () => {
  const { browser } = await started()
  await browser.snapshot()
  const report = await browser.click('e2')
  assert.equal(report.dialogs, undefined)
  assert.deepEqual(report.changed, [])
})

test('a snapshot asked for boxes prints where each element is, in viewport pixels', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('DOM.getContentQuads', (params: Record<string, unknown>) => (
    params['backendNodeId'] === 21
      ? { quads: [[100, 200, 300, 200, 300, 240, 100, 240]] }
      : { quads: [[100, 300, 180, 300, 180, 330, 100, 330]] }
  ))
  const snapshot = await browser.snapshot({ boxes: true })
  assert.match(snapshot.text, /- textbox "Email" \[ref=e1\] box=100,200 200x40/)
  assert.match(snapshot.text, /- button "Send" \[ref=e2\] box=100,300 80x30/)
  // Asking where the elements are must not spend or renumber the page's refs.
  assert.equal(snapshot.refs.get('e1'), 21)
  assert.equal(snapshot.refs.get('e2'), 31)
})

test('a snapshot asked for a query and for boxes asks the page only about what it prints', async () => {
  const { browser, page } = await started()
  const snapshot = await browser.snapshot({ find: 'Send', boxes: true })
  assert.match(snapshot.text, /button "Send"/)
  assert.doesNotMatch(snapshot.text, /Email/)
  const asked = page.cdp.method('DOM.getContentQuads').map(call => call.params['backendNodeId'])
  assert.deepEqual([...new Set(asked)], [31], 'a box was measured for an element the snapshot does not print')
})

test('a snapshot narrowed by a query still names refs the page can be acted on with', async () => {
  const { browser, page } = await started()
  const snapshot = await browser.snapshot({ find: 'Send' })
  const ref = /\[ref=(e\d+)\]/.exec(snapshot.text)?.[1]
  assert.ok(ref !== undefined, 'the match carried no ref to click')
  await browser.click(ref)
  assert.equal(page.cdp.method('Input.dispatchMouseEvent').length, 3)
})

test('the pane is handed the text a copy in the page would take', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.evaluate', { result: { value: 'alpha beta' } })
  assert.equal(await browser.selectionText(), 'alpha beta')
  const expression = String(page.cdp.method('Runtime.evaluate')[0]?.params['expression'])
  // The focused control's own range comes first: in a text field the document
  // selection is usually collapsed, and the field's range is what a copy takes.
  assert.match(expression, /selectionStart/u)
  assert.match(expression, /getSelection/u)
})

test('a page with nothing selected reports no text', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Runtime.evaluate', { result: { value: '' } })
  assert.equal(await browser.selectionText(), '')
  // A page that answered something that is not a string must not become the word
  // "undefined" on the user's clipboard.
  page.cdp.answers.set('Runtime.evaluate', { result: {} })
  assert.equal(await browser.selectionText(), '')
})

/**
 * A page with the shape a ref cannot express: one control name used twice, in
 * two places that only their ancestors tell apart.
 */
const AMBIGUOUS_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Instances' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'region' }, name: { value: 'Running' }, childIds: ['2a'] },
    { nodeId: '2a', role: { value: 'button' }, name: { value: 'Stop' }, backendDOMNodeId: 61 },
    { nodeId: '3', role: { value: 'region' }, name: { value: 'Idle' }, childIds: ['3a'] },
    { nodeId: '3a', role: { value: 'button' }, name: { value: 'Stop' }, backendDOMNodeId: 62 },
  ],
}

/**
 * Answer the protocol a CSS selector resolution makes.
 *
 * The page walks the selector itself (see `selectorProbe`), so the fake answers
 * the way a real page would: the walk leaves its matches in the page's slot and
 * answers with the count, each match is handed back as a handle one at a time,
 * and a node id doubles as the backend node id here, which is what maps a match
 * back to the accessibility tree the tree-shaped assertions use.
 * @param page - the fake page to answer on.
 * @param matches - selector to the node ids it matches; an absent selector matches nothing.
 * @param refused - selectors the page cannot parse, which throw the way a real
 * page throws at `querySelector`.
 */
function answerSelectors(page: FakePage, matches: Record<string, number[]>, refused: ReadonlySet<string> = new Set()): void {
  let current: number[] = []
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'] ?? '')
    if (expression.includes('performance.timeOrigin')) {
      return {
        result: { value: { url: page.url, title: `title of ${page.url}`, origin: OBSERVED_ORIGIN } },
      }
    }
    const embedded = /const selector = ("(?:[^"\\]|\\.)*")/.exec(expression)
    if (embedded !== null) {
      const selector = JSON.parse(embedded[1]) as string
      if (refused.has(selector)) {
        throw new Error(`SyntaxError: Failed to execute 'querySelector': '${selector}' is not a valid selector`)
      }
      current = matches[selector] ?? []
      return { result: { value: current.length } }
    }
    const handle = /^globalThis\.__dshMatches\[(\d+)\]$/.exec(expression)
    if (handle !== null) return { result: { objectId: `handle-${handle[1]}` } }
    return { result: { value: 'evaluated' } }
  })
  page.cdp.answers.set('DOM.describeNode', (params: Record<string, unknown>) => {
    const index = Number(/^handle-(\d+)$/.exec(String(params['objectId'] ?? ''))?.[1] ?? -1)
    return { node: { backendNodeId: current[index], nodeName: 'DIV' } }
  })
}

test('a role-and-name locator clicks the element the matching ref named', async () => {
  const byRef = await started()
  await byRef.browser.snapshot()
  await byRef.browser.click('e2')

  const byLocator = await started()
  const report = await byLocator.browser.click({ role: 'button', name: 'Send' })

  assert.deepEqual(pointerCalls(byLocator.page), pointerCalls(byRef.page), 'the two ways to name one element pressed different points')
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
})

test('a locator that matches two elements refuses instead of choosing one', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Accessibility.getFullAXTree', AMBIGUOUS_TREE)
  await assert.rejects(() => browser.click({ role: 'button', name: 'Stop' }), (error: Error) => {
    assert.match(error.message, /matches 2 elements/)
    // The ancestors are the whole point of the refusal: without them the list
    // is two identical lines and the caller has learned nothing.
    assert.match(error.message, /region "Running"/)
    assert.match(error.message, /region "Idle"/)
    return true
  })
  assert.deepEqual(pointerCalls(page), [], 'an ambiguous locator clicked something')
})

test('a locator the page does not answer refuses and points at the snapshot', async () => {
  const { browser, page } = await started()
  await assert.rejects(
    () => browser.click({ role: 'button', name: 'Nope' }),
    /no element matches button "Nope"; check it, or call browser_snapshot/,
  )
  assert.deepEqual(pointerCalls(page), [])
})

test('a CSS selector finds the element at the moment of the action', async () => {
  const { browser, page } = await started()
  answerSelectors(page, { '#send': [31] })
  const report = await browser.click({ selector: '#send' })
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
  assert.equal(page.cdp.method('Input.dispatchMouseEvent').length, 3)
})

test('a selector that matches nothing is reported by the selector', async () => {
  const { browser, page } = await started()
  answerSelectors(page, {})
  await assert.rejects(() => browser.click({ selector: '#gone' }), /no element matches selector "#gone"/)
  assert.deepEqual(pointerCalls(page), [])
})

test('a selector that matches several elements refuses and lists them', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Accessibility.getFullAXTree', AMBIGUOUS_TREE)
  answerSelectors(page, { button: [61, 62] })
  await assert.rejects(() => browser.click({ selector: 'button' }), (error: Error) => {
    assert.match(error.message, /selector "button" matches 2 elements/)
    // Measured 2026-09-29 on the-internet's add/remove page: the same two
    // buttons read as `in RootWebArea "The Internet"` through `text` and as
    // `no named ancestor` through `selector`, because the selector path never
    // asked the tree where its matches sit. The list is the whole reason the
    // refusal is usable, so the same fact has to reach it either way.
    assert.match(error.message, /region "Running"/)
    assert.match(error.message, /region "Idle"/)
    return true
  })
  assert.deepEqual(pointerCalls(page), [])
})

test('a selector whose matches the tree does not describe says that, rather than claiming they have no ancestor', async () => {
  const { browser, page } = await started()
  // Two elements the accessibility tree has no node for: a selector reaches
  // them, and neither "no named ancestor" nor an invented trail is true.
  answerSelectors(page, { '.row': [91, 92] })
  await assert.rejects(() => browser.click({ selector: '.row' }), (error: Error) => {
    assert.match(error.message, /not described by the accessibility tree/)
    assert.doesNotMatch(error.message, /no named ancestor/)
    return true
  })
  assert.deepEqual(pointerCalls(page), [])
})

test('a selector reaches an element the accessibility tree does not describe', async () => {
  const { browser, page } = await started()
  // The helper names every undescribed match by its tag, which is the element
  // the tree has no node for — the tag is the only name there is.
  answerSelectors(page, { '#bare': [99] })
  const report = await browser.click({ selector: '#bare' })
  assert.equal(report.element?.role, 'div')
})

test('a selector the page rejects is reported as a bad selector, not as an empty page', async () => {
  const { browser, page } = await started()
  answerSelectors(page, {}, new Set(['#1bad']))
  // "no element matches" would send the caller looking for another element when
  // what is wrong is the question.
  await assert.rejects(() => browser.click({ selector: '#1bad' }), /refused the selector|not a valid selector/)
})

test('a locator is resolved when the action runs, so a navigation does not invalidate it', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  await browser.navigate('https://example.test/next')
  // A ref names the document it was minted in, and that document is gone…
  await assert.rejects(() => browser.click('e2'), /not a ref from a snapshot of the current page/)
  // …while a locator asks the page in front of it, so no second snapshot is
  // needed. This is the friction a ref-only surface could not answer.
  await browser.click({ role: 'button', name: 'Send' })
  assert.equal(page.cdp.method('Input.dispatchMouseEvent').length, 3)
})

test('a locator types into the element it names', async () => {
  const { browser, page } = await started()
  await browser.type({ role: 'textbox', name: 'Email' }, 'a@b.c')
  assert.deepEqual(page.cdp.method('DOM.focus')[0]?.params, { backendNodeId: 21 })
  assert.deepEqual(page.cdp.method('Input.insertText')[0]?.params, { text: 'a@b.c' })
})

test('a click blocked by a nameless element still says something actionable', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // Measured 2026-09-24: an SVG icon over a control answers with a role and no
  // name at all, and `svg ""` names nothing the caller can act on.
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { ok: true, x: 20, y: 30, moved: false, inView: true, mine: false, over: { role: 'svg', name: '' } } },
  })
  await assert.rejects(() => browser.click('e2'), (error: Error) => {
    assert.doesNotMatch(error.message, /""/, 'a nameless element was quoted as an empty name')
    assert.match(error.message, /svg/)
    assert.match(error.message, /force: true/)
    return true
  })
})

test('the console listener is subscribed before the page can say anything', async () => {
  const { browser, page } = await started()
  // Subscribing at attach time is the whole point: a script that throws while
  // the document loads has already thrown before any tool could ask, so a
  // listener installed by a tool would only ever see a quiet page.
  const enabled = page.cdp.calls
    .filter(call => call.method === 'Runtime.enable' || call.method === 'Log.enable')
    .map(call => call.method)
  assert.deepEqual(enabled.sort(), ['Log.enable', 'Runtime.enable'])
  assert.equal(browser.status().state, 'ready')
  // And asking before anything was said is an empty history, not a failure.
  const report = await browser.pageConsole()
  assert.deepEqual(report.entries, [])
  assert.equal(report.total, 0)
})

test('a console call, an uncaught error, and a browser log entry each arrive as one entry', async () => {
  const { browser, page } = await started()
  page.cdp.emit('Runtime.consoleAPICalled', {
    type: 'error',
    timestamp: 1_700_000_000_000,
    args: [{ type: 'string', value: 'checkout failed' }, { type: 'object', description: 'Object', preview: { description: 'Object', properties: [{ name: 'code', type: 'number', value: 500 }] } }],
    stackTrace: { callFrames: [{ url: 'https://example.test/app.js', lineNumber: 11 }] },
  })
  page.cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1_700_000_001_000,
    exceptionDetails: {
      text: 'Uncaught',
      url: 'https://example.test/app.js',
      lineNumber: 20,
      exception: { description: 'TypeError: x is not a function' },
    },
  })
  page.cdp.emit('Log.entryAdded', {
    entry: {
      source: 'network',
      level: 'error',
      text: 'Failed to load resource: the server responded with a status of 404',
      timestamp: 1_700_000_002_000,
      url: 'https://example.test/missing.js',
    },
  })
  const report = await browser.pageConsole()
  assert.equal(report.total, 3)
  assert.deepEqual(report.entries.map(entry => entry.level), ['error', 'error', 'error'])
  assert.equal(report.entries[0]?.message, 'checkout failed {code: 500}')
  assert.equal(report.entries[0]?.url, 'https://example.test/app.js:12')
  assert.equal(report.entries[1]?.message, 'TypeError: x is not a function')
  assert.equal(report.entries[1]?.url, 'https://example.test/app.js:21')
  // A failed request has no line to name, so the resource is the whole answer.
  assert.equal(report.entries[2]?.url, 'https://example.test/missing.js')
  assert.match(report.entries[2]?.message ?? '', /404/)
  assert.equal(report.entries[0]?.timestamp, new Date(1_700_000_000_000).toISOString())
})

test('a level the browser spells differently is normalized, and the rest reads as log', async () => {
  const { browser, page } = await started()
  for (const [type, expected] of [['warning', 'warn'], ['verbose', 'debug'], ['table', 'log']] as const) {
    page.cdp.emit(type === 'verbose'
      ? 'Log.entryAdded'
      : 'Runtime.consoleAPICalled', type === 'verbose'
      ? { entry: { level: type, text: 'a network detail', timestamp: 1_700_000_000_000 } }
      : { type, timestamp: 1_700_000_000_000, args: [{ type: 'string', value: 'said' }] })
    const report = await browser.pageConsole()
    assert.equal(report.entries.at(-1)?.level, expected, `${type} was not normalized`)
  }
})

test('the console can be narrowed by level and by a substring', async () => {
  const { browser, page } = await started()
  for (const [level, message] of [['log', 'booting'], ['warn', 'slow response'], ['error', 'booting failed']] as const) {
    page.cdp.emit('Runtime.consoleAPICalled', { type: level, timestamp: 1_700_000_000_000, args: [{ type: 'string', value: message }] })
  }
  assert.deepEqual((await browser.pageConsole({ levels: ['error'] })).entries.map(entry => entry.message), ['booting failed'])
  assert.deepEqual((await browser.pageConsole({ filter: 'BOOT' })).entries.map(entry => entry.message), ['booting', 'booting failed'])
  // A filter and a level are one question asked twice, not a union.
  const both = await browser.pageConsole({ levels: ['warn'], filter: 'boot' })
  assert.deepEqual(both.entries, [])
  assert.equal(both.total, 3)
  assert.equal(both.matched, 0)
})

test('a limit keeps the newest entries, and says how many matched', async () => {
  const { browser, page } = await started()
  for (let index = 0; index < 5; index += 1) {
    page.cdp.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: 1_700_000_000_000, args: [{ type: 'string', value: `line ${String(index)}` }] })
  }
  const report = await browser.pageConsole({ limit: 2 })
  // The last thing a page said before it went quiet is what explains the quiet.
  assert.deepEqual(report.entries.map(entry => entry.message), ['line 3', 'line 4'])
  assert.equal(report.matched, 5)
  assert.equal(report.total, 5)
})

test('a new document starts with an empty console, and an embedded frame does not clear it', async () => {
  const { browser, page } = await started()
  page.cdp.emit('Runtime.consoleAPICalled', { type: 'error', timestamp: 1_700_000_000_000, args: [{ type: 'string', value: 'before' }] })
  assert.equal((await browser.pageConsole()).total, 1)
  // An iframe navigating on its own has not replaced the document the caller is
  // reading, so the document's own console is still the document's.
  page.emit('framenavigated', { url: () => 'https://ads.example.test/frame' })
  assert.equal((await browser.pageConsole()).total, 1)
  page.emit('framenavigated', page.frame)
  const after = await browser.pageConsole()
  assert.equal(after.total, 0)
  assert.deepEqual(after.entries, [])
})

test('a page that logs in a loop fills the buffer, and the count says so', async () => {
  const { browser, page } = await started()
  for (let index = 0; index < 205; index += 1) {
    page.cdp.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: 1_700_000_000_000, args: [{ type: 'string', value: `tick ${String(index)}` }] })
  }
  const report = await browser.pageConsole({ limit: 1 })
  assert.equal(report.total, 200, 'the buffer grew past its bound')
  assert.equal(report.dropped, 5)
  // The oldest were dropped, so the newest is the last thing said.
  assert.equal(report.entries[0]?.message, 'tick 204')
})

test('reading a console with nothing open is refused, and does not start a browser', async () => {
  const { browser, launch } = harness()
  await assert.rejects(() => browser.pageConsole(), /nothing is open to read a console from/)
  assert.equal(launch.browsers.length, 0, 'asking about the console started a browser')
})

test('a viewport capture asks for no clip and reports the viewport it was taken at', async () => {
  const { browser, page } = await started()
  const shot = await browser.screenshot()
  assert.deepEqual(shot.width, 1280)
  assert.deepEqual(shot.height, 720)
  assert.equal(shot.element, undefined)
  const asked = page.cdp.method('Page.captureScreenshot')[0]?.params
  assert.equal(asked?.['clip'], undefined, 'a viewport capture asked for a clip')
  assert.equal(asked?.['captureBeyondViewport'], undefined)
})

test('a whole-page capture clips to the document and reaches past the viewport', async () => {
  const { browser, page } = await started()
  const shot = await browser.screenshot({ fullPage: true })
  // Measured 2026-09-29 in `.prove/clip-space-probe.mjs`: a clip is in the
  // page's own pixels, and only `captureBeyondViewport` makes Chrome render the
  // part of the page the window is not showing.
  assert.deepEqual(page.cdp.method('Page.captureScreenshot')[0]?.params['clip'], {
    x: 0,
    y: 0,
    width: 1280,
    height: 1440,
    scale: 1,
  })
  assert.equal(page.cdp.method('Page.captureScreenshot')[0]?.params['captureBeyondViewport'], true)
  assert.equal(shot.width, 1280)
  assert.equal(shot.height, 1440, 'a full-page capture reported the viewport height')
})

test('an element capture clips to the element, without scrolling the page', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', (params: Record<string, unknown>) => {
    // The first call is the clip probe, which asks for a box rather than a press.
    return String(params['functionDeclaration']).includes('getBoundingClientRect') && String(params['functionDeclaration']).includes('scrollX')
      ? { result: { value: { ok: true, x: 12.4, y: 2601.7, width: 120.2, height: 44.9 } } }
      : { result: { value: PRESS } }
  })
  const shot = await browser.screenshot({ target: 'e2' })
  assert.deepEqual(page.cdp.method('Page.captureScreenshot')[0]?.params['clip'], {
    // Floored at the corner and ceiled at the far edge, so the clip can only grow
    // beyond the element rather than cut a pixel off it.
    x: 12,
    y: 2601,
    width: 121,
    height: 45,
    scale: 1,
  })
  assert.deepEqual(shot.element, { role: 'button', name: 'Send' })
  assert.equal(shot.width, 121)
  assert.equal(shot.height, 45)
  // The element is far below the fold, and nothing scrolled to reach it: a clip
  // is in page pixels, so scrolling would be a change the page can react to for
  // no reason at all.
  assert.deepEqual(page.cdp.method('DOM.scrollIntoViewIfNeeded'), [])
})

test('an element with no box is refused rather than captured as a blank rectangle', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { ok: false } } })
  await assert.rejects(() => browser.screenshot({ target: 'e2' }), /has no visible box/)
  assert.deepEqual(page.cdp.method('Page.captureScreenshot'), [])
})

test('a select chooses options by value or label, and reports which it chose', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { kind: 'selected', selected: ['Two'] } } })
  const report = await browser.select('e2', ['Two'])
  assert.deepEqual(report.selected, ['Two'])
  assert.deepEqual(report.element, { role: 'button', name: 'Send' })
  // The reason this exists at all: a native select's options have no box, so a
  // press is the one thing that cannot choose one.
  assert.deepEqual(pointerCalls(page), [], 'a selection was dispatched as a press')
  const probe = String(page.cdp.method('Runtime.callFunctionOn')[0]?.params['functionDeclaration'])
  assert.match(probe, /option\.selected = true/)
  assert.match(probe, /dispatchEvent\(new Event\('change'/)
})

test('a select that matches no option names the options the control has', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { kind: 'missing', missed: ['Three'], choices: ['One', 'Two'] } },
  })
  await assert.rejects(
    () => browser.select('e2', ['Three']),
    /"Three" is not an option of button "Send"[\s\S]*"One", "Two"/,
  )
  assert.deepEqual(pointerCalls(page), [])
})

test('a select on something that is not a select says so instead of pressing it', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { kind: 'not-select' } } })
  await assert.rejects(() => browser.select('e2', ['Two']), /is not a <select>/)
  assert.deepEqual(pointerCalls(page), [])
})

test('a select the page says is disabled refuses without choosing anything', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', { result: { value: { kind: 'disabled' } } })
  await assert.rejects(() => browser.select('e2', ['Two']), /is disabled, so the page would ignore a selection/)
})

test('a check sets the state and reports the state the control ended in', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { kind: 'set', checked: true, tag: 'input', type: 'checkbox' } },
  })
  const report = await browser.check('e2', true)
  assert.equal(report.checked, true)
  assert.deepEqual(pointerCalls(page), [], 'a state was set by pressing')
  const probe = String(page.cdp.method('Runtime.callFunctionOn')[0]?.params['functionDeclaration'])
  assert.match(probe, /kind: 'not-checkable'/)
})

test('a check on a control that is not a checkbox says what it is instead', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  page.cdp.answers.set('Runtime.callFunctionOn', {
    result: { value: { kind: 'not-checkable', tag: 'button', type: '' } },
  })
  await assert.rejects(() => browser.check('e2', true), /is a button, not a checkbox or radio/)
  assert.deepEqual(pointerCalls(page), [])
})

test('a key pressed with no element says where the focus went', async () => {
  const { browser, page } = await started()
  // The tree marks the focused element, the way Chrome does; the report reads
  // it there so the focus is named the way a snapshot names an element.
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'Form' },
        childIds: ['2', '3'],
        // Real shape, measured 2026-09-29: the document carries the state too,
        // and it comes first in the list, so a reader that takes the first
        // marked node answers with the page.
        properties: [{ name: 'focused', value: { value: true } }],
      },
      { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
      {
        nodeId: '3',
        role: { value: 'link' },
        name: { value: 'GitHub' },
        backendDOMNodeId: 31,
        properties: [{ name: 'focused', value: { value: true } }],
      },
    ],
  })
  const report = await browser.press('Tab')
  assert.deepEqual(report.focused, { role: 'link', name: 'GitHub' })
  assert.equal(report.element, undefined, 'a key with no element claimed to have acted on one')
})

test('a key pressed while only the document has the focus names no element', async () => {
  const { browser, page } = await started()
  // Measured 2026-09-29 in a real tree (`.prove/focus-probe.mjs`): with the focus
  // on the body the RootWebArea still carries `focused` and nothing else does.
  // "The page" is not where a key went, so no element is reported at all.
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'Form' },
        childIds: ['2'],
        properties: [{ name: 'focused', value: { value: true } }],
      },
      { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 21 },
    ],
  })
  const report = await browser.press('Tab')
  assert.equal(report.focused, undefined, 'the document was reported as the focused element')
})

test('a dialog that was already open is not reported as this call\u2019s own', async () => {
  const { browser, page } = await started()
  await browser.snapshot()
  // The pane's own user opened it, and the default policy answered it before
  // any tool call ran; reporting it as the call's would claim an action that
  // never happened.
  page.dialog('confirm', 'Discard changes?')
  await browser.snapshot()
  const reported = browser.takeDialogs()
  assert.equal(reported[0]?.message, 'Discard changes?')
  assert.equal(reported[0]?.earlier, true, 'a dialog from before the call was claimed by it')
})

test('an ambiguous locator hands back a ref for every candidate it lists', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Accessibility.getFullAXTree', AMBIGUOUS_TREE)
  answerSelectors(page, { button: [61, 62] })
  await assert.rejects(() => browser.click({ selector: 'button' }), (error: Error) => {
    // Two candidates with the same role and the same name: the ref is the only
    // handle an action can be aimed at, so the refusal has to carry it.
    const refs = [...error.message.matchAll(/\[ref=(e\d+)\]/g)].map(match => match[1])
    assert.equal(refs.length, 2, error.message)
    assert.notEqual(refs[0], refs[1], 'the two candidates were given the same ref')
    return true
  })
})

test('asking for a page on a browser that is not running starts it on that page', async () => {
  const { browser, launch } = harness()
  const opened = await browser.openPage()
  assert.equal(launch.browsers.length, 1)
  // A browser and its first page are one answer: the page the browser comes up
  // on is the page the ask asked for.
  assert.equal(browser.status().tabs.length, 1)
  assert.deepEqual(opened, browser.status().tabs[0])
  assert.equal(opened?.active, true)
})

test('asking a running browser for a page adds one and makes it the page tools act on', async () => {
  const { browser } = await started()
  const opened = await browser.openPage()
  const tabs = browser.status().tabs
  assert.equal(tabs.length, 2, 'a second ask did not open a second page')
  assert.deepEqual(tabs.map(tab => tab.active), [false, true])
  assert.equal(opened?.targetId, tabs[1]?.targetId)
})

test('one record asking twice gets the page it already asked for', async () => {
  const { browser } = await started()
  const first = await browser.openPage({ request: 'tab-1' })
  const again = await browser.openPage({ request: 'tab-1' })
  // A pane remounted by a tab switch, a Session change, or a client reload is
  // the same ask: it must not leave a stray page behind.
  assert.equal(browser.status().tabs.length, 2)
  assert.deepEqual(again, first)
})

test('a record whose page is gone asks for a new one', async () => {
  const { browser } = await started()
  const opened = await browser.openPage({ request: 'tab-1' })
  const targetId = opened?.targetId
  assert.ok(targetId !== undefined)
  await browser.closePage(targetId)
  const again = await browser.openPage({ request: 'tab-1' })
  assert.equal(browser.status().tabs.length, 2, 'the page left beside the one that closed, plus the new one')
  assert.notEqual(again?.targetId, targetId)
})

test('a page asked for with an address comes up on it', async () => {
  const { browser } = await started()
  const opened = await browser.openPage({ url: 'https://example.test/second' })
  assert.equal(opened?.url, 'https://example.test/second')
  // An ask is one page whatever it was asked to load: the address is part of
  // the ask, not a second page.
  assert.equal(browser.status().tabs.length, 2)
  // A tab list's titles are what adoption remembered, so a fresh one is the
  // status route's business — that is what `pageTabs` reads.
  assert.equal((await browser.pageTabs()).find(tab => tab.active)?.title, 'title of https://example.test/second')
})

test('selecting a page moves the page tools act on without opening another', async () => {
  const { browser } = await started()
  const first = browser.status().tabs[0]
  assert.ok(first?.targetId !== undefined)
  await browser.openPage()
  const selected = await browser.selectPage(first.targetId)
  assert.equal(selected.active, true)
  assert.deepEqual(browser.status().tabs.map(tab => tab.active), [true, false])
  assert.equal(browser.status().tabs.length, 2)
  assert.equal((await browser.pageTabs()).length, 2, 'a selection is not a page')
})

test('selecting a page the browser does not hold is refused', async () => {
  const { browser } = await started()
  await assert.rejects(() => browser.selectPage('target-9'), /has no page target-9/)
})

test('a page the record already asked for is remembered by its id, not by the ask', async () => {
  const { browser } = await started()
  const opened = await browser.openPage({ request: 'tab-1' })
  // The page the ask produced is the one a repeat answers with, and a page that
  // was closed under that record is not.
  assert.deepEqual(await browser.openPage({ request: 'tab-1' }), opened)
  await browser.closePage(String(opened?.targetId))
  assert.notDeepEqual(await browser.openPage({ request: 'tab-1' }), opened)
})

test('candidates with no name are not told to narrow by a name they do not have', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('Accessibility.getFullAXTree', {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shadow DOM' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: '' }, backendDOMNodeId: 61 },
      { nodeId: '3', role: { value: 'button' }, name: { value: '' }, backendDOMNodeId: 62 },
    ],
  })
  await assert.rejects(() => browser.click({ role: 'button' }), (error: Error) => {
    assert.match(error.message, /None of them has an accessible name/)
    assert.doesNotMatch(error.message, /Narrow it with a name that is unique/)
    return true
  })
})
