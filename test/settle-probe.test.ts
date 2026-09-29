/**
 * What the settle probe tells the host about a page that moved.
 *
 * The probe is the only part of an action that runs inside the page, and the
 * record it hands back is what turns "something changed" into "this appeared".
 * A real `MutationObserver` is the authority on the records a page makes and
 * only a browser can be that authority, so these tests do not pretend to test
 * the browser: they drive the probe's own summarising with the records a browser
 * hands over, and assert what it made of them — which entries survive the cap,
 * what a deduplicated pair of records becomes, and what one entry says about the
 * element it happened to.
 *
 * The page itself is faked down to the handful of properties the probe reads.
 * If this list grows, the probe is reaching further into the page than a summary
 * of a mutation needs to, and that is worth noticing here rather than in a
 * browser nobody can step through.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleProbe } from '../src/browser/session-browser.ts'

/** A node of the fake page the probe reads. */
interface FakeNode {
  /** 1 for an element, 3 for a text node — the only distinction the probe makes. */
  readonly nodeType: number
  /** Uppercase tag name, as the DOM reports it. */
  readonly tagName?: string
  /** What `textContent` says, which is what an element is previewed by. */
  readonly textContent?: string
  /** What `value` holds, for the form controls whose text is their value. */
  readonly value?: string
  /** What `data` holds, for a text node. */
  readonly data?: string
  /** The element this node sits in, absent for a detached node. */
  readonly parentElement?: FakeNode | null
  /**
   * Read one attribute.
   * @param name - attribute name.
   * @returns its value, or null when it is absent.
   */
  getAttribute(name: string): string | null
}

/**
 * Build an element of the fake page.
 * @param tag - its tag name.
 * @param options - attributes, text, and value.
 * @returns the node.
 */
function el(tag: string, options: { attrs?: Record<string, string>; text?: string; value?: string } = {}): FakeNode {
  const attrs = options.attrs ?? {}
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    textContent: options.text ?? '',
    value: options.value ?? '',
    parentElement: null,
    getAttribute: name => attrs[name] ?? null,
  }
}

/**
 * Build a text node of the fake page.
 * @param data - what it says.
 * @param parent - the element it sits in, absent once it has been removed.
 * @returns the node.
 */
function textNode(data: string, parent: FakeNode | null = null): FakeNode {
  return { nodeType: 3, data, parentElement: parent, getAttribute: () => null }
}

/** One mutation record, in the shape `MutationObserver` hands over. */
interface FakeRecord {
  /** Which kind of mutation this is. */
  readonly type: 'attributes' | 'characterData' | 'childList'
  /** The node the mutation happened to, or the parent that gained or lost a child. */
  readonly target: FakeNode
  /** The attribute that changed, for `attributes`. */
  readonly attributeName?: string
  /** What the attribute or the text said before. */
  readonly oldValue?: string | null
  /** Children the mutation added. */
  readonly addedNodes?: readonly FakeNode[]
  /** Children the mutation removed. */
  readonly removedNodes?: readonly FakeNode[]
}

/** One change the probe reported. */
interface ReportedChange {
  /** What happened: the element appeared, went away, or said something new. */
  readonly kind: string
  /** The element's tag name. */
  readonly tag?: string
  /** The role the element declares, when it declares one. */
  readonly role?: string
  /** A short piece of what the element says. */
  readonly preview?: string
  /** The attribute that changed. */
  readonly attribute?: string
  /** What it said before. */
  readonly from?: string
  /** What it says now. */
  readonly to?: string
}

/** What the probe answered. */
interface ProbeRecord {
  /** Mutation records seen. */
  readonly mutations: number
  /** Whether the page went quiet inside the budget. */
  readonly settled: boolean
  /** The changes it itemised. */
  readonly changes: readonly ReportedChange[]
  /** How many further changes it saw and left out. */
  readonly omitted: number
}

/** A probe running against a fake page, and the handles to drive it. */
interface ProbeRun {
  /** Hand the probe one batch of records, the way a browser would. */
  deliver(records: readonly FakeRecord[]): void
  /** Let the page go quiet: run the timer the probe set for its quiet window. */
  quiet(): void
  /** Reach the settle budget without the page ever going quiet. */
  expire(): void
  /** What the observer was told to watch, once it has been installed. */
  observing(): Record<string, unknown> | undefined
  /** Whether the observer has been disconnected. */
  disconnected(): boolean
  /** What the probe answered; awaits its resolution. */
  result(): Promise<ProbeRecord>
}

/**
 * Run the probe against a fake page.
 *
 * The probe is a string on purpose — it is evaluated in the page — so running it
 * here means giving it the globals a page would: a `document`, a
 * `MutationObserver` that records instead of watching, and timers this test
 * decides when to fire. That is what makes "went quiet" and "never went quiet"
 * two states a test can choose between rather than two waits.
 * @returns the run, already started.
 */
