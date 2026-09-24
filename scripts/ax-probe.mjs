/**
 * Measure the real shape of Chrome's accessibility tree, over the CDP port a
 * running browser already listens on.
 *
 * The snapshot work rests on questions no fixture answers: does a `StaticText`
 * node carry the whole run when its `InlineTextBox` children are dropped, what
 * does `aria-hidden` look like from CDP, does
 * `Accessibility.getPartialAXTree` return a subtree with `fetchRelatives:false`,
 * does `Runtime.evaluate` accept `replMode` (top-level await), and what does the
 * ignore-selector lookup cost. Each is measured here on real Chrome and written
 * to `.prove/ax-probe/`, so a snapshot change can be compared against numbers
 * rather than impressions.
 *
 * This is the real-browser half of the regression pair: `test/` holds what a
 * fake CDP can assert, and this holds what only a browser can. It attaches to
 * an already-running browser (the plugin's, or `--launch` for a standalone one)
 * rather than starting its own, because the interesting page is the one the
 * tools actually operate on.
 *
 * Usage:
 *   node scripts/ax-probe.mjs --port=9334            # measure the fixture page
 *   node scripts/ax-probe.mjs --port=9334 --url=<u>  # measure a real address
 *
 * The port is per session: read it from `/dsh-browser/status`, or from
 * `/json/version` on the candidate ports.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove', 'ax-probe')

/** Command line, as `--key=value` pairs plus bare flags. */
const options = new Map()
for (const argument of process.argv.slice(2)) {
  const body = argument.replace(/^--/, '')
  const split = body.indexOf('=')
  options.set(split === -1 ? body : body.slice(0, split), split === -1 ? 'true' : body.slice(split + 1))
}

/** Port of the browser to measure. */
const PORT = Number(options.get('port') ?? 0)
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error('usage: node scripts/ax-probe.mjs --port=<cdp port> [--url=<address>]')
/** Address to navigate to before measuring, when given. */
const TARGET_URL = options.get('url')

/** The fixture page: text runs, a hidden block, an ignored block, and controls. */
const FIXTURE = `<h1>Headings are levels</h1>
<p>Hello <b>bold</b> world, one paragraph split into runs.</p>
<ul><li>first item</li><li>second item</li></ul>
<a href="https://example.test/one" title="the title">A link</a>
<button aria-expanded="false" aria-haspopup="menu">Menu</button>
<input placeholder="Search" aria-label="Search box">
<input type="checkbox" checked id="remember"> <label for="remember">Remember me</label>
<div aria-hidden="true"><button>hidden button</button><p>hidden text</p></div>
<div data-dsh-browser-ignore><button>ignore me</button><p>ignored text</p></div>
<div role="listbox"><div role="option" aria-selected="false">Option A</div><div role="option" aria-selected="true">Option B</div></div>
<nav><a href="https://example.test/two">Docs</a><a href="https://example.test/three">Pricing</a></nav>`

/**
 * Write one JSON artifact.
 * @param {string} name - file name under the output directory.
 * @param {unknown} value - value to serialize.
 */
function save(name, value) {
  writeFileSync(join(OUT_DIR, name), `${JSON.stringify(value, null, 1)}\n`)
}

/**
 * Print one measurement line.
 * @param {string} label - what was measured.
 * @param {unknown} value - the measurement.
 */
function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/**
 * Read a CDP value field, which is `unknown` by protocol.
 * @param {unknown} field - a CDP `{ value }` wrapper.
 * @returns the printable text.
 */
function text(field) {
  const value = field?.value
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Attach to the first page of the browser listening on {@link PORT}.
 * @returns the protocol client and the page target.
 */
async function attach() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })
    .then(response => response.json())
  const page = list.find(target => target.type === 'page')
  if (page === undefined) throw new Error(`no page target on 127.0.0.1:${PORT}`)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => { reject(new Error('CDP websocket failed')) }
  })
  let nextId = 1
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) settle.reject(new Error(`${message.error.message} (${String(message.error.code)})`))
    else settle.resolve(message.result ?? {})
  }
  /**
   * Send one command and await its result.
   * @param {string} method - CDP method.
   * @param {object} [params] - method parameters.
   * @returns the result.
   */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => { socket.close() }, target: page }
}

/**
 * Navigate the page and wait for it to finish loading.
 * @param {{send: Function}} client - protocol client.
 * @param {string} url - address to open.
 */
