/**
 * The real-browser half of the snapshot regression pair.
 *
 * `test/` holds what a recording CDP session can assert: which protocol calls an
 * action makes, what the formatter does to a fixture. It cannot hold what only a
 * browser knows — that Chrome's real tree survives the filters, that a
 * client-rendered page reports its own geometry, that a click reports the
 * address it landed on, that `await` at the top level evaluates. Those are
 * checked here, through the same `SessionBrowser` the tools use, on a real
 * Chrome and a real page.
 *
 * The task set is fixed so two runs can be compared: navigate, read the page,
 * re-read it, click a link out of the tree, narrow the tree two ways, scroll and
 * check the page line moved, run an awaited expression, drive a fixture that
 * asks to be left out, and spill a snapshot to a file.
 *
 * Usage: node scripts/snapshot-regression.mjs [--url=<address>] [--headful]
 *
 * Artifacts land in `.prove/snapshot-regression/`; the run exits non-zero if any
 * check failed, so it can gate a release the way `prove.mjs` does.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, plainConfig } from '../src/config.ts'
import { cancelable } from '../src/browser/cancel.ts'
import { PortAllocator, portWindow } from '../src/browser/ports.ts'
import { SessionBrowser } from '../src/browser/session-browser.ts'
import { launchBrowser } from '../src/browser/launch.ts'
import { writeText } from '../src/tools/spill.ts'

/** Address the task set runs against. */
const URL_ARG = process.argv.find(argument => argument.startsWith('--url='))?.slice('--url='.length)
  ?? 'https://github.com/trending'
/** Whether to run with a window, which is worth doing once by hand. */
const HEADFUL = process.argv.includes('--headful')
/** Where this script writes its evidence. */
const OUT_DIR = join(process.cwd(), '.prove', 'snapshot-regression')
/** Progress log, written step by step so a killed run still explains itself. */
const LOG_FILE = join(OUT_DIR, 'run.log')

/** A page that asks for parts of itself to be left out, and splits text into runs. */
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>snapshot fixture</title>
<h1>Snapshot fixture</h1>
<p>Hello <b>bold</b> world, one paragraph split into runs.</p>
<a href="https://example.test/one" title="the title">A link</a>
<button aria-expanded="false" aria-haspopup="menu">Menu</button>
<input placeholder="Search" aria-label="Search box">
<div aria-hidden="true"><button>hidden button</button><p>hidden text</p></div>
<div data-dsh-browser-ignore><button>ignore me</button><p>ignored text</p></div>
<nav><a href="https://example.test/two">Docs</a><a href="https://example.test/three">Pricing</a></nav>`

/**
 * A page whose menu opens inside the click handler, the way `<details>` does.
 *
 * This is the shape that reported "did not change" while the menu opened: the
 * whole reaction is synchronous, so only an observer already installed when the
 * events went out can see it.
 */
const ACTION_FIXTURE = `<!doctype html><meta charset="utf-8"><title>action fixture</title>
<h1>Action fixture</h1>
<details><summary>Menu</summary><div><a href="#opened">This week</a></div></details>`

/**
 * A page with many labelled nodes and a cover that can be shown over one of them.
 *
 * The node count matters: a stale ref is only dangerous when the next page
 * hands out that many labels of its own.
 */
const COVERED_FIXTURE = `<!doctype html><meta charset="utf-8"><title>covered fixture</title>
<h1>Covered fixture</h1>
<ul>${'<li><a href="#item">an item</a></li>'.repeat(12)}</ul>
<button id="under">Under</button>
<div id="veil" style="display:none;position:fixed;left:0;top:0;right:0;bottom:0;z-index:10" aria-label="Veil">Veil</div>`

/**
 * A page taller than the viewport, with a control below the fold.
 *
 * Every other fixture fits on one screen, and on an unscrolled page a box in the
 * frame's viewport pixels and a box in page pixels are the same number — which is
 * why the click that subtracted the scroll offset from a viewport box survived
 * all of them. The handler writes down the y the press arrived at and changes
 * its own text, so what the checks read is the element's own record of being
 * pressed rather than the absence of an error. (It does not rely on the link's
 * `#fragment` destination: Chrome refuses a top-level `data:` navigation, so the
 * default action never runs even when the press lands.)
 */
