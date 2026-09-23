/**
 * Talk to the mirrored browser over its own external CDP port.
 *
 * This is the same attachment path DevTools and another Playwright use, so it
 * doubles as the check that the port serves real clients and as the test rig
 * for the Sidebar's input forwarding: `inject` puts a full-viewport button in
 * the page, and `read` reports what the button says afterwards.
 *
 * Usage: node scripts/cdp.mjs [--port=9334] <inject|read|point|list|eval|goto> [argument]
 *
 * The port is per session since browsers became per session: the plugin reports
 * which one each session landed on, and this defaults to the first.
 */
import { setTimeout as delay } from 'node:timers/promises'

/** Port the plugin's external CDP listener answers on, unless one is named. */
const DEFAULT_PORT = 9333

const args = process.argv.slice(2)
const portArgument = args.find(argument => argument.startsWith('--port='))
const PORT = portArgument === undefined ? DEFAULT_PORT : Number(portArgument.slice('--port='.length))
const rest = args.filter(argument => !argument.startsWith('--port='))

/**
 * List the browser's targets.
 * @returns the parsed `/json/list` payload.
 */
async function targets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })
  return await response.json()
}

/**
 * Run one CDP command on the page target.
 * @param method - CDP method name.
 * @param params - method parameters.
 * @returns the command result.
 */
async function evaluate(method, params) {
  const list = await targets()
  const page = list.find(target => target.type === 'page')
  if (page === undefined) throw new Error('no page target')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => { reject(new Error('CDP websocket failed')) }
  })
  const result = await new Promise((resolve) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === 1) resolve(message.result ?? message.error)
    }
    socket.send(JSON.stringify({ id: 1, method, params }))
  })
  socket.close()
  await delay(50)
  return result
}

const command = rest[0] ?? 'list'

if (command === 'list') {
  const list = await targets()
  for (const target of list) console.log(`${target.type}\t${target.url}`)
} else if (command === 'inject') {
  const result = await evaluate('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<button id="t" style="position:fixed;inset:0;margin:0;border:0;font-size:64px">off</button>';
      document.getElementById('t').addEventListener('click', () => { document.getElementById('t').textContent = 'ON'; });
      return document.getElementById('t').textContent;
    })()`,
    returnByValue: true,
  })
  console.log(`injected; button text = ${JSON.stringify(result?.result?.value)}`)
} else if (command === 'read') {
  const result = await evaluate('Runtime.evaluate', {
    expression: 'document.getElementById("t") === null ? "missing" : document.getElementById("t").textContent',
    returnByValue: true,
  })
  console.log(`button text = ${JSON.stringify(result?.result?.value)}`)
} else if (command === 'point') {
  // Where the first link sits, as a fraction of the page viewport — the form
  // the Sidebar viewer sends, so a click can be aimed exactly at it.
  const result = await evaluate('Runtime.evaluate', {
    expression: `(() => {
      const link = document.querySelector('a');
      if (link === null) return null;
      const r = link.getBoundingClientRect();
      return {
        href: link.href,
        text: link.textContent.trim(),
        x: (r.x + r.width / 2) / innerWidth,
        y: (r.y + r.height / 2) / innerHeight,
        viewport: { width: innerWidth, height: innerHeight },
      };
    })()`,
    returnByValue: true,
  })
  console.log(JSON.stringify(result?.result?.value))
} else if (command === 'eval') {
  const expression = rest.slice(1).join(' ')
  const result = await evaluate('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  console.log(JSON.stringify(result?.result?.value ?? result, null, 1))
} else if (command === 'goto') {
  const url = rest[1]
  if (url === undefined) throw new Error('goto needs a url')
  await evaluate('Page.navigate', { url })
  await delay(2500)
  const result = await evaluate('Runtime.evaluate', { expression: 'document.title + " | " + location.href', returnByValue: true })
  console.log(result?.result?.value)
} else {
  throw new Error(`unknown command ${command}`)
}