async function navigate(client, url) {
  await client.send('Page.enable')
  await client.send('Page.navigate', { url })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (state.result?.value === 'complete') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const client = await attach()
  try {
    if (TARGET_URL !== undefined) {
      console.log(`\n=== navigating to ${TARGET_URL} ===`)
      await navigate(client, TARGET_URL)
    } else {
      console.log('\n=== injecting the fixture page ===')
      await client.send('Runtime.evaluate', {
        expression: `document.title = 'ax probe'; document.body.innerHTML = ${JSON.stringify(FIXTURE)}; 'ok'`,
        returnByValue: true,
      })
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    console.log(`\n=== accessibility tree (${TARGET_URL ?? 'fixture'}) ===`)
    const startedAt = Date.now()
    const { nodes = [] } = await client.send('Accessibility.getFullAXTree')
    say('nodes', nodes.length)
    say('fetch ms', Date.now() - startedAt)
    save('tree.json', nodes)

    /** Node counts by role, for the noise question. */
    const byRole = new Map()
    /** How many nodes carry a backendDOMNodeId, i.e. can take a ref. */
    let withBackend = 0
    let ignored = 0
    /** Ignored nodes by their reported reasons. */
    const ignoredReasons = new Map()
    for (const node of nodes) {
      const role = text(node.role) || 'node'
      byRole.set(role, (byRole.get(role) ?? 0) + 1)
      if (node.backendDOMNodeId !== undefined) withBackend += 1
      if (node.ignored === true) {
        ignored += 1
        for (const reason of node.ignoredReasons ?? []) {
          const name = reason?.name ?? 'unknown'
          ignoredReasons.set(name, (ignoredReasons.get(name) ?? 0) + 1)
        }
      }
    }
    say('with backendDOMNodeId', withBackend)
    say('ignored', ignored)
    say('ignoredReasons', [...ignoredReasons].sort((left, right) => right[1] - left[1]).slice(0, 12))
    say('roles', [...byRole].sort((left, right) => right[1] - left[1]).slice(0, 18))

    console.log('\n--- InlineTextBox parents: does the parent carry the text? ---')
    const inline = nodes.filter(node => text(node.role) === 'InlineTextBox')
    say('InlineTextBox nodes', inline.length)
    const parents = new Map(nodes.flatMap(node => (node.childIds ?? []).map(child => [child, node])))
    const samples = inline.slice(0, 6).map((node) => {
      const parent = parents.get(node.nodeId)
      return {
        inline: text(node.name),
        parentRole: text(parent?.role),
        parentName: text(parent?.name),
        parentBackend: parent?.backendDOMNodeId,
      }
    })
    save('inline-parents.json', samples)
    for (const sample of samples) say('sample', sample)

    console.log('\n--- StaticText nodes: the run text and its backend id ---')
    const staticText = nodes.filter(node => text(node.role) === 'StaticText')
    save('statictext.json', staticText.slice(0, 60).map(node => ({
      name: text(node.name),
      backend: node.backendDOMNodeId,
      ignored: node.ignored ?? false,
      children: (node.childIds ?? []).length,
    })))
    for (const node of staticText.slice(0, 8)) {
      say('StaticText', { name: text(node.name), backend: node.backendDOMNodeId, ignored: node.ignored ?? false })
    }

    console.log('\n--- ignored nodes: their roles, names, and reasons ---')
    save('ignored.json', nodes.filter(node => node.ignored === true).slice(0, 40).map(node => ({
      role: text(node.role),
      name: text(node.name),
      reasons: (node.ignoredReasons ?? []).map(reason => reason.name),
      backend: node.backendDOMNodeId,
    })))
    for (const node of nodes.filter(entry => entry.ignored === true).slice(0, 8)) {
      say(text(node.role) || 'node', {
        name: text(node.name),
        reasons: (node.ignoredReasons ?? []).map(reason => reason.name),
        backend: node.backendDOMNodeId,
      })
    }

    console.log('\n--- properties and description, as CDP reports them ---')
    const withProps = nodes.filter(node => (node.properties ?? []).length > 0).slice(0, 12)
    save('properties.json', withProps.map(node => ({
      role: text(node.role),
      name: text(node.name),
      description: text(node.description),
      properties: (node.properties ?? []).map(property => [property.name, text(property.value)]),
    })))
    for (const node of withProps) {
      say(text(node.role), {
        name: text(node.name),
        description: text(node.description),
        properties: (node.properties ?? []).map(property => `${property.name}=${text(property.value)}`),
      })
    }

    console.log('\n--- what the plugin prints today ---')
    try {
      const { formatAxTree, DEFAULT_MAX_NODES } = await import('../src/browser/aria.ts')
      // The same real tree through the same formatter at the budget the
      // configuration used to default to and at the one it defaults to now.
      for (const budget of [300, DEFAULT_MAX_NODES]) {
        const shape = formatAxTree(nodes, { maxNodes: budget })
        say(`budget ${String(budget)}`, {
          nodes: shape.nodes,
          elided: shape.elided,
          truncated: shape.truncated,
          refs: shape.refs.size,
          chars: shape.text.length,
        })
        if (budget === DEFAULT_MAX_NODES) {
          writeFileSync(join(OUT_DIR, 'after.txt'), `${shape.text}\n`)
          save('after-refs.json', [...shape.refs])
        }
      }
    } catch (error) {
      say('formatter import failed', error instanceof Error ? error.message : String(error))
    }

    console.log('\n--- Accessibility.getPartialAXTree(backendNodeId, fetchRelatives:false) ---')
    const link = nodes.find(node => text(node.role) === 'link' && node.backendDOMNodeId !== undefined)
    if (link === undefined) {
      say('link to target', 'none on this page')
    } else {
      const partial = await client.send('Accessibility.getPartialAXTree', {
        backendNodeId: link.backendDOMNodeId,
        fetchRelatives: false,
      })
      const partialNodes = partial.nodes ?? []
      save('partial.json', partialNodes)
      say('target', `${text(link.role)} ${JSON.stringify(text(link.name))}`)
      say('returned nodes', partialNodes.length)
      say('roles', partialNodes.map(node => `${text(node.role)}:${JSON.stringify(text(node.name))}`).slice(0, 12))
      say('ignored among them', partialNodes.filter(node => node.ignored === true).length)
    }

    console.log('\n--- DOM.querySelectorAll -> backendDOMNodeId for an ignore selector ---')
    const domStarted = Date.now()
    const { root } = await client.send('DOM.getDocument', { depth: 0 })
    say('getDocument ms', Date.now() - domStarted)
    const found = await client.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-dsh-browser-ignore]',
    })
    say('matched', found.nodeIds.length)
    for (const nodeId of found.nodeIds) {
      const described = await client.send('DOM.describeNode', { nodeId, depth: -1, pierce: false })
      /** Every backend id in the matched subtree, which is what the tree filter needs. */
      const backendIds = []
      /**
       * Walk one described node.
       * @param {object} node - a `DOM.Node`.
       */
      const walk = (node) => {
        if (node.backendNodeId !== undefined) backendIds.push(node.backendNodeId)
        for (const child of node.children ?? []) walk(child)
      }
      walk(described.node)
      save('ignore-subtree.json', { selector: '[data-dsh-browser-ignore]', backendIds })
      say('subtree backend ids', backendIds)
    }
    say('ignore lookup ms', Date.now() - domStarted)

    console.log('\n--- Runtime.evaluate with replMode (top-level await) ---')
    save('repl-mode.json', [])
    for (const [label, params] of [
      ['plain + awaitPromise', { expression: 'await Promise.resolve(41)', awaitPromise: true, returnByValue: true }],
      ['replMode + awaitPromise', { expression: 'await Promise.resolve(42)', awaitPromise: true, returnByValue: true, replMode: true }],
      ['replMode expression', { expression: 'document.title', returnByValue: true, replMode: true }],
      ['replMode statements', { expression: 'const x = 1; x + 1', returnByValue: true, replMode: true }],
      ['replMode async iife', { expression: '(async () => 43)()', awaitPromise: true, returnByValue: true, replMode: true }],
    ]) {
      const outcome = await client.send('Runtime.evaluate', params).then(
        result => ({
          value: result.result?.value ?? result.result?.unserializableValue,
          error: result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text,
        }),
        error => ({ error: error.message }),
      )
      say(label, outcome)
    }

    console.log('\n--- page info metrics ---')
    const metrics = await client.send('Page.getLayoutMetrics')
    save('metrics.json', metrics)
    say('cssVisualViewport', metrics.cssVisualViewport)
    say('cssContentSize', metrics.cssContentSize)
    say('cssLayoutViewport pageX/pageY', [metrics.cssLayoutViewport?.pageX, metrics.cssLayoutViewport?.pageY])
  } finally {
    client.close()
  }
  console.log(`\nartifacts in ${OUT_DIR}`)
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