const SCROLLED_FIXTURE = `<!doctype html><meta charset="utf-8"><title>scrolled fixture</title>
<h1>Scrolled fixture</h1>
<div style="height:2600px"></div>
<a id="deep" href="#pressed" onclick="globalThis.__pressedY = Math.round(event.clientY); this.textContent = 'Pressed at ' + globalThis.__pressedY">Deep link</a>`

/**
 * A page with one field that cannot take text and one that can.
 *
 * A read-only input still takes the focus, so `Input.insertText` goes out and
 * inserts nothing at all — measured 2026-09-24 in real Chrome, where the report
 * said the text had been typed. Only the field's own value says whether it
 * landed, which is why both fields are read back rather than trusted.
 */
const TYPING_FIXTURE = `<!doctype html><meta charset="utf-8"><title>typing fixture</title>
<h1>Typing fixture</h1>
<input id="fixed" placeholder="locked" readonly>
<input id="free" placeholder="free">`

const t0 = Date.now()
const results = []

/**
 * Append one progress line to stdout and the run log.
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
 * @param {unknown} [detail] - evidence shown beside the verdict.
 */
function check(name, passed, detail = '') {
  const shown = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ name, passed, detail: shown })
  log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${shown === '' ? '' : ` — ${shown}`}`)
}

/**
 * Run one step under a deadline.
 * @param {string} label - step name used in the log and the timeout error.
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
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The ref a snapshot gave a link whose url is known.
 * @param {string} text - the snapshot text.
 * @param {string} url - the address the link goes to.
 * @returns the ref label, or `undefined` when the tree has no such link.
 */
function refForUrl(text, url) {
  for (const line of text.split('\n')) {
    if (!line.includes(`url="${url}"`)) continue
    const found = /\[ref=(e\d+)\]/.exec(line)
    if (found !== null) return found[1]
  }
  return undefined
}

/**
 * The ref of the first printed line matching a pattern.
 * @param {string} text - the snapshot text.
 * @param {RegExp} pattern - what the line must contain.
 * @returns the ref label, or `undefined` when no line matches.
 */
function refFor(text, pattern) {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const found = /\[ref=(e\d+)\]/.exec(line)
    if (found !== null) return found[1]
  }
  return undefined
}

/**
 * Run one action that is expected to fail, and report what it said.
 * @param {() => Promise<unknown>} fn - the action.
 * @returns the error message, or a note that nothing was thrown.
 */
async function refusal(fn) {
  try {
    await fn()
    return 'no error was raised'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '')
  log(`node ${process.version} on ${process.platform}; url ${URL_ARG}; ${HEADFUL ? 'headful' : 'headless'}`)

  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-regression-'))
  const config = plainConfig(Config({
    headless: !HEADFUL,
    stealth: true,
    viewportWidth: 1440,
    viewportHeight: 900,
    snapshotNodes: 500,
    userDataDir: '',
  }))
  const browser = new SessionBrowser('session-regression', {
    config,
    ports: new PortAllocator(portWindow(config.debugPortMin, config.debugPortMax)),
    launch: launchBrowser,
    logger: {
      info: message => { log(`browser: ${message}`) },
      warn: error => { log(`browser warn: ${error.message}`) },
    },
  })

  try {
    log('\n[1] navigate and read the whole page')
    const open = await step('navigate', 60_000, () => browser.navigate(URL_ARG))
    check('navigation reports the address it landed on', open.url.startsWith(URL_ARG.split('?')[0]),
      `${open.url} (changed: ${open.changed.join(', ') || 'nothing'})`)

    const first = await step('snapshot', 60_000, () => browser.snapshot())
    writeFileSync(join(OUT_DIR, 'snapshot.txt'), `${first.text}\n`)
    const inlineBoxes = first.text.split('\n').filter(line => line.includes('InlineTextBox')).length
    check('the whole page fits in one snapshot at the default budget', !first.truncated,
      `${first.nodes} nodes, elided budget=${first.elided.budget} depth=${first.elided.depth}`)
    check('one-letter text boxes are gone', inlineBoxes === 0, `${inlineBoxes} InlineTextBox lines`)
    check('the snapshot is bigger than the old third-of-a-page budget', first.nodes > 300, `${first.nodes} nodes`)
    check('page geometry is reported', first.info.viewportWidth > 0 && first.info.pageHeight >= first.info.viewportHeight,
      JSON.stringify(first.info))
    const links = first.text.split('\n').filter(line => line.includes('url="http')).length
    check('link destinations are printed', links > 0, `${links} link lines carry a url`)

    log('\n[2] a second snapshot of the same page keeps the labels it handed out')
    const second = await step('second snapshot', 60_000, () => browser.snapshot())
    let shared = 0
    let moved = 0
    for (const [label, backend] of first.refs) {
      const again = second.refs.get(label)
      if (again === undefined) continue
      shared += 1
      if (again !== backend) moved += 1
    }
    check('refs did not renumber between snapshots', shared > 100 && moved === 0, `${shared} shared, ${moved} moved`)

    log('\n[3] narrow the snapshot two ways')
    // A ref that is a genuine subtree rather than the page root: any labelled
    // line at least two levels in.
    const nested = first.text.split('\n').find(line => /^\s{4,}- /.test(line) && /\[ref=e\d+\]/.test(line))
    const narrowRef = /\[ref=(e\d+)\]/.exec(nested ?? '')?.[1] ?? [...first.refs.keys()][0]
    const narrowed = await step('snapshot target', 60_000, () => browser.snapshot({ target: narrowRef }))
    const targetLine = narrowed.text.split('\n')[0] ?? ''
    check('a target prints the subtree it names', narrowed.nodes < first.nodes && targetLine.includes(`[ref=${narrowRef}]`),
      `${narrowRef}: ${narrowed.nodes} of ${first.nodes} nodes, first line ${JSON.stringify(targetLine.slice(0, 70))}`)
    const shallow = await step('snapshot depth', 60_000, () => browser.snapshot({ depth: 1 }))
    check('a depth limit stops early and says what is below it',
      shallow.truncated && shallow.elided.depth > 0 && /depth=1/.test(shallow.text),
      `${shallow.nodes} nodes, elided depth=${shallow.elided.depth}`)
    const bySelector = await step('snapshot selector', 60_000, () => browser.snapshot({ target: 'main' }))
    check('a target can be a CSS selector', bySelector.nodes > 0 && bySelector.nodes < first.nodes,
      `${bySelector.nodes} nodes under main`)

    log('\n[4] click a link out of the tree and believe the result, not the arguments')
    const explore = refForUrl(first.text, 'https://github.com/explore') ?? refForUrl(first.text, 'https://github.com/topics')
    if (explore === undefined) {
      check('a link to click was found in the tree', false, 'no github.com/explore or /topics link')
    } else {
      const report = await step('click', 60_000, () => browser.click(explore))
      check('the click reports the element it acted on', report.element !== undefined && report.element.role === 'link',
        JSON.stringify(report.element))
      check('the click reports the address the page landed on', report.url !== open.url && report.changed.includes('url'),
        `${report.url} (changed: ${report.changed.join(', ') || 'nothing'})`)
      check('the click settled', report.settled, `${String(report.mutations)} mutations`)
      await step('back', 30_000, () => browser.navigate(URL_ARG))
    }

    log('\n[5] scroll, and check the page line moved with the viewport')
    await step('scroll', 30_000, () => browser.evaluate('globalThis.scrollTo(0, 900), globalThis.scrollY'))
    const scrolled = await step('snapshot after scroll', 60_000, () => browser.snapshot({ depth: 0 }))
    check('page info reports the scroll position', scrolled.info.scrolledY > 0,
      `scrolledY=${scrolled.info.scrolledY} of ${scrolled.info.pageHeight}`)

    log('\n[6] an expression that awaits at the top level')
    const awaited = await step('evaluate await', 30_000, () => browser.evaluate(
      'await fetch(globalThis.location.href, { method: "HEAD" }).then(r => r.status)',
    ))
    check('top-level await evaluates', awaited === 200, String(awaited))

    log('\n[7] a fixture that asks to be left out')
    await step('navigate to fixture', 30_000, () => browser.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}`))
    const fixture = await step('fixture snapshot', 30_000, () => browser.snapshot())
    writeFileSync(join(OUT_DIR, 'fixture-snapshot.txt'), `${fixture.text}\n`)
    check('a data-dsh-browser-ignore subtree is not printed', !fixture.text.includes('ignore me') && !fixture.text.includes('ignored text'),
      fixture.text.split('\n').find(line => line.includes('ignore')) ?? 'absent')
    check('an aria-hidden subtree is not printed', !fixture.text.includes('hidden button') && !fixture.text.includes('hidden text'))
    check('text runs read as one line',
      fixture.text.split('\n').some(line => line.includes('Hello bold world, one paragraph split into runs.')),
      fixture.text.split('\n').find(line => line.includes('Hello')) ?? 'absent')
    check('a link carries where it goes', fixture.text.includes('url="https://example.test/one"'))
    check('a heading carries its level', fixture.text.includes('level="1"'))

    log('\n[8] spill a snapshot to a file and read it back')
    const spilled = await step('spill', 30_000, () => writeText(first.text, {
      dir: OUT_DIR,
      toolName: 'browser_snapshot',
      label: 'regression',
    }))
    const back = await readFile(spilled.path, 'utf8')
    check('a spilled snapshot is readable and complete', back === first.text,
      `${String(spilled.bytes)} bytes at ${spilled.path}`)

    log('\n[9] capture a picture')
    const shot = await step('screenshot', 30_000, () => browser.screenshot())
    writeFileSync(join(OUT_DIR, 'shot.jpg'), shot.jpeg)
    check('a screenshot comes back as a JPEG', shot.jpeg[0] === 0xff && shot.jpeg[1] === 0xd8,
      `${shot.width}x${shot.height}, ${String(shot.jpeg.length)} bytes`)
    log('\n[10] a menu that opens inside its own click handler')
    const actionUrl = `data:text/html;charset=utf-8,${encodeURIComponent(ACTION_FIXTURE)}`
    const coveredUrl = `data:text/html;charset=utf-8,${encodeURIComponent(COVERED_FIXTURE)}`
    await step('navigate to the action fixture', 30_000, () => browser.navigate(actionUrl))
    const actionTree = await step('action fixture snapshot', 30_000, () => browser.snapshot())
    const summary = refFor(actionTree.text, /"Menu"/)
    let stale = 'e1'
    if (summary === undefined) {
      check('the disclosure has a ref to click', false, 'no line named "Menu"')
    } else {
      stale = summary
      const opened = await step('click the disclosure', 30_000, () => browser.click(summary))
      check('a reaction inside the click handler is reported as a change',
        opened.changed.includes('dom') && opened.mutations > 0,
        `changed: ${opened.changed.join(', ') || 'nothing'}, ${String(opened.mutations)} mutations`)
      const withMenu = await step('snapshot with the menu open', 30_000, () => browser.snapshot())
      check('the menu the click opened is in the page', withMenu.text.includes('This week'),
        withMenu.text.split('\n').find(line => line.includes('This week')) ?? 'absent')
    }

    log('\n[11] a ref from the page before is refused, not re-pointed')
    await step('navigate to the covered fixture', 30_000, () => browser.navigate(coveredUrl))
    await step('covered fixture snapshot', 30_000, () => browser.snapshot())
    const said = await refusal(() => browser.click(stale))
    check('a stale ref is refused, and says to take a snapshot',
      /not a ref from a snapshot of the current page/.test(said), said.slice(0, 90))

    log('\n[12] a click whose point is covered')
    await step('show the cover', 30_000, () => browser.evaluate(
      "globalThis.document.getElementById('veil').style.display = 'block', 'shown'",
    ))
    const withCover = await step('snapshot with the cover up', 30_000, () => browser.snapshot())
    const under = refFor(withCover.text, /"Under"/)
    if (under === undefined) {
      check('the covered control has a ref to click', false, 'no line named "Under"')
    } else {
      const refused = await refusal(() => browser.click(under))
      check('a click the cover would receive is refused, and names it',
        /would be received by div "Veil"/.test(refused) && /force: true/.test(refused),
        refused.slice(0, 130))
      const forced = await step('force the click through the cover', 30_000, () => browser.click(under, { force: true }))
      check('a forced click goes out and reports what received it',
        forced.obstructed !== undefined && forced.obstructed.name === 'Veil',
        JSON.stringify(forced.obstructed ?? null))
      check('the covered click changed nothing', forced.changed.length === 0,
        `changed: ${forced.changed.join(', ') || 'nothing'}`)
    }
    await step('hide the cover', 30_000, () => browser.evaluate(
      "globalThis.document.getElementById('veil').style.display = 'none', 'hidden'",
    ))

    log('\n[13] a star means the page gained a node, not that the snapshot went deeper')
    await step('read the top', 30_000, () => browser.snapshot({ depth: 1 }))
    const deeper = await step('read it all', 30_000, () => browser.snapshot())
    const marked = deeper.text.split('\n').filter(line => line.includes('*[ref=')).length
    check('asking for more of the page marks nothing as new', marked === 0, `${marked} starred lines`)
    await step('add a node', 30_000, () => browser.evaluate(
      "globalThis.document.querySelector('h1').insertAdjacentHTML('afterend', '<button id=\"later\">Later</button>'), 'added'",
    ))
    const grown = await step('read it again', 30_000, () => browser.snapshot())
    const laterLine = grown.text.split('\n').find(line => line.includes('"Later"')) ?? ''
    check('a node the page gained is marked new', laterLine.includes('*[ref='), laterLine.trim())

    log('\n[14] a function handed to evaluate is called')
    const called = await step('evaluate a function', 30_000, () => browser.evaluate(
      '() => { globalThis.__regressionRan = 7; return 1 }',
    ))
    const sideEffect = await step('read the side effect', 30_000, () => browser.evaluate('globalThis.__regressionRan'))
    check('a function is called rather than answered as {}', called === 1 && sideEffect === 7,
      `returned ${JSON.stringify(called)}, side effect ${JSON.stringify(sideEffect)}`)

    log('\n[15] a click below the fold lands on the element')
    const scrolledUrl = `data:text/html;charset=utf-8,${encodeURIComponent(SCROLLED_FIXTURE)}`
    await step('navigate to the scrolled fixture', 30_000, () => browser.navigate(scrolledUrl))
    const tall = await step('scrolled fixture snapshot', 30_000, () => browser.snapshot())
    check('the fixture is taller than the viewport, so the click has to scroll first',
      tall.info.pageHeight > tall.info.viewportHeight,
      `${String(tall.info.pageHeight)} px tall, ${String(tall.info.viewportHeight)} px viewport`)
    const deep = refFor(tall.text, /"Deep link"/)
    if (deep === undefined) {
      check('the control below the fold has a ref to click', false, 'no line named "Deep link"')
    } else {
      const landed = await step('click the control below the fold', 30_000, () => browser.click(deep))
      const pressedY = await step('read where the press arrived', 30_000,
        () => browser.evaluate('globalThis.__pressedY ?? null'))
      check('the press reached the element, at a point inside the viewport',
        landed.changed.includes('dom')
        && typeof pressedY === 'number' && pressedY >= 0 && pressedY < tall.info.viewportHeight,
        `changed: ${landed.changed.join(', ') || 'nothing'}, press at y=${String(pressedY)}, viewport ${String(tall.info.viewportHeight)}`)
    }

    log('\n[16] a cancelled call gives up, and the browser survives it')
    // A page script that never returns: the evaluate cannot finish on its own,
    // so only the caller's cancellation can end the call. Measured 2026-09-25, a
    // navigation that never landed outlived an interrupt and a turn restart, and
    // only closing the browser by hand ended it.
    const controller = new AbortController()
    const startedAt = Date.now()
    const hung = cancelable(browser, controller.signal, 'evaluating in the page',
      () => browser.evaluate('await new Promise(() => {})'))
    const aborted = setTimeout(() => { controller.abort() }, 500)
    const cancelled = await step('cancel an evaluation that never returns', 10_000, async () => {
      try {
        await hung
        return { threw: false, message: '', ms: Date.now() - startedAt }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { threw: true, message, ms: Date.now() - startedAt }
      } finally {
        clearTimeout(aborted)
      }
    })
    check('a cancelled call gives up instead of waiting for the page',
      cancelled.threw && /was cancelled/.test(cancelled.message),
      `${String(cancelled.ms)}ms — ${cancelled.message || 'the call returned normally'}`)
    const after = await step('use the page after the cancellation', 30_000, () => browser.evaluate('1 + 1'))
    check('the page is usable after a cancelled call', after === 2, `evaluate answered ${JSON.stringify(after)}`)

    log('\n[17] a snippet run twice is not a syntax error the second time')
    const declaredOnce = await step('declare a name on the page', 30_000, () => browser.evaluate('const twice = 41; twice + 1'))
    const declaredAgain = await step('declare the same name again', 30_000, () => browser.evaluate('const twice = 41; twice + 1'))
    check('the second run is retried in a scope of its own rather than refused',
      declaredOnce === 42 && declaredAgain === 42,
      `first ${JSON.stringify(declaredOnce)}, second ${JSON.stringify(declaredAgain)}`)

    log('\n[18] typing asks the page whether the field takes text')
    const typingUrl = `data:text/html;charset=utf-8,${encodeURIComponent(TYPING_FIXTURE)}`
    await step('navigate to the typing fixture', 30_000, () => browser.navigate(typingUrl))
    const fields = await step('typing fixture snapshot', 30_000, () => browser.snapshot())
    const locked = refFor(fields.text, /"locked"/)
    const free = refFor(fields.text, /"free"/)
    if (locked === undefined || free === undefined) {
      check('both fields have a ref to type into', false, `locked ${String(locked)}, free ${String(free)}`)
    } else {
      const refused = await refusal(() => browser.type(locked, 'nope'))
      const lockedValue = await step('read the read-only field', 30_000,
        () => browser.evaluate('document.querySelector("#fixed").value'))
      check('a read-only field is refused by name, not reported as typed',
        /would not take the text because it is read-only/.test(refused),
        refused.slice(0, 140))
      check('the refused text landed nowhere', lockedValue === '', JSON.stringify(lockedValue))
      const typed = await step('type into the field that takes text', 30_000, () => browser.type(free, 'hello'))
      const freeValue = await step('read the other field', 30_000,
        () => browser.evaluate('document.querySelector("#free").value'))
      check('a field that can hold text still gets it',
        freeValue === 'hello' && typed.element.role === 'textbox' && typed.element.name === 'free',
        `${JSON.stringify(freeValue)} into ${typed.element.role} ${JSON.stringify(typed.element.name)}`)
    }

  } finally {
    await browser.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
  const failed = results.filter(entry => !entry.passed)
  writeFileSync(join(OUT_DIR, 'report.md'), [
    '# dsh-browser snapshot regression',
    '',
    `run: ${new Date().toISOString()}`,
    `url: ${URL_ARG}`,
    `mode: ${HEADFUL ? 'headful' : 'headless'}`,
    '',
    ...results.map(entry => `- ${entry.passed ? 'PASS' : 'FAIL'} — ${entry.name}${entry.detail === '' ? '' : ` (${entry.detail})`}`),
    '',
    `${String(results.length - failed.length)}/${String(results.length)} passed`,
    '',
  ].join('\n'))

  log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed; artifacts in ${OUT_DIR}`)
  if (failed.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  log(`\nregression aborted: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  process.exitCode = 1
})