function probe(): ProbeRun {
  let callback: ((records: readonly FakeRecord[]) => void) | undefined
  let options: Record<string, unknown> | undefined
  let disconnected = false
  const timers = new Map<number, { ms: number; run: () => void }>()
  let nextTimer = 0

  class FakeObserver {
    /**
     * Take the callback the probe wants its records delivered to.
     * @param records - the callback.
     */
    constructor(records: (records: readonly FakeRecord[]) => void) { callback = records }
    /**
     * Take the options the probe watches with, instead of watching.
     * @param _target - the node it would have watched.
     * @param watch - the options.
     */
    observe(_target: unknown, watch: Record<string, unknown>): void { options = watch }
    /** Note that the probe stopped watching. */
    disconnect(): void { disconnected = true }
  }

  const documentElement = el('html')
  const holder = globalThis as { document?: unknown }
  const previous = holder.document
  holder.document = { documentElement }
  const started = new Function(
    'MutationObserver', 'setTimeout', 'clearTimeout',
    `return ${settleProbe()}`,
  )(
    FakeObserver,
    (run: () => void, ms: number) => {
      nextTimer += 1
      timers.set(nextTimer, { ms, run })
      return nextTimer
    },
    (id: number) => { timers.delete(id) },
  ) as Promise<ProbeRecord>
  holder.document = previous

  /** Run the one pending timer for a given budget. */
  const fire = (ms: number): void => {
    const found = [...timers.entries()].find(([, timer]) => timer.ms === ms)
    assert.ok(found !== undefined, `the probe set no ${String(ms)} ms timer`)
    const [id, timer] = found
    timers.delete(id)
    timer.run()
  }

  return {
    deliver: (records) => {
      assert.ok(callback !== undefined, 'the probe never installed an observer')
      callback(records)
    },
    quiet: () => { fire(500) },
    expire: () => { fire(3_000) },
    observing: () => options,
    disconnected: () => disconnected,
    result: () => started,
  }
}

test('a page that never moves is reported as settled and unchanged', async () => {
  const run = probe()
  assert.deepEqual(run.observing(), {
    subtree: true, childList: true, attributes: true, characterData: true,
    attributeOldValue: true, characterDataOldValue: true,
  }, 'the probe cannot report what a value was before unless it watches for it')
  run.quiet()
  assert.deepEqual(await run.result(), { mutations: 0, settled: true, changes: [], omitted: 0 })
  assert.equal(run.disconnected(), true, 'the observer outlived the probe')
})

test('a page that never goes quiet is reported as unsettled, with what it did see', async () => {
  const run = probe()
  run.deliver([{ type: 'attributes', target: el('button'), attributeName: 'disabled', oldValue: 'true' }])
  run.expire()
  const record = await run.result()
  assert.equal(record.settled, false)
  assert.equal(record.mutations, 1)
  assert.equal(record.changes.length, 1, 'a page that never settled still says what it changed')
})

test('a child the page gained is named by what it declares and what it says', async () => {
  const run = probe()
  const status = el('div', { attrs: { role: 'status' }, text: '先在实例表里点一行' })
  run.deliver([{ type: 'childList', target: el('main'), addedNodes: [status] }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'added', tag: 'div', role: 'status', preview: '先在实例表里点一行' },
  ])
})

test('a child the page lost is named by the element that lost it', async () => {
  const run = probe()
  const list = el('li', { text: '已连接的实例' })
  // A removed text node has no parent left to ask, and the element that lost it
  // says nothing about what it lost — so the node's own text is what is reported,
  // not the container's.
  run.deliver([{ type: 'childList', target: list, removedNodes: [textNode('已连接的实例', null)] }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'removed', tag: 'li', preview: '已连接的实例' },
  ])
})

test('a text run the page rewrote by replacing its node is one change', async () => {
  const run = probe()
  // `element.textContent = …` is how most pages rewrite a run of text, and the
  // browser reports it as one text node being replaced by another. Read
  // literally that is a node going and a node arriving, which is not what a
  // reader of the page would call it.
  const paragraph = el('p', { text: '24.2k' })
  run.deliver([{
    type: 'childList',
    target: paragraph,
    removedNodes: [textNode('24.1k', null)],
    addedNodes: [textNode('24.2k', paragraph)],
  }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'text', tag: 'p', from: '24.1k', to: '24.2k' },
  ])
})

test('a replacement that is not a text run stays two changes', async () => {
  const run = probe()
  const paragraph = el('p', { text: 'new' })
  run.deliver([{
    type: 'childList',
    target: paragraph,
    removedNodes: [textNode('old', null)],
    addedNodes: [el('span', { text: 'new' })],
  }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'removed', tag: 'p', preview: 'old' },
    { kind: 'added', tag: 'span', preview: 'new' },
  ])
})

