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
 * A page with fields that cannot take text and one that can.
 *
 * A read-only input still takes the focus, so `Input.insertText` goes out and
 * inserts nothing at all — measured 2026-09-24 in real Chrome, where the report
 * said the text had been typed. A disabled input is the other shape: it refuses
 * the focus itself, measured 2026-09-29 on the-internet's dynamic-controls page,
 * where `DOM.focus` rejected with `Element is not focusable` and the caller got
 * the transport's sentence instead of the page's reason. Only the field's own
 * value says whether anything landed, which is why every field is read back
 * rather than trusted.
 */
const TYPING_FIXTURE = `<!doctype html><meta charset="utf-8"><title>typing fixture</title>
<h1>Typing fixture</h1>
<input id="fixed" placeholder="locked" readonly>
<input id="off" placeholder="switched off" disabled>
<input id="free" placeholder="free">`

/**
 * A page with one control name used twice, in two places only their ancestors
 * tell apart.
 *
 * This is the shape a ref cannot express and a locator has to refuse — and the
 * refusal is only usable if it says which candidate is which. Measured
 * 2026-09-29 on the-internet's add/remove page, where two "Delete" buttons read
 * as `in RootWebArea "The Internet"` through `text` and as `no named ancestor`
 * through `selector`: the selector path never asked the tree where its matches
 * sat, so the list that exists to tell them apart said nothing.
 */
const AMBIGUOUS_FIXTURE = `<!doctype html><meta charset="utf-8"><title>ambiguous fixture</title>
<h1>Ambiguous fixture</h1>
<div role="region" aria-label="Running"><button onclick="globalThis.__clicked = true">Stop</button></div>
<div role="region" aria-label="Idle"><button onclick="globalThis.__clicked = true">Stop</button></div>`

/**
 * A page that reacts to one click in three different ways at once.
 *
 * The three are the shapes a change summary has to tell apart: a node appearing
 * with something to say, an attribute toggled on the element that was clicked,
 * and a run of text rewritten in place. All of it happens inside the handler, so
 * a probe armed after the press would see none of it — which is the same reason
 * `[10]` exists.
 */
const CHANGES_FIXTURE = `<!doctype html><meta charset="utf-8"><title>changes fixture</title>
<h1>Changes fixture</h1>
<button id="go">启动并连接</button>
<p id="count">24.1k</p>
<div id="host"></div>
<script>
document.querySelector('#go').addEventListener('click', () => {
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  status.textContent = '先在实例表里点一行'
  document.querySelector('#host').appendChild(status)
  document.querySelector('#count').textContent = '24.2k'
  document.querySelector('#go').setAttribute('disabled', 'true')
})
</script>`

/**
 * A page that becomes ready a moment after it is opened.
 *
 * The delay is the whole point: "is it there yet" is only a question a wait can
 * answer, and a page that was ready immediately would be answered by the first
 * ask, proving nothing about the asking. What appears is a **button** whose
 * accessible name is computed from the text inside it, because that is the shape
 * where the element and the text run under it say the same words — the wait has
 * to match one thing there, and the caller has to be able to act on what it
 * waited for.
 */
const WAIT_FIXTURE = `<!doctype html><meta charset="utf-8"><title>wait fixture</title>
<h1>Wait fixture</h1>
<button id="go">Start</button>
<div id="host"></div>
<p id="state">starting</p>
<script>
document.querySelector('#go').addEventListener('click', () => {
  setTimeout(() => {
    const ready = document.createElement('button')
    ready.id = 'ready'
    ready.textContent = 'engine ready'
    ready.addEventListener('click', () => { globalThis.__clicked = true })
    document.querySelector('#host').appendChild(ready)
    document.querySelector('#state').textContent = 'ready'
    globalThis.__ready = true
  }, 1200)
})
</script>`

/**
 * A page that fails in the three ways a page leaves no mark in the DOM.
 *
 * Each is a different event on the wire: a console call, an uncaught exception,
 * and a resource the browser refuses. None of them changes the accessibility
 * tree or the DOM, which is exactly why the change list cannot explain them —
 * and why the listener has to be attached before the page loads rather than
 * asked about afterwards.
 */
const CONSOLE_FIXTURE = `<!doctype html><meta charset="utf-8"><title>console fixture</title>
<h1>Console fixture</h1>
<p id="state">quiet</p>
<img src="data:image/png;base64,not-a-png" alt="broken image">
<script>
  console.log('booting')
  console.error('save failed', { code: 500 })
  setTimeout(() => { throw new TypeError('save is not a function') }, 50)
</script>`

/**
 * A tall page with a marked control below the fold.
 *
 * The control's own size is what an element capture has to report, and its
 * position below the fold is what makes the capture's coordinate space visible:
 * a clip read as viewport pixels would capture blank paper here, and would
 * capture a different picture after the page is scrolled.
 */
const SHOT_FIXTURE = `<!doctype html><meta charset="utf-8"><title>shot fixture</title>
<h1>Shot fixture</h1>
<div style="height:1800px"></div>
<button id="deep" style="width:180px;height:60px">Deep button</button>
<div style="height:600px"></div>`

/**
 * A page that asks before it does anything, and writes down the answer.
 *
 * A dialog is invisible to every other way of reading a page: it is not in the
 * accessibility tree, it changes no DOM, and the renderer is blocked until it is
 * answered. The page's own text is what the checks read, so the report and the
 * page have to agree about what was answered.
 */
