/**
 * Decide whether the default headful mirror survives occlusion.
 *
 * The mirror's normal situation is that the DSH page covers the Chrome window,
 * and Chromium suspends painting for a window it judges occluded — which is the
 * event a repaint-driven screencast cannot recover from. Three things are
 * measured here:
 *
 * 1. the flags Chrome actually received (Playwright adds its own
 *    `--disable-features`, so the user-supplied value is not assumed present);
 * 2. frames per second while the window is visible;
 * 3. frames per second while a full-screen Edge window covers it.
 *
 * Frames during (3) mean the anti-occlusion flag holds; zero means headful
 * mirroring needs a different answer for the covered case.
 *
 * Run with `node scripts/occlusion.mjs` (a full-screen Edge window appears for
 * a few seconds, then closes). Output goes to `.prove/occlusion.log`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove')
/** Progress log. */
const LOG_FILE = join(OUT_DIR, 'occlusion.log')
/** Full-screen window used to occlude the Chrome window. */
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
/** Feature list under test, read back from the real command line. */
const FEATURE = 'CalculateNativeWinOcclusion'

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

/**
 * Read the command lines of running chrome.exe processes.
 * @returns the command lines, one per process.
 */
function chromeCommandLines() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ], { windowsHide: true }, (error, stdout) => {
      resolve(error !== null ? [] : stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
    })
  })
}

/** An animated page: the screencast is repaint-driven, so it must keep changing. */
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>occlusion</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#101418;color:#e8eef4}
#tick{font-size:32px;font-weight:700;color:#68d391}</style>
<div id="tick">0</div>`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-occl-'))
  log(`profile: ${userDataDir}`)

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      `--disable-features=${FEATURE}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.setContent(PAGE_HTML)
  await page.evaluate(() => {
    let n = 0
    window.__tick = setInterval(() => {
      n += 1
      document.getElementById('tick').textContent = String(n)
    }, 50)
  })
  await sleep(500)

  log('--- flags Chrome actually received ---')
  const lines = await chromeCommandLines()
  const ours = lines.filter(line => line.includes(userDataDir))
  log(`chrome processes for this profile: ${ours.length}`)
  const commandLine = ours[0] ?? lines[0] ?? ''
  log(`${FEATURE} present: ${commandLine.includes(FEATURE)}`)
  const disableFeatures = commandLine.match(/--disable-features=\S+/g)
  log(`disable-features switches seen: ${disableFeatures === undefined ? 'none' : disableFeatures.join(' | ')}`)
  log(`remote-debugging switches seen: ${(commandLine.match(/--remote-debugging-\S+/g) ?? []).join(' | ') || 'none'}`)

  const cdp = await context.newCDPSession(page)
  let frames = 0
  cdp.on('Page.screencastFrame', (event) => {
    frames += 1
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })

  /**
   * Sample frames per second over a window.
   * @param {string} label - phase name written to the log.
   * @param {number} ms - sampling window.
   * @returns the measured rate.
   */
  async function sample(label, ms) {
    const before = frames
    await sleep(ms)
    const rate = (frames - before) / (ms / 1000)
    log(`${label}: ${frames - before} frames in ${ms}ms = ${rate.toFixed(1)} fps`)
    return rate
  }

  await sleep(1_000)
  const visibleRate = await sample('phase 1 (Chrome visible)', 4_000)

  log('--- covering Chrome with a full-screen Edge window ---')
  const edge = spawn(EDGE, ['--new-window', '--start-fullscreen', 'about:blank'], { detached: true, stdio: 'ignore' })
  edge.unref()
  await sleep(2_500)
  const occludedRate = await sample('phase 2 (Chrome occluded)', 4_000)

  log('--- closing the covering window ---')
  await new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'msedge.exe', '/F', '/T'], { windowsHide: true }, () => resolve())
  })
  await sleep(2_500)
  const restoredRate = await sample('phase 3 (Chrome visible again)', 3_000)

  log('\n--- verdict ---')
  log(`visible=${visibleRate.toFixed(1)} fps, occluded=${occludedRate.toFixed(1)} fps, restored=${restoredRate.toFixed(1)} fps`)
  if (occludedRate > visibleRate * 0.3) {
    log(`=> occlusion does NOT stop the stream: ${FEATURE} is in effect`)
  } else if (occludedRate <= 0.5 && visibleRate > 5) {
    log(`=> occlusion stops the stream: the covered case needs a different answer than headful screencast`)
  } else {
    log('=> inconclusive: the covering window may not have occluded Chrome')
  }

  await cdp.send('Page.stopScreencast').catch(() => {})
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
  log('closed')
}

await main().catch((error) => {
  log(`aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