test('an attribute change carries what it was and what it is now', async () => {
  const run = probe()
  const button = el('button', { text: '启动并连接' })
  run.deliver([{ type: 'attributes', target: button, attributeName: 'disabled', oldValue: 'true' }])
  run.deliver([{ type: 'attributes', target: button, attributeName: 'class', oldValue: null }])
  run.quiet()
  const changes = (await run.result()).changes
  assert.deepEqual(changes, [
    { kind: 'attribute', tag: 'button', preview: '启动并连接', attribute: 'disabled', from: 'true' },
    { kind: 'attribute', tag: 'button', preview: '启动并连接', attribute: 'class' },
  ], 'an attribute that was absent before says so by leaving `from` out, not by saying "null"')
})

test('a text change carries the text before and after', async () => {
  const run = probe()
  const paragraph = el('p', { text: '24.2k' })
  const node = textNode('24.2k', paragraph)
  run.deliver([{ type: 'characterData', target: node, oldValue: '24.1k' }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'text', tag: 'p', from: '24.1k', to: '24.2k' },
  ])
})

test('one element changing the same thing twice is one change, however many records it made', async () => {
  const run = probe()
  const button = el('button', { text: 'Save' })
  run.deliver([
    { type: 'attributes', target: button, attributeName: 'disabled', oldValue: 'true' },
    { type: 'attributes', target: button, attributeName: 'disabled', oldValue: null },
  ])
  run.quiet()
  const record = await run.result()
  assert.equal(record.mutations, 2, 'both records were seen')
  assert.equal(record.changes.length, 1, 'the same element changing the same thing twice is one change')
  assert.equal(record.omitted, 0)
})

test('what the page says is clipped, so a whole page of text cannot land in a result', async () => {
  const run = probe()
  run.deliver([{
    type: 'childList',
    target: el('body'),
    addedNodes: [el('div', { text: 'x'.repeat(500) })],
  }])
  run.quiet()
  const preview = (await run.result()).changes[0]?.preview ?? ''
  assert.equal(preview.length, 61, 'a preview is long enough to recognise and short enough to read')
  assert.ok(preview.endsWith('…'), 'a clipped preview does not pretend to be the whole text')
})

test('the first five changes are itemised and the rest are counted', async () => {
  const run = probe()
  for (let index = 0; index < 7; index += 1) {
    run.deliver([{ type: 'attributes', target: el('div', { text: `row ${String(index)}` }), attributeName: 'class' }])
  }
  run.quiet()
  const record = await run.result()
  assert.equal(record.mutations, 7)
  assert.equal(record.changes.length, 5)
  assert.equal(record.omitted, 2)
  assert.deepEqual(record.changes.map(change => change.preview), [
    'row 0', 'row 1', 'row 2', 'row 3', 'row 4',
  ])
})

test('a form control is previewed by the text it carries rather than by an empty label', async () => {
  const run = probe()
  const field = el('input', { attrs: { 'aria-label': 'Email' }, value: 'a@b.c' })
  run.deliver([{ type: 'attributes', target: field, attributeName: 'disabled' }])
  run.quiet()
  assert.equal((await run.result()).changes[0]?.preview, 'Email')
})

test('an element that declares nothing is reported by its tag alone', async () => {
  const run = probe()
  run.deliver([{ type: 'childList', target: el('body'), addedNodes: [el('span')] }])
  run.quiet()
  const change = (await run.result()).changes[0]
  assert.deepEqual(change, { kind: 'added', tag: 'span' })
  assert.ok(!('role' in (change ?? {})), 'an element with no role attribute reported one anyway')
  assert.ok(!('preview' in (change ?? {})), 'an element with nothing to say reported an empty preview')
})

test('a child list of text is reported against the element that gained it', async () => {
  const run = probe()
  // The container says something else entirely; what the change says is what the
  // node that arrived says, not what it landed inside.
  const paragraph = el('p', { text: 'the paragraph as a whole' })
  const added = textNode('new words', paragraph)
  run.deliver([{ type: 'childList', target: paragraph, addedNodes: [added] }])
  run.quiet()
  assert.deepEqual((await run.result()).changes, [
    { kind: 'added', tag: 'p', preview: 'new words' },
  ])
})

test('an element that draws nothing is counted but not reported', async () => {
  const run = probe()
  // A stylesheet landing in the page is the machinery, not the page: it is not
  // something a reader can see or act on, and a CSS-in-JS library rewrites one
  // on nearly every render, which would fill the summary with itself.
  const style = el('style', { text: '.row { color: red }' })
  run.deliver([{ type: 'childList', target: el('head'), addedNodes: [style] }])
  run.deliver([{ type: 'characterData', target: textNode('.row { color: red }', style), oldValue: '' }])
  run.deliver([{ type: 'childList', target: el('body'), addedNodes: [el('div', { text: 'visible' })] }])
  run.quiet()
  const record = await run.result()
  assert.equal(record.mutations, 3, 'the page did make those mutations')
  assert.deepEqual(record.changes, [{ kind: 'added', tag: 'div', preview: 'visible' }])
  assert.equal(record.omitted, 0, 'a change that is not worth reporting was not counted as left out either')
})