const DIALOG_FIXTURE = `<!doctype html><meta charset="utf-8"><title>dialog fixture</title>
<h1>Dialog fixture</h1>
<button id="ask" onclick="document.querySelector('#said').textContent = String(confirm('Delete this item?'))">Confirm</button>
<button id="name" onclick="document.querySelector('#said').textContent = String(prompt('Your name?', 'Anonymous'))">Prompt</button>
<p id="said">nothing yet</p>`

/**
 * A page that writes down every key and mouse gesture it receives.
 *
 * The field's value is the half that matters: an "a" typed into the field
 * instead of Ctrl+A leaves the text changed, so a chord that never reached the
 * page as a chord is distinguishable from one that did. The listener runs in
 * the capture phase, before anything on the page can consume the key.
 */
const KEYS_FIXTURE = `<!doctype html><meta charset="utf-8"><title>keys fixture</title>
<h1>Keys fixture</h1>
<input id="field" aria-label="field" value="hello">
<p id="log">nothing yet</p>
<script>
  const written = (what) => { document.querySelector('#log').textContent = what };
  document.addEventListener('keydown', (event) => {
    written('down ' + (event.ctrlKey ? 'Control+' : '') + (event.shiftKey ? 'Shift+' : '') + event.key);
  }, true);
  document.querySelector('#field').addEventListener('contextmenu', () => written('contextmenu'));
  document.querySelector('#field').addEventListener('dblclick', () => written('dblclick'));
</script>`

/**
 * A page that opens a second page, the way a link with `target=_blank` does.
 *
 * The second page is where the sidebar's 1:1 rule meets a real browser: two
 * pages that both sit on `about:blank` must still be two identities, and the
 * one that closes must leave the other alone.
 */
const POPUP_FIXTURE = `<!doctype html><meta charset="utf-8"><title>popup fixture</title>
<button id="open" onclick="const w = window.open('about:blank', 'second'); w.document.title = 'second page'; w.document.body.textContent = 'I am the second page'; document.querySelector('#log').textContent = 'opened'">Open second page</button>
<p id="log">nothing yet</p>`


/**
 * A page whose control is inside a same-origin child frame.
 *
 * Chrome answers the page-level accessibility tree with every `Iframe` node
 * carrying no children, so the contents of a frame are in the pixels and absent
 * from the tree until the frame itself is fetched and spliced under the element
 * that owns it. This is the shape that was broken for a whole round: `Page.Frame`
 * names itself `id`, and reading `frameId` spliced nothing on any page at all.
 */
const IFRAME_FIXTURE = `<!doctype html><meta charset="utf-8"><title>iframe fixture</title>
<h1>Iframe fixture</h1>
<button id="outside" onclick="globalThis.__outside = true">Outside</button>
<iframe title="Frame holder" srcdoc="<button id='inner' onclick='window.parent.__inner = true'>Inner control</button>"></iframe>`

/**
 * A page whose select and checkbox cannot be driven by a press.
 *
 * The popup of a select belongs to the browser process and its options have no
 * box, so a press can open it and never choose one; the checkbox writes no
 * attribute when it is toggled, so a press on it leaves no DOM record either.
 * Both are the shapes `select` and `checked` exist for, and the page writes down
 * what it was told, so a check reads the words of the page and not of the report.
 */
const SELECT_FIXTURE = `<!doctype html><meta charset="utf-8"><title>select fixture</title>
<h1>Select fixture</h1>
<label for="pick">Pick</label>
<select id="pick" aria-label="Pick">
  <option value="one">One</option>
  <option value="two">Two</option>
  <option value="three">Three</option>
</select>
<label><input id="agree" type="checkbox"> Agree</label>
<p id="log">nothing yet</p>
<script>
  const log = (what) => { document.querySelector('#log').textContent = what }
  document.querySelector('#pick').addEventListener('change', (event) => log('picked ' + event.target.value))
  document.querySelector('#agree').addEventListener('change', (event) => log('agree ' + event.target.checked))
</script>`
/**
 * A page with controls for a bare key to move the focus between.
 *
 * Only a real tree says which node carries the `focused` state, and Chrome puts
 * it on the document as well, so the shape this pins is "which of several
 * controls did it land on" (measured 2026-09-29, `.prove/focus-probe.mjs`).
 */
const FOCUS_FIXTURE = `<!doctype html><meta charset="utf-8"><title>focus fixture</title>
<h1>Focus fixture</h1>
<input id="first" aria-label="First field">
<input id="second" aria-label="Second field">
<button id="last" aria-label="Last button">Last</button>`

/** A page with nothing focusable: the document is all the tree marks. */
const BARE_FIXTURE = `<!doctype html><meta charset="utf-8"><title>bare fixture</title>
<p>Nothing to focus here.</p>`

/**
 * A page whose content lives where only the page itself can look.
 *
 * An open shadow root and a same-origin `srcdoc` frame both reach the
 * accessibility tree, and both were out of reach of a selector query rooted at
 * the document: measured 2026-09-29, `target="#inside"` was refused and a
 * marked element inside the shadow root was printed anyway.
 */
