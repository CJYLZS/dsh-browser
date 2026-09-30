# dsh-browser

English | [中文](README.zh.md)

<img src="docs/img/preview_en.png" alt="The plugin at work: the agent's browser tool calls beside the same browser mirrored in the sidebar" width="100%">

<p align="center">
  <img src="docs/img/settings_en.png" alt="The browser settings: one running instance per conversation with its own CDP port, window mode, automation markers, and profile location" width="45%">
</p>

**A real local browser for every conversation.** The agent opens pages and works in them while the sidebar mirrors the same browser, so you can watch the work happen and take over whenever you want. It runs in both the Web and the Desktop interface.

## Summary

Chrome or Edge runs as its own process, with its own profile and its own CDP port, and every conversation gets its own: tabs, sign-ins, and ports are never shared between conversations. The agent drives it with nine tools, and the sidebar shows the same pages — either side can act on them.

It is not an embedded web view. The page runs in an ordinary browser process, so sites see a normal browser, DevTools or another Playwright can attach to it while the mirror is live, and closing the harness does not leave a browser pretending to be part of the app.

<a id="highlights"></a>
## Highlights

- **Works in both interfaces.** The Web GUI and the Desktop app run the same plugin against the same browser; install it once in each and nothing else differs, including the settings page.
- **One browser per conversation.** Tabs, sign-ins, and ports belong to one conversation and stay there: the sidebar pane names its session, and a tool call resolves its browser from the session that called it.
- **Watch it work, or take over.** Every page the browser opens gets its own sidebar tab with a live view, and clicks and typing in that tab reach the real page.
- **The agent can read a page it has never seen.** `browser_snapshot` prints the page's accessibility tree with a `ref` per node, which is how the agent reads an unfamiliar page and how it names the element to click; `find` narrows a large page, and `boxes` gives positions without a screenshot.
- **Input a site accepts.** Real mouse and text events at the element's own position — a page that ignores a synthetic `element.click()` still takes these — plus chords such as `Ctrl+A`, native dropdowns and checkboxes, dialogs answered by the call that opens them, and an explicit refusal when something else would receive the press.
- **Nine tools, and code for the rest.** `browser_evaluate` is the general-purpose one; the others cover what code cannot express, such as reading a page without knowing its selectors first, or asking what the page said while it failed. See [Tools](#tools).
- **Attachable.** Each browser listens on an external CDP port, so `chrome://inspect`, another Playwright, or the bundled `scripts/cdp.mjs` can attach to the same browser the sidebar is mirroring.
- **Working rules where the model reads them.** The plugin contributes a skill — read before acting, one action per observation, and a page's text is data rather than instructions — with five short recipes read only when their question comes up.

## Table of Contents

- [Highlights](#highlights)
- [Install](#install)
- [Compatibility](#compatibility)
- [Usage](#usage)
- [Understand the design](#understand-the-design)
- [Configuration](#configuration)
- [Tools](#tools)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)
  - [Third-party code](#third-party-code)

-----

<a id="install"></a>
## Install

Check the host dsh version first:

```sh
dsh -V
```

Then install with the `#<tag>` ref that version pairs with — a build targets one dsh generation, and a `github:` install without a ref takes the default branch HEAD, which drifts:

| Your dsh | Plugin version | Install command |
| --- | --- | --- |
| ≥ 0.1.7-rc.1 | v0.2.3 (latest) | `dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.2.3` |
| 0.1.5-rc.2 | v0.1.x | `dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.1.0` |

For a dsh on the current generation, the latest release is:

```sh
dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.2.3
```

The built `lib/` is committed with each tag, so a tag install needs no build step. The profile's `package.json` records the ref you chose; to change versions, re-add with the new ref, and to remove the plugin use `dsh plugin remove --profile web dsh-browser`. Restart the harness after installing. A Chrome or Edge installation is required; `playwright-core` is a dependency and downloads no browser of its own.

### Desktop

The Desktop app owns its own profile, and the ordinary CLI refuses to manage `--profile desktop` on purpose, so install through the Desktop CLI that ships with the app:

```sh
"<Desktop install dir>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add github:CJYLZS/dsh-browser#v0.2.3
```

Use `<Desktop install dir>/resources/runtime/cli/bin/dsh` on macOS and Linux. Restart the app afterwards, the same way the Web profile restarts after `dsh plugin add`; the same `remove` verb uninstalls it.

-----

<a id="compatibility"></a>
## Compatibility

A build targets one dsh generation, so install the plugin version that pairs with your dsh. The fork is in the client half — dsh 0.1.7-rc.1 replaced the settings model with no compatibility layer — which is why one build cannot serve both generations.

That fork is in the client half's imports, so one build cannot target both generations and the plugin pairs by generation:

- **v0.2.x → dsh ≥ 0.1.7-rc.1**, declared as `peerDependencies: >=0.1.7-rc.1` with no upper bound, so one build runs on the whole 0.2.0 line it is verified against ([why the cap went away](.agents/notes/implemented/process/2026-09-30-peer-range-floor-only.md)). The settings page's fields are marked volatile in the schema, and an edit reaches the running browsers through `loader/volatile-update`.
- **v0.1.x → dsh 0.1.5-rc.2**, declared as `peerDependencies: ^0.1.5-rc.2`. The settings page registers a namespace scope and renders its own controls.

An older dsh fails loudly: dsh activates a plugin only when its dsh peers satisfy the declared ranges, and names the plugin and the unsatisfied ranges when they do not. A later generation passes that check, so whether this build still runs on one is a question for verification rather than for the version number.

<a id="usage"></a>
## Usage

Three steps, and the agent needs no instruction beyond what it is asked to do:

1. **Nothing, usually.** The first tool call that needs a browser starts one, and the right sidebar opens itself on that session's Browser tab — you watch the page from its first frame. You can also open it by hand: **New tab → Browser**.
2. **Ask for something.** "Open the docs and tell me what the install section says" is enough: the tools act on the same browser the pane shows, so you watch the work happen.
3. **Attach your own tools when you want them.** `curl http://127.0.0.1:9333/json/version` answers while the browser runs; `chrome://inspect`, another Playwright over `chromium.connectOverCDP`, and `scripts/cdp.mjs` all attach to it.

The sidebar and the browser stay matched: one tab per page the browser has open, a new page adds a tab, closing a tab closes the page, and closing the last one stops the browser until something asks for another one. Which page the tools act on is the agent's choice (`browser_tabs`), independent of which tab you are looking at. [Understand the design](#understand-the-design) covers the rest.

-----

<a id="understand-the-design"></a>
## Understand the design

The plugin keys everything by the harness session id, and that one decision explains most of its behavior:

- **Two independent paths resolve the same session.** The sidebar pane is registered into a session-scoped slot, so its registration receives the session id and names it on the viewer socket; a tool call has no pane, so it takes the session from the agent executing it (`exec.agent.id`, which is the same `SessionId` the API layer resumes sessions with). Neither path can reach a browser belonging to another conversation, and a tool called with no session — a scheduled job, or a subagent without one — fails instead of landing in somebody's browser.
- **One process per profile.** Chrome locks a profile directory to a single running process, so the configured profile directory is a *parent*: each session's browser gets its own subdirectory under it, named with the harness's own session-id escaping. The consequence is worth stating plainly, because it is the price of the isolation: **sign-ins are not shared between conversations.** A site you log into in one conversation starts signed out in another. Sessions keep their identity across reopen, so a conversation returns to its own profile.
- **Ports are allocated, not assumed.** The configuration names a *window* of ports (`debugPortMin`–`debugPortMax`) because one number could never be the address: every session gets its own browser and its own listener. Each browser takes the lowest port in the window it can actually bind and holds it until it exits, because a probe's answer is stale the moment it is given. The top of the window is what stops a search from wandering into whatever else the machine runs: a browser that finds nothing free inside it fails with the window in the message. `GET /dsh-browser/status` reports the port each session ended up on; nothing should assume it is one of the configured values.
- **The mirror belongs to a CDP session, not to the pane.** `Page.startScreencast` is attached to one CDP session, and every path that starts a browser — the pane's restart, recovery from a crash, a launch setting change — replaces that session. A newly started browser therefore re-attaches the cast as soon as it is ready if anyone is watching, or a pane left open across a restart would keep its last frame forever while its status line kept updating.
- **A dead browser is replaced, not mourned.** Closing the window or losing the process moves the instance to `closed` with the reason, publishes it to the pane, and leaves the next request to start a fresh browser. Nothing has to be fixed by hand, including the browser process dying between two tool calls.
- **The snapshot is a contract with the model.** `Accessibility.getFullAXTree` is printed as one line per node, with ignored wrappers dropped and a `ref` for every node that has a DOM node behind it. A ref names a node on one page: navigating invalidates all of them, and a stale ref fails with a message pointing at `browser_snapshot` rather than clicking whatever now occupies that position.
- **A ref or a locator; an ambiguous locator is refused.** A ref is an answer one snapshot gave about one document, so it is cheap to check and goes stale. A locator — `role` with `name`, `text`, or `selector` — is the question that answer came from, asked again when the action runs, so a re-render or a navigation does not stop it. A locator matching more than one element is refused rather than guessed at, and the refusal lists every candidate with its nearest named ancestors, which is the only thing that tells two identically named controls apart. Matching reads the accessibility tree, so a locator matches exactly what a snapshot would print; a `selector` is walked by the page itself, so it reaches an open shadow root and a same-origin frame — the parts a query rooted at the document cannot see into, which is why `target` and `snapshotIgnore` resolve their selectors the same way.
- **Clicks are computed, not guessed.** A click resolves its ref to a backend node id, scrolls the element into view, reads its content quad, and converts that from page coordinates to the viewport coordinates CDP dispatches input in. It then sends a move, a press, and a release, which is what makes the event trusted.
- **A page is mirrored by its own tab.** The sidebar holds one tab per page the browser has open, addressed by the page's CDP target id, so two pages on the same address stay two tabs and a reloaded client re-attaches every tab to the page it was watching. A pane's frames, input, and address bar belong to its page, whether or not the tools are acting on it right now; a page the browser closes takes its tab with it, and closing a tab closes that page. **Every page the entry opens comes from one pick.** The page-less tab the browser entry opens asks the host for a page as it mounts — the ask is keyed by that tab record's own id, so a tab switched away and back, a Session change, or a client reload asks once — and the host opens one more page on a browser already running, or answers with the page a browser it started came up on. Which page the tools act on is `browser_tabs`'s `open`/`select`, independent of which pane the user is looking at.
- **The plugin's own routes carry the trust check.** The viewer socket, the status route, and the page route (open and close) are served by this plugin, and the webserver's route path runs no authentication of its own, so each applies Connection's rejection (`isTrustedApiRequest` and browser authentication) before answering. An unauthenticated request to any of them is refused with 401.
- **Settings are user overrides, not state.** The settings page writes to the harness settings document, and the `cordis.yml` entry stays the base layer beneath it; clearing a field removes the override. Every field changes how a browser is launched or encoded, so a write restarts the running browsers and the panes reconnect on their own.

-----

<a id="configuration"></a>
## Configuration

The settings section (Settings → Browser) edits the fields below and reports what is actually running, which is not the same thing as what is configured: the banner lists every session's browser with the port, window mode, and page count it really has. A deployment without a settings provider registers nothing, and the composition entry is the whole configuration.

| Field | Default | Meaning |
| --- | --- | --- |
| `channel` | `chrome` | Which installed browser to drive: `chrome` or `msedge`. |
| `executablePath` | empty | Explicit browser binary, for installs the channel lookup misses; overrides `channel`. |
| `headless` | `true` | Run without a window. Headless has nothing to occlude or minimize, so it is the recommended value. |
| `stealth` | `true` | Remove the two markers a Playwright-started browser carries: `navigator.webdriver` and, headless, a user agent spelled `HeadlessChrome/…`. |
| `userDataDir` | empty | Parent directory of the per-session profiles; empty means a temporary profile per browser, removed when it exits. |
| `debugPortMin` / `debugPortMax` | `9333` / `9400` | Window the per-session CDP ports are allocated from; each browser takes the lowest free one. Changing it moves where the *next* browser listens and leaves running browsers on the ports they already hold. |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | Page size in headless mode, which has no window to take a size from. |
| `quality` | `70` | JPEG quality of mirrored frames. |
| `maxWidth` / `maxHeight` | `1600` / `1200` | Longest edge of a mirrored frame, in device pixels. |
| `everyNthFrame` | `1` | Mirror every Nth composited frame. |
| `snapshotNodes` | `300` | Most accessibility-tree nodes one `browser_snapshot` prints before it truncates and says so. |
| `maxInstances` | `4` | How many session browsers may run at once; reaching the limit fails the request rather than evicting a browser someone is watching. |
| `startupUrl` | `about:blank` | First address a browser opens. |
| `extraArgs` | `[]` | Additional browser arguments, appended after the plugin's own. |

`stealth` is on by default because it was measured, not assumed: with the markers in place Google served its "unusual traffic" page three times out of three, and with them removed three times out of three searches returned results — including for a real Edge window started the same way, which is what showed the markers rather than the browser to be the deciding factor. The setting exists so the comparison can be reproduced. When a deployment needs more than markers can hide, `executablePath` accepts any Chromium binary the user supplies, including hardened builds; no third-party binary is bundled or downloaded by this plugin.

-----

<a id="tools"></a>
## Tools

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Open an address; returns the final URL, the title, and the tab list. |
| `browser_snapshot` | Read the page as roles, names, and refs (`- button "Sign in" [ref=e2]`); returns the tab list too. `find` narrows it to what matches a text or a `/regex/`, with the path to each match; `boxes` adds each element's position in viewport pixels; `target` and `depth` take one subtree to a level. |
| `browser_click` | Click the element a snapshot ref names — or one found by `role` + `name`, `text`, or `selector` when the call runs — with real mouse events at its position. `button` picks the right or middle button, `double` sends the two press-release pairs a page reads as one double click; a press the page says something else would receive is refused, and `force` sends it anyway and reports what received it. A native `<select>` and a checkbox cannot be driven by a press — the popup belongs to the browser process and its options have no box to click, and a toggled checkbox writes no attribute — so `select: ["Two"]` picks an option by its value or its visible label and `checked: true|false` sets the state; each dispatches the page's own `input`/`change`, reports `selected`/`checked`, and sends no mouse event. |
| `browser_type` | Type into the element a ref names — or one found by `role` + `name`, `text`, or `selector` when the call runs — replacing its content by default, and press a `key` afterwards: a chord such as `Control+A` or `Shift+Tab` works. The characters to insert are `value`; `text` names an element, as it does on `browser_click`. With no element, `value` and `key` go to whatever the page has focused and nothing is replaced, which is how Escape closes a menu. It also reports `focused`, the element the focus ended on, which is the only way to see where a bare `Tab` sent it. |
| `browser_wait` | Wait until the page reaches a state, then say whether it did: `text`, `role` + `name`, `selector`, `url`, or `time` (a fixed wait, the last resort) — exactly one, with `timeoutMs` up to 30 s. A condition that has not held is not an error: the result carries `matched: false`, how long it waited, where the page is now, and what the page changed meanwhile. It waits on the page already open; it does not start a browser. |
| `browser_console` | Read what the page and the browser have said about themselves since the address loaded: console output, uncaught exceptions, and browser log entries such as a failed request or a blocked resource. Optional `levels`, `filter`, and `limit`. This is where a failure that leaves no mark in the DOM shows up, and it is the whole history, not just the last call — it is cleared when the page navigates. |
| `browser_screenshot` | Capture the page to a JPEG file and return its path: the viewport by default, `fullPage: true` for the whole document, or one element named the way the acting tools name one. `inline: true` also attaches the image to the result (needs a model that declares image input; the call is refused, with the file still available, when it does not). |
| `browser_evaluate` | Evaluate a JavaScript expression in the page: reading values, scrolling, `history.back()`, and anything else a tool argument list would express worse. A returned promise is awaited, a returned function is called, and top-level `await` and `return` both work. A string comes back as itself; anything else as JSON; a result too large to print is written to a file whose path comes back. |
| `browser_tabs` | See the browser's pages and change them: `list` reports every page — its id, its address, and which one the tools act on right now, from the same list the sidebar's tabs are built from; `open` asks for a new page and selects it; `select` makes a page that is already open the one the other tools act on; `close` closes one page, and closing the last page stops the browser. It never switches on its own: which page a pane shows and which page the tools act on are two things, and clicking a sidebar tab does not move the latter. |

**An action result carries a compact list of what changed.** `changed` says the page moved (`dom`), which does not distinguish a click that opened what it named from one that only repainted a spinner. So the action also reports the **first few** changes the page made, each in facts the page itself can stand behind — its tag, the `role` it declares, and a short piece of what it says: `dom: +1 status "Saved"; ~ p "24.1k" → "24.2k"; ~ button "Save" disabled: (none) → "true"`. The list is capped at five and the changes that did not fit are **counted** rather than dropped, and every entry is structured (`kind`/`tag`/`role`/`preview`/`attribute`/`from`/`to`) so a PTC program can branch on it. This is the page's own description of itself, for knowing where to look: the accessible roles and names are still `browser_snapshot`'s to report.

**A dialog is answered by the call that opens it.** A `confirm`, `prompt`, or `alert` blocks the page until it is answered, so there is no moment at which a later call could answer one: pass `dialog: "accept"` — with `dialogText` for a prompt — on the call that triggers it, or the default dismissal is reported in the result. Every dialog is answered before the call returns and none is silent: the result names what the page asked and how it was answered, and `changed` says `dialog`, so "the page did not change" can never be the report for a click a site stopped to confirm.

The set is deliberately small because `browser_evaluate` exists: a tool earns its place only by doing something code cannot, which here means trusted input, reading a page without knowing its selectors first, and the two questions that cannot be asked after the fact — whether a state has been reached (`browser_wait`), and what the page said about itself while it failed (`browser_console`, whose listener has to be subscribed before the page's own scripts run). All three are deliberate exceptions to "new capability becomes a parameter, not a tool name" (the third is `browser_tabs`: a page is not a property of the current page, and page script cannot see another target); the screenshot's shapes are the rule followed instead: `fullPage`, an element target, and `inline` are parameters on the tool that already existed. Choosing an option and setting a checkbox are the same shape — `select` and `checked` are parameters on `browser_click` — because a press can do neither. Deliberately absent are `back`/`forward`/`reload` (the pane has reload; history is one expression), hover, drag, upload, and download — each would be added when a real case needs it, not in anticipation.

Screenshots are written to a file, and the path comes back so it is durable in the session log. `inline: true` also attaches the image to the result, which costs no second call; the attachment is a reference the harness's attachment service mints (the plugin declares that service structurally and does not depend on its package), and the call is **refused before the capture** when the calling model does not declare image input — an image block is part of the tool result, so attaching one to a model that cannot read it would fail that request and every request after it.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Verified on Windows only.** macOS and Linux have not been run once: the `channel` lookup, temporary directories, and process teardown are the parts most likely to differ.
- **The pane shows the page its tab names, and pages the browser opens on its own are followed only when the plugin is told about them.** A page the plugin learns of — a tool call, `window.open` from a page it drives — gets its own tab and its own mirror; a headful browser switched by its own tab strip keeps every mirror where it was, because the plugin is not told.
- **IME composition does not work in the sidebar.** During composition `event.key` is `Process` rather than a character, so nothing sensible can be forwarded. Outside composition the pane sends printable characters as text, named keys as key events, and a keystroke held with Ctrl, Alt or Meta — or Shift — as the chord it is, so Ctrl+A selects the page instead of typing an "a"; AltGr combinations still go as text, which is what they are on Windows (Ctrl+Alt). Pasting and plain ASCII typing are unaffected. The agent's `browser_type` is unaffected too: it inserts text rather than replaying keys.
- **The pane handles the clipboard shortcuts itself.** `Ctrl/Cmd+C`, `Ctrl/Cmd+X` and `Ctrl/Cmd+V` work in the pane: a copy or a cut puts the **mirrored page's selection** on your system clipboard, and a paste sends your clipboard text to the mirrored page (through `Input.insertText`, not by replaying keys). The page itself never receives those keystrokes — Chromium keeps the clipboard shortcuts in the browser process, where an injected key event does not go (measured: the page sees no `keydown` at all for them) — so this happens on the pane's side, where the keystroke is trusted. Plain text only; a page's own `navigator.clipboard.writeText` (a site's "copy" button) still writes the browser process's own clipboard, which in headless is not the system one.
- **A dialog is answered before its question can be read.** The page is blocked until the dialog is answered, so the answer has to be declared on the call that opens one; a call that did not declare it dismisses the dialog and reports that it did. The usual shape is two calls: the first reports what the page asked, the second answers it the other way.
- **Frames only when the page repaints.** `Page.startScreencast` is repaint-driven, so a page that never changes produces almost no frames and the pane keeps the last one. This is not a hang.
- **Not interactive while minimized.** Headless is unaffected, but a minimized headful window stops both frames and input.
- **`maxInstances` has no pane affordance.** Reaching the limit fails tool calls and refuses new panes with a message naming the limit, but the pane offers nothing to release one; the way to free a slot is closing a browser from its pane or disposing the session.
- **The tools do not follow the pane.** Clicking another browser tab in the sidebar changes what you are looking at, not which page the tools act on — deliberately (the pane is for the eyes, the tools are the agent's), and `browser_tabs`'s `select` is how the agent moves it.
- **Two picks during the same start are one page.** A browser that is starting joins both asks into the start it is already doing, and a start has one initial page; picks made once it is running add a page each.
- **No profile picker.** A session's profile is derived from its id, so there is no way to point this conversation at an existing Chrome profile, and no named list of profiles to choose from.
- **Downloads, uploads, file choosers, and permission prompts are not handled.** They happen in the browser process and are not surfaced or answered through the pane.
- **No request interception or network inspection.** The plugin drives a browser; it is not a proxy. Use the attached CDP port for that.
- **Calls without a session are refused.** A scheduled job or a subagent with no session of its own fails the browser tools by design; attributing its calls to some other conversation's browser would be worse than the failure.
- **Console history is per page and bounded.** `browser_console` keeps the last 200 entries of the current document (it says how many it dropped) and clears them when the page navigates: a message belongs to the document that produced it, the same way a ref does. Each message is clipped at 500 characters, and an argument that is an object is rendered from the protocol's own preview — enough for `{code: 500}`, not a deep dump.
- **A screenshot can become an image block** when the composition mounts the attachment service and the calling model declares image input (`inline: true`); otherwise the file path is the answer, and asking for `inline` on a model that cannot read images is refused with that reason rather than silently ignored.
- **Not published to npm.** Install from GitHub or a local checkout — see [Install](#install).

-----

<a id="dev-note"></a>
## Dev Note

The plugin directory is a self-contained pnpm workspace (`packages: [- .]`, `storeDir: .pnpm-store`) so pnpm cannot reach the harness repository's workspace. dsh framework packages are `peerDependencies` (`>=0.1.7-rc.1`, supplied by the host profile) and pinned exactly in `devDependencies` for local types and builds.

To run a local checkout instead of a tag, link it into the profile — later `pnpm run build` runs apply on the next harness restart without re-adding:

```sh
cd dsh-browser
pnpm install          # self-contained workspace; store lives in .pnpm-store/
pnpm run build        # emits lib/index.js (host) and lib/client.js (browser)
dsh plugin add --profile web link:/absolute/path/to/dsh-browser
```

Commands: `pnpm run build` (tsdown, both halves), `pnpm run typecheck`, `pnpm test`, and the measurement rigs in `scripts/` (`prove.mjs` for the CDP port, screen cast, input dispatch, and screenshot; `modes.mjs` for headless/windowed/minimized; `cdp.mjs` to read or drive a running browser over its external port, with `--port=` to pick a session's).

`pnpm test` runs on Node's own TypeScript support (`node --test "test/**/*.test.ts"`), with no loader dependency — which is also a constraint on the source: enum, parameter properties, and other non-erasable syntax do not run. Browser-dependent behavior is tested against a recording launcher (`test/support/browser.ts`) that hands out fake pages and CDP sessions, so the suite needs no Chrome. What such fakes cannot prove — the shape of a real accessibility tree, the coordinate space of a real click, whether a real click is trusted — was verified once against Chrome and lives in the decision notes under [`.agents/notes/`](.agents/notes/README.md).

The built `lib/` is committed, so commit the rebuilt output with any source change or a GitHub install serves stale code.

<a id="third-party-code"></a>
### Third-party code

None is bundled. `lib/index.js` imports `playwright-core` (Apache-2.0) and `ws` (MIT) as runtime dependencies, and `lib/client.js` requires only the host shell's platform modules, so upstream security updates reach users through their own install rather than through this repository. The plugin ships no browser either: it drives the Chrome or Edge installation that is already on the machine, through `playwright-core`'s `channel` lookup, so the roughly 200 MB download a bundled browser would cost is not part of installing this.
