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
 * @param page - the page whose CDP session to program.
 * @param mutations - how many mutation records the page is reported to have made.
 * @param settled - whether the page stopped changing inside the budget.
 */
function observe(page: FakePage, mutations: number, settled = true): void {
  let seen: { mutations: number; settled: boolean } = { mutations: 0, settled: true }
  page.cdp.answers.set('Runtime.evaluate', (params: Record<string, unknown>) => {
    const expression = String(params['expression'])
    if (expression.includes('MutationObserver')) {
      seen = { mutations, settled }
      return { result: { value: 0 } }
    }
    if (expression.includes('__dshSettle')) return { result: { value: seen } }
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

test('a snapshot target that is not a ref is looked up as a selector', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('DOM.getDocument', { root: { nodeId: 7 } })
  page.cdp.answers.set('DOM.querySelector', { nodeId: 8 })
  page.cdp.answers.set('DOM.describeNode', { node: { backendNodeId: 31 } })
  const snapshot = await browser.snapshot({ target: '#send' })
  assert.equal(snapshot.text, '- button "Send" [ref=e1]')
  assert.deepEqual(page.cdp.method('DOM.querySelector')[0]?.params, { nodeId: 7, selector: '#send' })
})

test('a selector that matches nothing fails saying which selector it was', async () => {
  const { browser, page } = await started()
  page.cdp.answers.set('DOM.getDocument', { root: { nodeId: 7 } })
  page.cdp.answers.set('DOM.querySelector', { nodeId: 0 })
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
  page.cdp.answers.set('DOM.getDocument', { root: { nodeId: 7 } })
  page.cdp.answers.set('DOM.querySelectorAll', (params: Record<string, unknown>) => (
    params['selector'] === '.ads' ? { nodeIds: [9] } : { nodeIds: [] }
  ))
  page.cdp.answers.set('DOM.describeNode', { node: { backendNodeId: 31 } })
  const snapshot = await browser.snapshot()
  assert.ok(!snapshot.text.includes('button'), 'an ignored element was printed')
  assert.equal(page.cdp.method('DOM.querySelectorAll').length, 2)
  assert.deepEqual(page.cdp.method('DOM.describeNode')[0]?.params, { nodeId: 9, depth: -1, pierce: false })
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
  observe(page, 0, false)
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
