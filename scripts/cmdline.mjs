/**
 * Dump the full Chrome command line Playwright actually launches.
 *
 * The minimize and occlusion runs both kept streaming frames while the window
 * was hidden, in configurations that differed only by our own
 * `--disable-features=CalculateNativeWinOcclusion`. Two identical results from
 * a flag that was supposed to be the difference means some other flag is doing
 * the work, and the launch arguments are the place that shows which.
 *
 * Run with `node scripts/cmdline.mjs`; output goes to `.prove/cmdline.log`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove')
/** Progress log. */
const LOG_FILE = join(OUT_DIR, 'cmdline.log')

/**
 * Append one progress line to stdout and the log file.
 * @param {string} line - text to record.
 */
function log(line) {
  console.log(line)
  appendFileSync(LOG_FILE, `${line}\n`)
}

/**
 * Read the command lines of running chrome.exe processes.
 * @returns the command lines, one per process.
 */
function chromeCommandLines() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
      resolve(error !== null ? [] : stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
    })
  })
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-cmd-'))

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.setContent('<title>cmdline</title><p>probe</p>')

  const lines = await chromeCommandLines()
  const ours = lines.filter(line => line.includes(userDataDir))
  log(`chrome processes for this profile: ${ours.length}`)
  log(`launch arguments Playwright used (verbatim, one per line):\n`)
  const args = (ours[0] ?? '').match(/-{1,2}[^\s"]+/g) ?? []
  for (const arg of args) log(`  ${arg}`)

  const backgrounding = args.filter(arg =>
    arg.includes('backgrounding') || arg.includes('Backgrounding') || arg.includes('background-timer'))
  log(`\nbackground-throttling switches: ${backgrounding.length === 0 ? 'none' : backgrounding.join(' | ')}`)

  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
  log('\nclosed')
}

await main().catch((error) => {
  log(`aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
