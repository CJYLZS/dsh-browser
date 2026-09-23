/**
 * Focused diagnosis of the two M1 premises the first proof run left open.
 *
 * Q1 `--remote-debugging-port` under `launchPersistentContext`: the port file
 *    was absent. Does the listener exist anyway, and what does the profile
 *    directory actually contain?
 * Q2 The screencast delivered one frame and then stopped. Three candidate
 *    causes, separated by measurement:
 *      a) the ack is not reaching Chrome (frames stop after the first);
 *      b) the window is not compositing because it is occluded or in the
 *         background, so there is nothing new to send;
 *      c) `Page.startScreencast` needs the page to be visible at all.
 *    Phase A samples a static page; phase B samples a page whose DOM changes
 *    every 60ms. Frames in B but not A means the stream follows compositing
 *    (b/c), not the ack loop (a).
 * Q3 Did `--disable-features=CalculateNativeWinOcclusion` survive Playwright's
 *    own browser flags? Read back from `chrome://version`.
 *
 * Run with `node scripts/diagnose.mjs`; output goes to `.prove/diagnose.log`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** Port requested for the external CDP listener. */
const REQUESTED_PORT = 9333
/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove')
/** Progress log. */
const LOG_FILE = join(OUT_DIR, 'diagnose.log')

const t0 = Date.now()

/**
 * Append one progress line to stdout and the log file.
 * @param {string} line - text to record.
 */
function log(line) {
  const stamped = `+${String(Date.now() - t0).padStart(7)}ms  ${line}`
  console.log(stamped)
  appendFileSync(LOG_FILE, `${stamped}\n`)
}

/**
 * Sleep for a fixed time.
 * @param {number} ms - milliseconds.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A page whose text can be animated on demand, plus a marker for the static phase. */
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>diagnose</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#101418;color:#e8eef4}
#tick{font-size:28px;font-weight:700;color:#68d391}</style>
<div id="tick">static</div>
<div id="note">no animation running</div>`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-diag-'))
  log(`profile: ${userDataDir}`)

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      `--remote-debugging-port=${REQUESTED_PORT}`,
      '--disable-features=CalculateNativeWinOcclusion',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  log('launched')

  const page = context.pages()[0] ?? await context.newPage()
  await page.setContent(PAGE_HTML)
  await sleep(500)

  log('\n--- Q1: external CDP listener ---')
  const entries = await readdir(userDataDir)
  log(`profile entries: ${entries.join(', ')}`)
  const activePort = entries.find(entry => entry.toLowerCase().includes('devtoolsactiveport'))
  if (activePort !== undefined) {
    const { readFile } = await import('node:fs/promises')
    log(`DevToolsActivePort content: ${JSON.stringify(await readFile(join(userDataDir, activePort), 'utf8'))}`)
  } else {
    log('DevToolsActivePort: not present in the profile root')
  }
  for (const port of [REQUESTED_PORT, REQUESTED_PORT + 1]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(4_000) })
      const body = await response.json()
      log(`port ${port}: HTTP ${response.status}, Browser=${body.Browser}`)
    } catch (error) {
      log(`port ${port}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log('\n--- Q3: browser command line ---')
  try {
    const versionPage = await context.newPage()
    await versionPage.goto('chrome://version')
    const text = await versionPage.evaluate(() => document.body.innerText)
    const line = text.split('\n').find(entry => entry.includes('--disable-features') || entry.includes('Command Line'))
    const commandLine = text.split('\n')[text.split('\n').findIndex(entry => entry.trim() === 'Command Line') + 1] ?? ''
    log(`has CalculateNativeWinOcclusion: ${commandLine.includes('CalculateNativeWinOcclusion')}`)
    log(`has remote-debugging-port: ${commandLine.includes('--remote-debugging-port')}`)
    log(`has remote-debugging-pipe: ${commandLine.includes('--remote-debugging-pipe')}`)
    const disableFeatures = commandLine.match(/--disable-features=\S+/g)
    log(`disable-features flags: ${disableFeatures === undefined ? 'none' : disableFeatures.join(' | ')}`)
    log(`command line excerpt: ${commandLine.slice(0, 700)}`)
    void line
    await versionPage.close()
  } catch (error) {
    log(`chrome://version unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  log('\n--- Q2: frame flow, static vs animated ---')
  const cdp = await context.newCDPSession(page)
  let acksSent = 0
  let ackErrors = 0
  let frames = 0
  let lastFrameAt = 0
  cdp.on('Page.screencastFrame', (event) => {
    frames += 1
    lastFrameAt = Date.now()
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .then(() => { acksSent += 1 })
      .catch(() => { ackErrors += 1 })
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })

  await sleep(3_000)
  const staticFrames = frames
  log(`phase A (static, 3s): ${staticFrames} frames, acks sent ${acksSent}, ack errors ${ackErrors}`)

  const before = frames
  await page.evaluate(() => {
    let n = 0
    window.__dshTick = setInterval(() => {
      n += 1
      document.getElementById('tick').textContent = `tick ${n}`
      document.getElementById('note').textContent = 'animating'
    }, 60)
  })
  await sleep(3_000)
  const animatedFrames = frames - before
  log(`phase B (animated, 3s): ${animatedFrames} frames, acks sent ${acksSent}, ack errors ${ackErrors}`)
  await page.evaluate(() => { clearInterval(window.__dshTick) })

  const beforeIdle = frames
  await sleep(1_000)
  const idleFrames = frames - beforeIdle
  log(`phase C (animation stopped, 1s): ${idleFrames} frames`)

  log(`\nverdict: static=${staticFrames}/3s animated=${animatedFrames}/3s idle-after-animation=${idleFrames}/1s ackErrors=${ackErrors}`)
  if (animatedFrames > 0 && staticFrames === 0) {
    log('=> the stream follows compositing; a static, uncomposited window sends nothing')
  } else if (animatedFrames > 0 && staticFrames > 0) {
    log('=> the stream runs continuously (compositing healthy)')
  } else {
    log('=> no frames at all in either phase; the ack loop or the page visibility is the cause')
  }
  void lastFrameAt

  await cdp.send('Page.stopScreencast').catch(() => {})
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
  log('closed')
}

await main().catch((error) => {
  log(`aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