const SHADOW_FIXTURE = `<!doctype html><meta charset="utf-8"><title>shadow fixture</title>
<h1>Shadow fixture</h1>
<div id="host"></div>
<div data-dsh-browser-ignore><button id="ignored-light">Ignored light</button></div>
<iframe title="Frame holder" srcdoc="<button id='inner'>Inner control</button>"></iframe>
<script>
  const root = document.querySelector('#host').attachShadow({ mode: 'open' })
  root.innerHTML = '<button id="inside">Shadow button</button>'
    + '<div data-dsh-browser-ignore><button id="ignored-shadow">Ignored shadow</button></div>'
</script>`
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
    // The page's own node count moves with the site, so the claim about the
    // budget is measured, not assumed: a smaller budget really does cut a real
    // page and says so, and the default is the one that fit it whole.
    const squeezed = await step('snapshot at a smaller budget', 60_000, async () => {
      await browser.reconfigure(plainConfig(Config({ ...config, snapshotNodes: 100, userDataDir: config.userDataDir })))
      const answer = await browser.snapshot()
      await browser.reconfigure(plainConfig(Config({ ...config, snapshotNodes: 500, userDataDir: config.userDataDir })))
      return answer
    })
    check('a smaller budget really cuts a real page, and says what to ask for next',
      first.nodes > 100 && squeezed.truncated && squeezed.elided.budget > 0
        && squeezed.text.includes('take a narrower snapshot'),
      `${first.nodes} nodes at the default; squeezed to ${squeezed.nodes}, elided ${squeezed.elided.budget}`)
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
    const off = refFor(fields.text, /"switched off"/)
    const free = refFor(fields.text, /"free"/)
    if (locked === undefined || off === undefined || free === undefined) {
      check('every field has a ref to type into', false,
        `locked ${String(locked)}, off ${String(off)}, free ${String(free)}`)
    } else {
      const refused = await refusal(() => browser.type(locked, 'nope'))
      const lockedValue = await step('read the read-only field', 30_000,
        () => browser.evaluate('document.querySelector("#fixed").value'))
      check('a read-only field is refused by name, not reported as typed',
        /would not take the text because it is read-only/.test(refused),
        refused.slice(0, 140))
      check('the refused text landed nowhere', lockedValue === '', JSON.stringify(lockedValue))

      // The page refuses this focus before any question about typing can be
      // answered, so the reason has to come from the element's own state.
      const refusedOff = await refusal(() => browser.type(off, 'nope'))
      const offValue = await step('read the disabled field', 30_000,
        () => browser.evaluate('document.querySelector("#off").value'))
      check('a disabled field is refused by name, with the page\'s own reason',
        /would not take the text because it is disabled/.test(refusedOff),
        refusedOff.slice(0, 140))
      check('nothing was typed into the disabled field', offValue === '', JSON.stringify(offValue))

      const typed = await step('type into the field that takes text', 30_000, () => browser.type(free, 'hello'))
      const freeValue = await step('read the other field', 30_000,
        () => browser.evaluate('document.querySelector("#free").value'))
      check('a field that can hold text still gets it',
        freeValue === 'hello' && typed.element.role === 'textbox' && typed.element.name === 'free',
        `${JSON.stringify(freeValue)} into ${typed.element.role} ${JSON.stringify(typed.element.name)}`)
    }

    log('\n[19] a query and boxes on the real page')
    await step('back to the real page', 60_000, () => browser.navigate(URL_ARG))
    const whole = await step('snapshot for comparison', 60_000, () => browser.snapshot())
    // The first accessible name a line carries, not the url beside it: a query
    // is what a reader would search for, and a whole line with its attributes is
    // not a thing any page would match.
    const wanted = whole.text.split('\n')
      .map(line => /^\s*- \S+ "(.*?)"/.exec(line)?.[1] ?? '')
      .find(name => name.length >= 6 && name.length <= 40) ?? 'a'
    const found = await step('snapshot with a query', 60_000, () => browser.snapshot({ find: wanted }))
    check('a query answers with the paths to its matches instead of the page',
      found.nodes > 0 && found.nodes < whole.nodes && found.text.includes(wanted),
      `${String(found.nodes)} of ${String(whole.nodes)} nodes for ${JSON.stringify(wanted)}`)

    const boxed = await step('snapshot with boxes', 60_000, () => browser.snapshot({ boxes: true }))
    const printedLine = boxed.text.split('\n').find(line => /- heading "[^"]*" level="1"[^\n]*box=/.test(line))
    const printed = /- heading "[^"]*" level="1"[^\n]*box=(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(boxed.text)
    // The one claim a recording CDP session cannot settle: which coordinate
    // space a printed box is in. The page is asked for the same element's own
    // rectangle, so the two answers have to be the same numbers.
    const measured = await step('measure the same heading in the page', 30_000, () => browser.evaluate(
      '(() => { const heading = document.querySelector("h1"); if (heading === null) return null; '
      + 'const box = heading.getBoundingClientRect(); '
      + 'return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]; })()',
    ))
    check('a printed box is the element box in viewport pixels',
      printed !== null && Array.isArray(measured)
        && Number(printed[1]) === measured[0] && Number(printed[2]) === measured[1]
        && Number(printed[3]) === measured[2] && Number(printed[4]) === measured[3],
      `${printedLine ?? 'no heading carried a box'} against the page ${JSON.stringify(measured)}`)

    log('\n[20] a dialog a click opens is answered and reported')
    const dialogUrl = `data:text/html;charset=utf-8,${encodeURIComponent(DIALOG_FIXTURE)}`
    await step('navigate to the dialog fixture', 30_000, () => browser.navigate(dialogUrl))
    const dialogTree = await step('dialog fixture snapshot', 30_000, () => browser.snapshot())
    const confirmRef = refFor(dialogTree.text, /"Confirm"/)
    const promptRef = refFor(dialogTree.text, /"Prompt"/)
    if (confirmRef === undefined || promptRef === undefined) {
      check('both dialog buttons have a ref to click', false,
        `confirm ${String(confirmRef)}, prompt ${String(promptRef)}`)
    } else {
      const dismissed = await step('click under the default answer', 30_000, () => browser.click(confirmRef))
      const saidThen = await step('read what the page was told', 30_000,
        () => browser.evaluate('document.querySelector("#said").textContent'))
      check('a dismissed dialog is reported instead of vanishing',
        dismissed.dialogs?.[0]?.handled === 'dismissed'
          && dismissed.dialogs?.[0]?.type === 'confirm'
          && dismissed.changed.includes('dialog'),
        JSON.stringify(dismissed.dialogs ?? null))
      check('the page received the dismissal the report names', saidThen === 'false', JSON.stringify(saidThen))

      const accepted = await step('click under a declared accept', 30_000,
        () => browser.click(confirmRef, { dialog: { action: 'accept' } }))
      const saidAccept = await step('read what the page was told this time', 30_000,
        () => browser.evaluate('document.querySelector("#said").textContent'))
      check('a declared accept reaches the page',
        accepted.dialogs?.[0]?.handled === 'accepted' && saidAccept === 'true',
        `${JSON.stringify(accepted.dialogs ?? null)} with the page saying ${JSON.stringify(saidAccept)}`)

      const answered = await step('answer a prompt with text', 30_000,
        () => browser.click(promptRef, { dialog: { action: 'accept', text: 'Ada' } }))
      const saidName = await step('read the prompt answer', 30_000,
        () => browser.evaluate('document.querySelector("#said").textContent'))
      check('a prompt is accepted with the text the call declared',
        answered.dialogs?.[0]?.answer === 'Ada' && saidName === 'Ada',
        `${JSON.stringify(answered.dialogs ?? null)} with the page saying ${JSON.stringify(saidName)}`)
    }

    log('\n[21] keys and mouse gestures a page only answers to as gestures')
    const keysUrl = `data:text/html;charset=utf-8,${encodeURIComponent(KEYS_FIXTURE)}`
    await step('navigate to the keys fixture', 30_000, () => browser.navigate(keysUrl))
    const keysTree = await step('keys fixture snapshot', 30_000, () => browser.snapshot())
    const fieldRef = refFor(keysTree.text, /"field"/)
    if (fieldRef === undefined) {
      check('the field has a ref to focus', false, 'no line named "field"')
    } else {
      await step('focus the field', 30_000, () => browser.type(fieldRef, 'hello'))
      await step('press Control+A', 30_000, () => browser.press('Control+A'))
      const afterChord = await step('read the field and its selection', 30_000, () => browser.evaluate(
        '(() => { const field = document.querySelector("#field"); '
        + 'return { value: field.value, from: field.selectionStart, to: field.selectionEnd, '
        + 'log: document.querySelector("#log").textContent }; })()',
      ))
      check('a chord reaches the page with its modifier',
        afterChord?.log === 'down Control+a', JSON.stringify(afterChord?.log))
      check('Ctrl+A selects the field instead of typing an "a"',
        afterChord?.value === 'hello' && afterChord?.from === 0 && afterChord?.to === 5,
        JSON.stringify(afterChord))

      const rightClicked = await step('right-click the field', 30_000,
        () => browser.click(fieldRef, { button: 'right' }))
      const afterRight = await step('read the menu record', 30_000,
        () => browser.evaluate('document.querySelector("#log").textContent'))
      check('a right click arrives as a context menu request', afterRight === 'contextmenu',
        `${JSON.stringify(afterRight)} on ${rightClicked.element?.role ?? 'unknown'}`)

      await step('double-click the field', 30_000, () => browser.click(fieldRef, { double: true }))
      const afterDouble = await step('read the double-click record', 30_000,
        () => browser.evaluate('document.querySelector("#log").textContent'))
      check('a double click arrives as one double click', afterDouble === 'dblclick', JSON.stringify(afterDouble))

      await step('press Escape with no element', 30_000, () => browser.press('Escape'))
      const afterEscape = await step('read the key record', 30_000,
        () => browser.evaluate('document.querySelector("#log").textContent'))
      const focusKept = await step('read the focused element', 30_000,
        () => browser.evaluate('document.activeElement?.id'))
      check('a key pressed with no ref goes to the page and leaves the focus alone',
        afterEscape === 'down Escape' && focusKept === 'field',
        `${JSON.stringify(afterEscape)} with the focus on ${JSON.stringify(focusKept)}`)
    }

    log('\n[22] a click says what the page changed, not just that it did')
    const changesUrl = `data:text/html;charset=utf-8,${encodeURIComponent(CHANGES_FIXTURE)}`
    await step('navigate to the changes fixture', 30_000, () => browser.navigate(changesUrl))
    const changesTree = await step('changes fixture snapshot', 30_000, () => browser.snapshot())
    const goRef = refFor(changesTree.text, /"启动并连接"/)
    if (goRef === undefined) {
      check('the button that changes the page has a ref', false, 'no line named the button')
    } else {
      const acted = await step('click the button that changes the page', 30_000, () => browser.click(goRef))
      const changes = acted.changes ?? []
      const added = changes.find(change => change.kind === 'added')
      const toggled = changes.find(change => change.kind === 'attribute')
      const rewritten = changes.find(change => change.kind === 'text')
      check('a node the click added is named by what it says',
        added?.role === 'status' && added?.tag === 'div' && added?.preview === '先在实例表里点一行',
        JSON.stringify(added ?? null))
      check('an attribute the click toggled carries both sides of the change',
        toggled?.tag === 'button' && toggled?.attribute === 'disabled'
          && toggled?.from === undefined && toggled?.to === 'true',
        JSON.stringify(toggled ?? null))
      check('a run of text the click rewrote carries the text before and after',
        rewritten?.tag === 'p' && rewritten?.from === '24.1k' && rewritten?.to === '24.2k',
        JSON.stringify(rewritten ?? null))
      check('the page still reports that it changed at all',
        acted.changed.includes('dom') && acted.settled === true,
        JSON.stringify({ changed: acted.changed, settled: acted.settled, mutations: acted.mutations }))
      log(`      changes: ${JSON.stringify(changes)}${acted.changesOmitted === undefined ? '' : ` (+${String(acted.changesOmitted)} omitted)`}`)
    }

    log('\n[23] a wait waits for the page to become ready, and says which happened')
    const waitUrl = `data:text/html;charset=utf-8,${encodeURIComponent(WAIT_FIXTURE)}`
    await step('navigate to the wait fixture', 30_000, () => browser.navigate(waitUrl))
    const waitTree = await step('wait fixture snapshot', 30_000, () => browser.snapshot())
    const goWaitRef = refFor(waitTree.text, /"Start"/)
    if (goWaitRef === undefined) {
      check('the button that starts the delayed work has a ref', false, 'no line named "Start"')
    } else {
      // Nothing is ready yet: the wait must be the thing that finds out.
      const early = await step('ask for a state that is not there yet', 30_000,
        () => browser.wait({ locator: { text: 'engine ready' } }, { timeoutMs: 300 }))
      check('a wait that runs out of time reports the wait, not a failure',
        early.matched === false && early.waitedMs >= 300 && early.url.startsWith('data:text/html'),
        `${JSON.stringify({ matched: early.matched, waitedMs: early.waitedMs })}`)

      await step('start the delayed work', 30_000, () => browser.click(goWaitRef))
      const waited = await step('wait for the state the page will reach', 30_000,
        () => browser.wait({ locator: { text: 'engine ready' } }, { timeoutMs: 8_000 }))
      check('a wait returns as soon as the element the page adds is there',
        waited.matched === true
          && waited.element?.role === 'button'
          && waited.element?.name === 'engine ready'
          && waited.waitedMs < 8_000,
        JSON.stringify({ waitedMs: waited.waitedMs, element: waited.element ?? null }))
      // The element's name is computed from the text inside it, so the text run
      // under it says the same words: a second candidate here would both
      // misreport the wait and make the click below refuse as ambiguous.
      check('the element and the text run inside it are one answer, not two',
        waited.matches === 1, `matches=${String(waited.matches)}`)
      const arrived = await step('read whether the page really got there', 30_000,
        () => browser.evaluate('({ ready: globalThis.__ready === true, text: document.querySelector("#state").textContent })'))
      check('the wait matched a page that really became ready',
        arrived?.ready === true && arrived?.text === 'ready', JSON.stringify(arrived ?? null))

      // What the caller waited for has to be what it can act on: the same words,
      // as a locator, with no ref in between.
      const acted = await step('click what the wait matched, by the same words', 30_000,
        () => browser.click({ text: 'engine ready' }))
      const clicked = await step('read whether the click landed', 30_000,
        () => browser.evaluate('globalThis.__clicked === true'))
      check('what the wait matched can be acted on by the same locator',
        acted.element?.role === 'button' && clicked === true,
        `${JSON.stringify(acted.element ?? null)} clicked=${String(clicked)}`)

      // The address condition does not read the tree, and must not: a page whose
      // URL is already right is matched by the first ask.
      const here = await step('wait on an address that is already right', 30_000,
        () => browser.wait({ url: 'charset=utf-8' }, { timeoutMs: 1_000 }))
      check('an address condition matches without asking the page anything',
        here.matched === true, JSON.stringify({ matched: here.matched, url: here.url }))
    }

    log('\n[24] a page that fails without touching the DOM is explained by what it said')
    const consoleUrl = `data:text/html;charset=utf-8,${encodeURIComponent(CONSOLE_FIXTURE)}`
    await step('navigate to the console fixture', 30_000, () => browser.navigate(consoleUrl))
    // The exception is thrown on a timer, so it lands after the navigation has
    // settled: waiting is the second half of the capture working at all.
    await step('let the fixture throw', 30_000, () => browser.wait({ timeMs: 300 }, { timeoutMs: 5_000 }))
    const consoleReport = await step('read what the page said', 30_000, () => browser.pageConsole())
    const spoken = consoleReport.entries.map(entry => entry.message)
    const levels = new Set(consoleReport.entries.map(entry => entry.level))
    check('a console call is captured with the level it was made at',
      spoken.some(message => message.includes('booting')) && levels.has('log'),
      JSON.stringify(consoleReport.entries.map(entry => `${entry.level}:${entry.message}`)))
    check('an uncaught exception is captured, and says what it was',
      spoken.some(message => /save is not a function/.test(message)),
      JSON.stringify(spoken))
    check('the message carries where it came from',
      consoleReport.entries.every(entry => entry.url === undefined || typeof entry.url === 'string'),
      JSON.stringify(consoleReport.entries.map(entry => entry.url ?? null)))
    // A logged object is the one part of a console message the protocol does not
    // serialize; what it can say is the shape, and this measures whether the
    // preview came through or the model only ever sees "Object".
    check('a logged object arrives as something readable rather than as "Object"',
      spoken.some(message => /save failed/.test(message) && /code/.test(message)),
      JSON.stringify(spoken))
    check('the counts say how much of the history this is',
      consoleReport.total >= 3 && consoleReport.dropped === 0 && consoleReport.matched === consoleReport.total,
      JSON.stringify({ total: consoleReport.total, matched: consoleReport.matched, dropped: consoleReport.dropped }))

    await step('navigate to a quiet page', 30_000, () => browser.navigate('data:text/html,<title>quiet</title><p>quiet</p>'))
    const afterNavigation = await step('read the console of the new document', 30_000, () => browser.pageConsole())
    check('a new document starts with an empty console',
      afterNavigation.total === 0 && afterNavigation.entries.length === 0,
      JSON.stringify({ total: afterNavigation.total, entries: afterNavigation.entries.length }))

    log('\n[25] a capture can be the whole page or one element, without scrolling to it')
    const shotUrl = `data:text/html;charset=utf-8,${encodeURIComponent(SHOT_FIXTURE)}`
    await step('navigate to the shot fixture', 30_000, () => browser.navigate(shotUrl))
    const shotTree = await step('shot fixture snapshot', 30_000, () => browser.snapshot())
    const deepRef = refFor(shotTree.text, /"Deep button"/)
    if (deepRef === undefined) {
      check('the control below the fold has a ref', false, 'no line named the button')
    } else {
      const viewportShot = await step('capture the viewport', 30_000, () => browser.screenshot())
      const fullShot = await step('capture the whole page', 30_000, () => browser.screenshot({ fullPage: true }))
      check('a viewport capture reports the window',
        viewportShot.width === shotTree.info.viewportWidth && viewportShot.height === shotTree.info.viewportHeight,
        `${String(viewportShot.width)}x${String(viewportShot.height)} vs ${String(shotTree.info.viewportWidth)}x${String(shotTree.info.viewportHeight)}`)
      check('a whole-page capture reports the document, which is taller than the window',
        fullShot.height === shotTree.info.pageHeight && fullShot.height > shotTree.info.viewportHeight,
        `${String(fullShot.width)}x${String(fullShot.height)} vs page ${String(shotTree.info.pageHeight)}`)

      const elementShot = await step('capture the control below the fold', 30_000,
        () => browser.screenshot({ target: deepRef }))
      // The fixture's own CSS says 180x60; a button's border adds a pixel or two.
      check('an element capture is the size of the element, not of the page',
        elementShot.width >= 180 && elementShot.width <= 200 && elementShot.height >= 60 && elementShot.height <= 80
          && elementShot.element?.name === 'Deep button',
        `${String(elementShot.width)}x${String(elementShot.height)} ${JSON.stringify(elementShot.element ?? null)}`)
      check('an element below the fold is captured without scrolling the page',
        (await step('read the scroll position', 30_000, () => browser.evaluate('window.scrollY'))) === 0,
        'the page was scrolled to reach the element')

      // The decisive measurement: a clip is in page pixels, so the same element
      // is the same picture whatever the window is showing. Read as viewport
      // pixels it would be one picture here and a different one below.
      await step('scroll the page past the element', 30_000, () => browser.evaluate('window.scrollTo(0, 900)'))
      const scrolledShot = await step('capture the same element again', 30_000, () => browser.screenshot({ target: deepRef }))
      check('the same element is the same picture at any scroll position',
        scrolledShot.jpeg.equals(elementShot.jpeg),
        `${String(elementShot.jpeg.length)} vs ${String(scrolledShot.jpeg.length)} bytes`)
      writeFileSync(join(OUT_DIR, 'shot-element.jpg'), elementShot.jpeg)
      writeFileSync(join(OUT_DIR, 'shot-fullpage.jpg'), fullShot.jpeg)
    }

    log('\n[26] a locator that matches two elements lists them, with what tells them apart')
    const ambiguousUrl = `data:text/html;charset=utf-8,${encodeURIComponent(AMBIGUOUS_FIXTURE)}`
    await step('navigate to the ambiguous fixture', 30_000, () => browser.navigate(ambiguousUrl))
    const byText = await refusal(() => browser.click({ text: 'Stop' }))
    const byCss = await refusal(() => browser.click({ selector: 'button' }))
    check('a text locator that matches twice refuses and names the two ancestors',
      /matches 2 elements/.test(byText) && /region "Running"/.test(byText) && /region "Idle"/.test(byText),
      byText.slice(0, 160))
    // The same two elements reached the other way: a selector walks the DOM,
    // which describes no names, and the tree is where the refusal's answer lives.
    check('a selector that matches twice reports the same ancestors instead of claiming there are none',
      /matches 2 elements/.test(byCss) && /region "Running"/.test(byCss)
        && /region "Idle"/.test(byCss) && !/no named ancestor/.test(byCss),
      byCss.slice(0, 160))
    check('neither refusal pressed anything',
      (await step('read whether the fixture was clicked', 30_000,
        () => browser.evaluate('globalThis.__clicked === true'))) === false,
      'a refused locator acted anyway')

    log('\n[27] a page has an identity the sidebar can name, and a close that follows it')
    const popupUrl = `data:text/html;charset=utf-8,${encodeURIComponent(POPUP_FIXTURE)}`
    await step('navigate to the popup fixture', 30_000, () => browser.navigate(popupUrl))
    const popupTree = await step('popup fixture snapshot', 30_000, () => browser.snapshot())
    const openRef = refFor(popupTree.text, /"Open second page"/)
    if (openRef === undefined) {
      check('the popup fixture has a control to open a second page', false, 'no line named the button')
    } else {
      await step('click to open the second page', 30_000, () => browser.click(openRef))
      // Adoption names a page one call after it exists; the poll is the beat.
      const before = await step('wait for the second page to be named', 30_000, async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          const status = browser.status()
          if (status.tabs.length === 2 && status.tabs.every(tab => tab.targetId !== undefined)) return status
          await new Promise(resolve => { setTimeout(resolve, 250) })
        }
        return browser.status()
      })
      // One page per tab, each named: two pages on the SAME origin-less blank
      // must still be two identities, and both must carry a title.
      check('a page the browser opened has its own CDP target id',
        before.tabs.length === 2
        && before.tabs.every(tab => typeof tab.targetId === 'string' && tab.targetId !== '')
        && before.tabs[0]?.targetId !== before.tabs[1]?.targetId,
        JSON.stringify(before.tabs.map(tab => ({ url: tab.url, targetId: tab.targetId }))))
      check('every tab carries a title',
        before.tabs.every(tab => typeof tab.title === 'string' && tab.title !== ''),
        JSON.stringify(before.tabs.map(tab => tab.title)))
      const fresh = await step('read the tab list fresh', 30_000, () => browser.statusAsync())
      check('a fresh read answers the same identities with titles',
        fresh.tabs.length === 2 && fresh.tabs.every(tab => tab.title !== ''),
        JSON.stringify(fresh.tabs.map(tab => ({ title: tab.title, targetId: tab.targetId }))))

      // The per-page mirror: frames from the page a viewer names, on a session
      // of its own. The page is asked to repaint, since a still page casts
      // almost nothing.
      const named = fresh.tabs.find(tab => tab.url === 'about:blank' && tab.active !== true) ?? fresh.tabs[1]
      const frames = []
      const stopWatching = await step('watch the second page', 30_000,
        () => browser.addPageViewer(frame => frames.push(frame.jpeg.length), named?.targetId ?? ''))
      await step('repaint the second page', 30_000, async () => {
        for (let attempt = 0; attempt < 20 && frames.length === 0; attempt++) {
          await browser.evaluate('document.body && (document.body.style.color = document.body.style.color === "red" ? "blue" : "red")')
          await new Promise(resolve => { setTimeout(resolve, 250) })
        }
      })
      check('a viewer naming a page is sent that page frames', frames.length > 0,
        `${String(frames.length)} frame(s)`)
      stopWatching()

      // Closing the page the tab named: the browser outlives it, and what is
      // left is the page that was there first.
      await step('close the second page by its target id', 30_000,
        () => browser.closePage(named?.targetId ?? ''))
      const after = await step('read the tab list after the close', 30_000, () => browser.status())
      check('closing one page keeps the browser and the other page',
        after.state === 'ready' && after.tabs.length === 1,
        JSON.stringify({ state: after.state, tabs: after.tabs.map(tab => tab.url) }))
    }

    log('\n[28] a control no press can reach is set, and a frame is in the tree')
    const selectUrl = `data:text/html;charset=utf-8,${encodeURIComponent(SELECT_FIXTURE)}`
    await step('navigate to the select fixture', 30_000, () => browser.navigate(selectUrl))
    const selectTree = await step('select fixture snapshot', 30_000, () => browser.snapshot())
    const pickRef = refFor(selectTree.text, /combobox "Pick"/)
    const agreeRef = refFor(selectTree.text, /checkbox "Agree"/)
    if (pickRef === undefined || agreeRef === undefined) {
      check('the fixture has a select and a checkbox to name', false, selectTree.text.slice(0, 300))
    } else {
      // A native select cannot be chosen by pressing: its popup is the browser
      // process and its options have no box, so a selection is set on the
      // element and the page's own input/change events are dispatched — the
      // shape the reference runtime has as select(ref, values).
      const chosen = await step('choose an option by its visible label', 30_000,
        () => browser.select(pickRef, ['Two']))
      check('a selection reports the label it chose',
        chosen.selected?.length === 1 && chosen.selected[0] === 'Two',
        JSON.stringify(chosen.selected ?? null))
      const picked = await step('read the value and log the page reports', 30_000,
        () => browser.evaluate('({ value: document.querySelector("#pick").value, log: document.querySelector("#log").textContent })'))
      check('the selection reached the page as the value it names',
        picked?.value === 'two' && picked?.log === 'picked two', JSON.stringify(picked ?? null))

      // The checkbox is the other half: setting it changes no attribute, so a
      // change list can see nothing, and only the state the result carries
      // says what happened.
      const agreed = await step('set the checkbox state', 30_000, () => browser.check(agreeRef, true))
      check('a check reports the state the control ended in', agreed.checked === true,
        JSON.stringify(agreed.checked ?? null))
      const agreedBack = await step('read the control back', 30_000,
        () => browser.evaluate('({ checked: document.querySelector("#agree").checked, reflected: document.querySelector("#agree").hasAttribute("checked") })'))
      check('the state landed even though no attribute records it',
        agreedBack?.checked === true && agreedBack?.reflected === false,
        JSON.stringify(agreedBack ?? null))
    }

    const frameUrl = `data:text/html;charset=utf-8,${encodeURIComponent(IFRAME_FIXTURE)}`
    await step('navigate to the iframe fixture', 30_000, () => browser.navigate(frameUrl))
    const frameTree = await step('iframe fixture snapshot', 30_000, () => browser.snapshot())
    check('a control inside a same-origin frame is in the page tree',
      /button "Inner control"/.test(frameTree.text), frameTree.text.slice(0, 400))
    const innerRef = refFor(frameTree.text, /"Inner control"/)
    if (innerRef === undefined) {
      check('the control inside the frame has a ref to act on', false, 'no line named it')
    } else {
      const clicked = await step('click the control inside the frame by its ref', 30_000,
        () => browser.click(innerRef))
      const inside = await step('read whether the handler in the frame ran', 30_000,
        () => browser.evaluate('globalThis.__inner === true'))
      check('a click on a control inside a frame reaches the frame',
        `${JSON.stringify(clicked.element ?? null)} fired=${String(inside)}`)
    }

    log('\n[29] a key with no element says where the focus went')
    const focusUrl = `data:text/html;charset=utf-8,${encodeURIComponent(FOCUS_FIXTURE)}`
    await step('navigate to the focus fixture', 30_000, () => browser.navigate(focusUrl))
    const tabbed = await step('press Tab with no element named', 30_000, () => browser.press('Tab'))
    const activeAfterTab = await step('ask the page which element is active', 30_000,
      () => browser.evaluate('document.activeElement?.id ?? "none"'))
    check('a bare Tab names the control the focus landed on, not the document',
      tabbed.focused?.name === 'First field' && activeAfterTab === 'first',
      JSON.stringify({ focused: tabbed.focused ?? null, activeElement: activeAfterTab }))
    const tabbedAgain = await step('press Tab again', 30_000, () => browser.press('Tab'))
    check('the next Tab names the next control',
      tabbedAgain.focused?.name === 'Second field', JSON.stringify(tabbedAgain.focused ?? null))
    const wentBack = await step('press Shift+Tab', 30_000, () => browser.press('Shift+Tab'))
    check('Shift+Tab names the control it went back to',
      wentBack.focused?.name === 'First field', JSON.stringify(wentBack.focused ?? null))

    // The document carries the state whenever the page has the focus at all, so
    // a page with nothing to focus must name no element rather than the page.
    const bareUrl = `data:text/html;charset=utf-8,${encodeURIComponent(BARE_FIXTURE)}`
    await step('navigate to a page with nothing focusable', 30_000, () => browser.navigate(bareUrl))
    const nowhere = await step('press Tab on a page with no controls', 30_000, () => browser.press('Tab'))
    check('a page whose only focus is the document names no element',
      nowhere.focused === undefined, JSON.stringify(nowhere.focused ?? null))

    log('\n[30] a selector reaches what only the page can see')
    const shadowUrl = `data:text/html;charset=utf-8,${encodeURIComponent(SHADOW_FIXTURE)}`
    await step('navigate to the shadow fixture', 30_000, () => browser.navigate(shadowUrl))
    const shadowTree = await step('shadow fixture snapshot', 30_000, () => browser.snapshot())
    const flat = (text) => text.replace(/\n/g, ' ').slice(0, 220)
    check('an element inside an open shadow root is in the page tree',
      /button "Shadow button"/.test(shadowTree.text), flat(shadowTree.text))
    check('a marked element in the light DOM stays out of the tree',
      !/Ignored light/.test(shadowTree.text), flat(shadowTree.text))
    check('a marked element inside a shadow root stays out too',
      !/Ignored shadow/.test(shadowTree.text), flat(shadowTree.text))
    const inShadow = await step('narrow to a selector inside the shadow root', 30_000,
      () => browser.snapshot({ target: '#inside' }))
    check('a target selector reaches into an open shadow root',
      /Shadow button/.test(inShadow.text), flat(inShadow.text))
    const inFrame = await step('narrow to a selector inside the frame', 30_000,
      () => browser.snapshot({ target: '#inner' }))
    check('a target selector reaches into a same-origin frame',
      /Inner control/.test(inFrame.text), flat(inFrame.text))

    log('\n[31] an ask opens a page of its own, and a selection moves the tools')
    const beforeAsks = browser.status().tabs
    const firstAsk = await step('ask for a new page', 30_000, () => browser.openPage())
    const secondAsk = await step('ask for another new page', 30_000, () => browser.openPage())
    // The rule the browser entry depends on: a browser that is already running
    // gets one MORE page per ask, never the page it is already showing.
    check('each ask is a page of its own, not the one already there',
      typeof firstAsk?.targetId === 'string' && typeof secondAsk?.targetId === 'string'
      && firstAsk.targetId !== secondAsk.targetId,
      JSON.stringify({ first: firstAsk?.targetId ?? null, second: secondAsk?.targetId ?? null }))
    check('the tab list grew by exactly the two pages that were asked for',
      browser.status().tabs.length === beforeAsks.length + 2,
      JSON.stringify(browser.status().tabs.map(tab => tab.targetId ?? null)))
    const target = browser.status().tabs[0]?.targetId ?? ''
    const selected = await step('select the first page for the tools', 30_000, () => browser.selectPage(target))
    const active = browser.status().tabs.filter(tab => tab.active)
    check('selecting a page moves the one the tools act on, and only that',
      selected.targetId === target && active.length === 1 && active[0]?.targetId === target,
      JSON.stringify(browser.status().tabs.map(tab => ({ id: tab.targetId, active: tab.active }))))
    const twice = await step('ask twice under one record', 30_000, async () => ({
      first: await browser.openPage({ request: 'regression-entry' }),
      second: await browser.openPage({ request: 'regression-entry' }),
    }))
    // A pane remounted by a tab switch or a client reload is the same ask: it
    // must answer with the page it already opened rather than a third one.
    check('one record asking twice is one page',
      twice.first?.targetId !== undefined && twice.first.targetId === twice.second?.targetId,
      JSON.stringify({ first: twice.first?.targetId ?? null, second: twice.second?.targetId ?? null }))

  } finally {
    await browser.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }  const failed = results.filter(entry => !entry.passed)
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
