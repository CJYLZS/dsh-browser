/**
 * Standalone proof of the M1 premises, runnable without the harness.
 *
 * M1 rests on three claims that no amount of reading settles, so they are
 * measured here before any plugin code exists:
 *
 * 1. `launchPersistentContext` keeps its own control channel on a pipe, yet an
 *    extra `--remote-debugging-port` still makes Chrome listen on that port
 *    (external DevTools / Playwright `connectOverCDP` attach).
 * 2. CDP `Page.startScreencast` emits frames for a HEADFUL window, and keeps
 *    emitting only while every frame is acknowledged.
 * 3. `Input.dispatch*` on that same CDP session drives the real window.
 *
 * Every step is bounded and logged to `.prove/run.log` as it happens, so a
 * stalled run names the step it stalled on instead of looking like a hang.
 *
 * Run with `pnpm run prove`. Artifacts land in `.prove/`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** Port requested for the external CDP listener; the real one is read back. */
const REQUESTED_PORT = 9333
/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove')
/** Progress log, written step by step so a killed run still explains itself. */
const LOG_FILE = join(OUT_DIR, 'run.log')

const t0 = Date.now()
const results = []

/**
 * Append one progress line to stdout and to the run log.
 * @param {string} line - text to record.
 */
function log(line) {
  const stamped = `+${String(Date.now() - t0).padStart(7)}ms  ${line}`
  console.log(stamped)
  appendFileSync(LOG_FILE, `${stamped}\n`)
}

/**
 * Record one measured claim.
 * @param {string} name - claim under test.
 * @param {boolean} passed - whether the measurement agreed.
 * @param {string} [detail] - evidence shown beside the verdict.
 */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Await a promise with a hard deadline.
 * @param {string} label - step name used in logs and the timeout error.
 * @param {number} ms - budget before failing.
 * @param {() => Promise<unknown>} fn - the step.
 * @returns the step's value.
 */
