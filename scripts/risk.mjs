/**
 * Find which launch configuration Google's risk control reacts to.
 *
 * The report was "Edge in InPrivate searches fine, the DSH mirror is flagged
 * after one search". Network is shared (the machine routes through a TUN
 * proxy), so the difference has to be in the browser. One variable is
 * obviously different — headless — but "obviously" is what an earlier claim
 * in this project got wrong, so this script runs the configurations against
 * each other and reports what each one actually got back.
 *
 * Every configuration gets a fresh temporary profile, its own fingerprint
 * read from the page, one search, and the page's own answer recorded.
 *
 * Usage: node scripts/risk.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

/** Evidence directory, next to the other prove scripts' output. */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.prove', 'risk')

/** Query every configuration searches for, so the comparison is one variable. */
const QUERY = 'playwright browser testing'

/** What the page can see about itself; the fingerprint anti-bot systems score. */
const PROBE = `(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl === null ? null : gl.getExtension('WEBGL_debug_renderer_info');
  const uaData = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    uaDataBrands: uaData === undefined ? null : uaData.brands.map(b => b.brand + '/' + b.version),
    webdriver: navigator.webdriver,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    hasChrome: typeof window.chrome,
    chromeRuntime: typeof window.chrome === 'object' && window.chrome !== null ? typeof window.chrome.runtime : 'n/a',
    notificationPermission: typeof Notification === 'undefined' ? 'undefined' : Notification.permission,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, window.devicePixelRatio],
    outerSize: [window.outerWidth, window.outerHeight],
    innerSize: [window.innerWidth, window.innerHeight],
    webglVendor: debug === null ? null : gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
    webglRenderer: debug === null ? null : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  };
})()`

/** What the page answered: results, a challenge, or a consent wall. */
const VERDICT = `(() => {
  const text = document.body === null ? '' : document.body.innerText;
  return {
    url: location.href,
    title: document.title,
    results: document.querySelector('#search') !== null || document.querySelector('#rso') !== null,
    resultLinks: document.querySelectorAll('#rso a h3').length,
    unusualTraffic: /unusual traffic/i.test(text),
    recaptcha: document.querySelector('iframe[src*="recaptcha"]') !== null || /recaptcha/i.test(text),
    sorry: location.href.includes('/sorry/'),
    consent: /before you continue|consent/i.test(text),
    captchaForm: document.querySelector('form[action*="sorry"]') !== null,
    head: text.slice(0, 220).replace(/\\s+/g, ' '),
  };
})()`

/** Resolve the search box, whichever markup Google served. */
const SEARCH_BOX = 'textarea[name="q"], input[name="q"]'

/** Sleep, for pacing between launches. */
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * The configurations under test. `control` marks the ones matching the
 * reported-working setup (a real Edge window).
 */
const CONFIGS = [
  {
    name: 'edge-headful',
    label: 'Edge，真实窗口（对照：用户说能正常搜索）',
    control: true,
    launch: { channel: 'msedge', headless: false, viewport: null },
  },
  {
    name: 'chrome-headless-plugin-default',
    label: 'Chrome，插件当前默认（headless + 插件参数）',
    launch: {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: ['--remote-debugging-port=9401', '--no-first-run', '--no-default-browser-check'],
    },
  },
  {
    name: 'chrome-headful',
    label: 'Chrome，真实窗口',
    launch: {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    },
  },
  {
    name: 'msedge-headless',
    label: 'Edge，headless（把"哪个浏览器"和"有没有头"分开）',
    launch: { channel: 'msedge', headless: true, viewport: { width: 1440, height: 900 } },
  },
  {
    name: 'chrome-headless-stealth',
    label: 'Chrome，headless + 反自动化 flag + UA 覆盖',
    launch: {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      // The UA is filled in from the browser's own build number below.
      stealthUserAgent: true,
    },
  },
  {
    name: 'edge-headful-again',
    label: 'Edge，真实窗口（第二次，用来排除"搜多了才被限速"）',
    control: true,
    launch: { channel: 'msedge', headless: false, viewport: null },
  },
]

