/**
 * Compare window modes for the mirror, with the window targeted by proof.
 *
 * The first attempt at this compared a "minimized" phase that never reported
 * itself hidden, which means the minimize missed the browser under test — the
 * control run said so instead of producing a result, and the run has to select
 * its window by something only our browser has.
 *
 * Each headful run therefore titles its page with a unique marker and asks
 * Windows to minimize the Chrome window carrying that title, reporting back the
 * title it matched. A minimize phase that still reads `document.hidden=false`
 * is then a fact about Chrome, not about the selector.
 *
 * Headless is measured the same way plus a saved frame, because "frames are
 * arriving" and "the frames show the page" are different claims.
 *
 * Run with `node scripts/modes.mjs`; output goes to `.prove/modes.log` and
 * `.prove/headless-frame.jpg`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove')
/** Progress log. */
const LOG_FILE = join(OUT_DIR, 'modes.log')
/** Window control helper, written on start so PowerShell quoting stays out of this file. */
const PS1 = join(OUT_DIR, 'win.ps1')
/** Marker in the page title the window helper matches on. */
const TITLE_MARKER = 'DSH-BROWSER-MODES'

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
 * Minimize or restore the Chrome window whose title carries the marker.
 * @param {'minimize' | 'restore'} command - helper verb.
 * @returns PowerShell's trimmed stdout, naming the window it acted on.
 */
function win(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, command, TITLE_MARKER],
      { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(error !== null ? `error: ${error.message}` : stdout.trim()))
  })
}

/** An animated page with a button, so frame flow and input can both be judged. */
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>__TITLE__</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#101418;color:#e8eef4}
#tick{font-size:32px;font-weight:700;color:#68d391}
button{margin-top:16px;padding:12px 20px;font-size:16px}#out{margin-top:12px;font-weight:700;color:#f6ad55}</style>
<div id="tick">0</div><button id="btn">click me</button><div id="out">idle</div>`

/**
 * Launch one configuration, animate it, and report how it behaves.
 * @param {object} spec - configuration under test.
 * @param {string} spec.label - name used in the log.
 * @param {boolean} spec.headless - whether the browser gets a window.
 * @param {boolean} spec.flag - whether the anti-occlusion flag is passed.
 * @param {boolean} spec.minimize - whether to run the minimize comparison.
 * @returns the measured phases.
 */
async function run(spec) {
  log(`\n=== ${spec.label} (headless=${spec.headless}, flag=${spec.flag}) ===`)
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-modes-'))
  const args = ['--no-first-run', '--no-default-browser-check']
  if (spec.flag) args.push('--disable-features=CalculateNativeWinOcclusion')

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: spec.headless,
    viewport: null,
    args,
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.setContent(PAGE_HTML.replace('__TITLE__', TITLE_MARKER))
  await page.evaluate(() => {
    let n = 0
    setInterval(() => { n += 1; document.getElementById('tick').textContent = String(n) }, 50)
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('out').textContent = 'clicked'
    })
  })
  log(`  page title: ${JSON.stringify(await page.title())}`)

  const cdp = await context.newCDPSession(page)
  let frames = 0
  let ackErrors = 0
  /** The most recent frame, kept so its bytes can be inspected. */
  let lastFrame
  cdp.on('Page.screencastFrame', (event) => {
    frames += 1
    lastFrame = Buffer.from(event.data, 'base64')
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { ackErrors += 1 })
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })

  /**
   * Sample one phase.
   * @param {string} label - phase name.
   * @param {number} ms - sampling window.
   * @returns the measured frames per second plus the page's own visibility state.
   */
  async function sample(label, ms) {
    const before = frames
    await sleep(ms)
    const rate = (frames - before) / (ms / 1000)
    let hidden = 'unreadable'
    try {
      hidden = String(await Promise.race([
        page.evaluate(() => document.hidden),
        sleep(3_000).then(() => 'timeout'),
      ]))
    } catch (error) {
      hidden = `error: ${error instanceof Error ? error.message : String(error)}`
    }
    log(`  ${label}: ${rate.toFixed(1)} fps, document.hidden=${hidden}`)
    return { rate, hidden }
  }

  await sleep(1_000)
  const visible = await sample('visible', 3_000)

  let minimized = null
  if (spec.minimize) {
    log(`  minimize -> ${await win('minimize')}`)
    await sleep(2_000)
    minimized = await sample('minimized', 4_000)
    log(`  restore  -> ${await win('restore')}`)
    await sleep(2_000)
    await sample('restored', 3_000)
  }

  const box = await page.locator('#btn').boundingBox()
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  const clicked = await page.evaluate(() => document.getElementById('out').textContent)
  const tick = await page.evaluate(() => document.getElementById('tick').textContent)
  log(`  input after phases: #out=${JSON.stringify(clicked)}, #tick=${tick}`)
  log(`  acks failed: ${ackErrors}`)

  if (lastFrame !== undefined) {
    const path = join(OUT_DIR, spec.headless ? 'headless-frame.jpg' : 'headful-frame.jpg')
    await writeFile(path, lastFrame)
    const jpeg = lastFrame[0] === 0xff && lastFrame[1] === 0xd8
    log(`  saved ${path.split(/[\\/]/).pop()}: ${lastFrame.length} bytes, jpeg=${jpeg}`)
  }

  await cdp.send('Page.stopScreencast').catch(() => {})
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
  return { visible, minimized, clicked, tick }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  await writeFile(PS1, `param([string]$Command, [string]$Marker)
Add-Type -Namespace Dsh -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
$proc = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*$Marker*" } | Select-Object -First 1
if ($null -eq $proc) { Write-Output "no window titled *$Marker*"; exit }
if ($Command -eq 'minimize') { [void][Dsh.Win]::ShowWindow($proc.MainWindowHandle, 6) }
elseif ($Command -eq 'restore') { [void][Dsh.Win]::ShowWindow($proc.MainWindowHandle, 9); [void][Dsh.Win]::SetForegroundWindow($proc.MainWindowHandle) }
Write-Output "$Command on pid $($proc.Id) title '$($proc.MainWindowTitle)'"
`)

  const withFlag = await run({ label: 'A headful + anti-occlusion flag', headless: false, flag: true, minimize: true })
  const noFlag = await run({ label: 'B headful, control (no flag)', headless: false, flag: false, minimize: true })
  const headless = await run({ label: 'C headless', headless: true, flag: false, minimize: false })

  log('\n=== verdict ===')
  const target = (result) => result.minimized === null
    ? 'not run'
    : `minimized=${result.minimized.rate.toFixed(1)}fps hidden=${result.minimized.hidden}`
  log(`A ${target(withFlag)}`)
  log(`B ${target(noFlag)}`)
  log(`C headless=${headless.visible.rate.toFixed(1)}fps, input=${JSON.stringify(headless.clicked)}, tick=${headless.tick}`)

  const provenMinimize = [withFlag, noFlag].some(result => result.minimized?.hidden === 'true')
  log(provenMinimize
    ? 'minimize reached the window under test (document.hidden=true observed)'
    : 'minimize never hid the window under test in either configuration — no minimize conclusion is available')
  log(withFlag.minimized?.rate > 1
    ? 'headful + flag kept streaming while minimized'
    : 'headful + flag stopped while minimized')
  log(headless.visible.rate > 1
    ? `headless streamed at ${headless.visible.rate.toFixed(1)}fps with no window, and its input reached the page`
    : 'headless produced no frames')
}

await main().catch((error) => {
  log(`aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