async function step(label, ms, fn) {
  log(`start  ${label}`)
  const started = Date.now()
  let timer
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
      }),
    ])
    log(`done   ${label} (${Date.now() - started}ms)`)
    return value
  } catch (error) {
    log(`fail   ${label} (${Date.now() - started}ms): ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until a predicate holds, or throw.
 * @param {() => boolean} predicate - condition to poll.
 * @param {number} timeoutMs - budget before failing.
 * @param {string} label - named in the timeout error.
 */
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** The page driven during the run: a button that reports clicks, and a text field. */
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>dsh-browser proof</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 0; padding: 24px; background: #101418; color: #e8eef4 }
  h1 { font-size: 20px; margin: 0 0 16px }
  button { padding: 12px 20px; font-size: 16px; background: #2b6cb0; color: #fff; border: 0; border-radius: 6px }
  input { display: block; margin-top: 16px; padding: 10px; font-size: 16px; width: 280px }
  #out { margin-top: 16px; font-weight: 700; color: #68d391 }
</style>
<h1>dsh-browser proof</h1>
<button id="btn">click me</button>
<input id="field" placeholder="type here">
<div id="out">idle</div>
<script>
  let clicks = 0
  document.getElementById('btn').addEventListener('click', () => {
    clicks += 1
    document.getElementById('out').textContent = 'clicked ' + clicks
  })
</script>`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  log(`node ${process.version} on ${process.platform}`)
  log(`proxy env: ${['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY']
    .map(key => `${key}=${process.env[key] ?? '-'}`).join(' ')}`)

  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-prove-'))
  log(`profile: ${userDataDir}`)

  log('\n[1] launch real Chrome (headful, persistent context)')
  const context = await step('launchPersistentContext(channel=chrome)', 60_000, () => chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      `--remote-debugging-port=${REQUESTED_PORT}`,
      '--disable-features=CalculateNativeWinOcclusion',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }))
  check('Chrome launched as a separate process', true)

  const page = context.pages()[0] ?? await step('newPage', 30_000, () => context.newPage())
  log(`pages at launch: ${context.pages().length}`)
  await step('setContent', 30_000, () => page.setContent(PAGE_HTML))

  log('\n[2] external CDP endpoint')
  const devtoolsFile = join(userDataDir, 'DevToolsActivePort')
  let portFromFile
  for (let attempt = 0; attempt < 100 && portFromFile === undefined; attempt += 1) {
    try {
      portFromFile = (await readFile(devtoolsFile, 'utf8')).split('\n')[0]
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  check('DevToolsActivePort written', portFromFile !== undefined, portFromFile ?? 'file absent')

  if (portFromFile !== undefined) {
    try {
      const response = await step(`fetch /json/version on :${portFromFile}`, 10_000, () => fetch(
        `http://127.0.0.1:${portFromFile}/json/version`,
        { signal: AbortSignal.timeout(8_000) },
      ))
      const version = await step('read /json/version body', 10_000, () => response.json())
      check('port really listens (/json/version)', response.ok, `HTTP ${response.status}`)
      check('endpoint reports a browser', typeof version.Browser === 'string', String(version.Browser))
      check('external attach target present', typeof version.webSocketDebuggerUrl === 'string',
        typeof version.webSocketDebuggerUrl === 'string'
          ? version.webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*/, '/devtools/browser/<id>')
          : 'absent')
    } catch (error) {
      check('port really listens (/json/version)', false, error instanceof Error ? error.message : String(error))
    }
  }

  log('\n[3] screencast over a CDP session (headful)')
  const cdp = await step('newCDPSession', 20_000, () => context.newCDPSession(page))
  /** Frames received, with arrival time and byte length. */
  const frames = []
  cdp.on('Page.screencastFrame', (event) => {
    frames.push({ bytes: Buffer.from(event.data, 'base64'), at: Date.now(), metadata: event.metadata })
    // Without this ack Chrome stops sending after the first frames.
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  })
  await step('Page.startScreencast', 20_000, () => cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1,
  }))

  try {
    await until(() => frames.length >= 5, 15_000, 'five screencast frames')
    check('screencast emits frames while headful', true, `${frames.length} frames`)
  } catch (error) {
    check('screencast emits frames while headful', false, error instanceof Error ? error.message : String(error))
  }

  if (frames.length > 0) {
    const frame = frames.at(-1)
    const jpeg = frame.bytes[0] === 0xff && frame.bytes[1] === 0xd8 && frame.bytes[2] === 0xff
    check('frame is a JPEG', jpeg, `${frame.bytes.length} bytes, magic ${frame.bytes.subarray(0, 3).toString('hex')}`)
    check('frame carries viewport metadata', typeof frame.metadata?.deviceWidth === 'number',
      `${frame.metadata?.deviceWidth}x${frame.metadata?.deviceHeight}`)
    await writeFile(join(OUT_DIR, 'frame.jpg'), frame.bytes)
  }

  const rateFrom = frames.length
  const rateStart = Date.now()
  await new Promise(resolve => setTimeout(resolve, 2000))
  const measured = frames.length - rateFrom
  check('stream sustains frames (ack loop healthy)', measured > 0,
    `${(measured / ((Date.now() - rateStart) / 1000)).toFixed(1)} fps while static`)

  log('\n[4] input dispatch on the same CDP session')
  const button = await step('locate #btn', 10_000, () => page.locator('#btn').boundingBox())
  const target = { x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) }
  log(`button center: ${target.x},${target.y}`)
  await step('mouse dispatch', 10_000, async () => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  })
  const afterClick = await step('read #out', 10_000, () => page.evaluate(() => document.getElementById('out').textContent))
  check('mouse dispatch drives the real window', afterClick === 'clicked 1', `#out = ${JSON.stringify(afterClick)}`)

  const field = await step('locate #field', 10_000, () => page.locator('#field').boundingBox())
  await step('focus + insertText', 10_000, async () => {
    const point = { x: Math.round(field.x + 10), y: Math.round(field.y + field.height / 2) }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.insertText', { text: 'hello from dsh-browser' })
  })
  const typed = await step('read #field', 10_000, () => page.evaluate(() => document.getElementById('field').value))
  check('keyboard input lands in the page', typed === 'hello from dsh-browser', `value = ${JSON.stringify(typed)}`)

  log('\n[5] navigate + screenshot on the same session')
  await step('Page.navigate about:blank', 20_000, () => cdp.send('Page.navigate', { url: 'about:blank' }))
  try {
    await until(() => page.url() === 'about:blank', 10_000, 'about:blank navigation')
    check('CDP navigation moves the real window', true, page.url())
  } catch (error) {
    check('CDP navigation moves the real window', false, error instanceof Error ? error.message : String(error))
  }

  const shot = await step('Page.captureScreenshot', 20_000, () => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }))
  const shotBytes = Buffer.from(shot.data, 'base64')
  check('screenshot for tool results', shotBytes.length > 1000, `${shotBytes.length} bytes`)
  await writeFile(join(OUT_DIR, 'screenshot.jpg'), shotBytes)

  log('\n[6] teardown')
  await step('Page.stopScreencast', 10_000, () => cdp.send('Page.stopScreencast')).catch(() => {})
  await step('context.close()', 20_000, () => context.close())
  check('persistent context closes cleanly', true)
  let profileRemoved = true
  try {
    await rm(userDataDir, { recursive: true, force: true })
  } catch (error) {
    profileRemoved = false
    log(`profile removal failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  check('temporary profile removed', profileRemoved, userDataDir)

  const failed = results.filter(entry => !entry.passed)
  await writeFile(join(OUT_DIR, 'report.md'), [
    '# dsh-browser M1 premise proof',
    '',
    `run: ${new Date().toISOString()}`,
    '',
    ...results.map(entry => `- ${entry.passed ? 'PASS' : 'FAIL'} — ${entry.name}${entry.detail === '' ? '' : ` (${entry.detail})`}`),
    '',
    `${results.length - failed.length}/${results.length} passed`,
    '',
  ].join('\n'))

  log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts in ${OUT_DIR}`)
  if (failed.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  log(`\nproof aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
