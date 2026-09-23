/**
 * Report what the mirrored browser looks like from inside the page.
 *
 * Anti-bot systems score a browser on signals the page can read for itself, so
 * the useful question is not "is this Playwright" but "which of the signals
 * this page can see differ from a browser a person opened". Every value below
 * is read through the page, over the plugin's own external CDP port.
 *
 * Usage: node scripts/fingerprint.mjs
 */
import { setTimeout as delay } from 'node:timers/promises'

/** Where the plugin's external CDP listener answers. */
const PORT = 9333

/** The probe, written as one expression so it runs in the page context. */
const PROBE = `(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl === null ? null : gl.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    hasChromeObject: typeof window.chrome,
    chromeRuntime: typeof window.chrome === 'object' && window.chrome !== null ? typeof window.chrome.runtime : 'n/a',
    permissionsNotification: typeof Notification === 'undefined' ? 'undefined' : Notification.permission,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, window.devicePixelRatio],
    outerSize: [window.outerWidth, window.outerHeight],
    innerSize: [window.innerWidth, window.innerHeight],
    webglVendor: debug === null ? null : gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
    webglRenderer: debug === null ? null : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  };
})()`

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json()
const page = list.find(target => target.type === 'page')
if (page === undefined) throw new Error('no page target; open the Sidebar browser tab first')

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
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: PROBE, returnByValue: true } }))
})
socket.close()
await delay(50)

const values = result?.result?.value
if (values === undefined) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${String(key).padEnd(22)} ${JSON.stringify(value)}`)
  }
}