/**
 * Read the installed Chrome build so the stealth UA matches it.
 * @returns the exact version string, or an empty string when unavailable.
 */
async function chromeVersion() {
  const probe = await mkdtemp(join(tmpdir(), 'dsh-risk-probe-'))
  try {
    const context = await chromium.launchPersistentContext(probe, { channel: 'chrome', headless: true })
    const version = context.browser()?.version() ?? ''
    await context.close()
    return version
  } catch {
    return ''
  } finally {
    await rm(probe, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/**
 * Run one configuration end to end.
 * @param config - the entry from {@link CONFIGS}.
 * @returns the fingerprint and the page's verdict, or the failure.
 */
async function run(config, ua) {
  const profile = await mkdtemp(join(tmpdir(), `dsh-risk-${config.name}-`))
  const launch = { ...config.launch }
  delete launch.stealthUserAgent
  if (config.launch.stealthUserAgent === true) {
    launch.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36`
  }
  let context
  try {
    context = await chromium.launchPersistentContext(profile, launch)
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const fingerprint = await page.evaluate(PROBE)

    let search = { attempted: false }
    try {
      await page.waitForSelector(SEARCH_BOX, { timeout: 15_000 })
      await page.fill(SEARCH_BOX, QUERY)
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
        page.keyboard.press('Enter'),
      ])
      await page.waitForTimeout(2_500)
      search = await page.evaluate(VERDICT)
    } catch (error) {
      search = { attempted: true, error: error instanceof Error ? error.message : String(error) }
    }

    await page.screenshot({ path: join(OUT, `${config.name}.png`), fullPage: false }).catch(() => {})
    return { ...config, fingerprint, search }
  } catch (error) {
    return {
      ...config,
      failed: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (context !== undefined) await context.close().catch(() => {})
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

await mkdir(OUT, { recursive: true })
const ua = await chromeVersion()
console.log(`Chrome 版本 ${ua === '' ? '(未读到)' : ua}`)

// The exit address rotates, so one run per configuration says nothing about
// which configuration caused what. Rounds interleave the configurations so
// time and address drift hit all of them equally.
const only = (process.argv.find(a => a.startsWith('--configs=')) ?? '').slice(10)
const selected = only === '' ? CONFIGS : CONFIGS.filter(c => only.split(',').includes(c.name))
const rounds = Number((process.argv.find(a => a.startsWith('--rounds=')) ?? '--rounds=1').slice(9)) || 1

const results = []
for (let round = 1; round <= rounds; round++) {
  for (const config of selected) {
    process.stdout.write(`\n=== 第 ${round} 轮 ${config.name} — ${config.label}\n`)
    const result = { round, ...await run(config, ua) }
    results.push(result)
    if (result.failed !== undefined) {
      console.log(`  启动/运行失败: ${result.failed}`)
    } else {
      const f = result.fingerprint
      const s = result.search
      console.log(`  UA        ${f.userAgent}`)
      console.log(`  webdriver ${f.webdriver}`)
      console.log(`  搜索结果  results=${s.results} links=${s.resultLinks} 风控页=${s.unusualTraffic} sorry=${s.sorry} recaptcha=${s.recaptcha}`)
      console.log(`  地址      ${String(s.url).slice(0, 70)}`)
    }
    await sleep(4_000)
  }
}

console.log('\n===== 汇总 =====')
for (const config of selected) {
  const runs = results.filter(r => r.name === config.name)
  const passed = runs.filter(r => r.search?.results === true && r.search?.sorry === false).length
  console.log(`${config.name.padEnd(34)} 通过 ${passed}/${runs.length}`)
}

await writeFile(join(OUT, 'result.json'), JSON.stringify(results, null, 2))
console.log(`\n证据写入 ${OUT}`)
