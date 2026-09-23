# dsh-browser

English | [中文](README.zh.md)

Mirror a **real local browser** into the DeepSeek Harness right sidebar: the agent drives it with tools, you watch it and can operate it by hand, and DevTools or another Playwright can attach to the same browser over its own CDP port.

Unlike `ui-sidebar-browser` (the harness tab that embeds a page inside the app), this plugin starts a **separate browser process** with its own profile, its own sign-ins, and its own CDP port. The two do not interfere and can coexist.

## Summary

Each conversation gets its own browser. Open the Browser tab in the right sidebar and a Chrome (or Edge) process starts for that session; the agent's browser tools address the same process, and a different conversation sees a different browser — different pages, different cookies, different port. Nothing is shared between sessions, which is the point.

<a id="highlights"></a>
## Highlights

- **One browser per conversation.** Session isolation is enforced on both paths — the sidebar tab names its session on the socket, and the tools resolve the browser from the session the call came from. Two conversations never see each other's pages or tabs.
- **A real browser, not an embedded view.** A separate Chrome/Edge process driving a real profile, so sites see a real browser; the sidebar shows it by mirroring frames over CDP.
- **Bidirectional.** Input in the sidebar (click, wheel, typing) is forwarded to the real page; the agent's `browser_click` / `browser_type` dispatch trusted mouse and text events, which a page that ignores synthetic `element.click()` still accepts.
- **Attachable.** The same browser listens on an external CDP port, so `chrome://inspect`, another Playwright, or `scripts/cdp.mjs` can attach to it while the sidebar is mirroring.
- **Tools lean on code.** Six tools, not forty: `browser_evaluate` is the general-purpose one, and the rest cover what code cannot do — reading a page without knowing its selectors, and trusted input.

## Table of Contents

- [Highlights](#highlights)
- [Install](#install)
- [Usage](#usage)
- [Understand the design](#understand-the-design)
- [Configuration](#configuration)
- [Tools](#tools)
- [Known limitations](#known-limitations)
- [Dev note](#dev-note)

-----

<a id="install"></a>
## Install

From GitHub (recommended) — the built `lib/` is committed, so it is one command with no build step:

```sh
dsh plugin add --profile web github:CJYLZS/dsh-browser
```

For development, link a local checkout instead:

```sh
cd dsh-browser
pnpm install          # self-contained workspace; store lives in .pnpm-store/
pnpm run build        # emits lib/index.js (host) and lib/client.js (browser)
dsh plugin add --profile web link:/absolute/path/to/dsh-browser
```

A `link:` install points the profile at the checkout directory, so later `pnpm run build` runs apply on the next harness restart without re-adding.

Restart the harness after installing.

<a id="usage"></a>
## Usage

**Watch and operate it.** In the right sidebar pick "New tab" → "Browser". Opening the tab starts that session's browser and the picture appears; the address bar navigates on Enter, and clicking, scrolling, and typing over the picture go to the real page. The status line shows which CDP port this session's browser ended up on.

**Let the agent use it.** The browser tools appear in every conversation. Ask for "open example.com and tell me the title" and the same browser the sidebar shows does the work.

**Attach your own tools.**

```sh
curl http://127.0.0.1:9333/json/version     # is this port listening?
```

Use `chrome://inspect` → "Configure…" to add `127.0.0.1:9333`, or `chromium.connectOverCDP('http://127.0.0.1:9333')`. `scripts/cdp.mjs` is a minimal client (`list` / `inject` / `read` / `point` / `eval` / `goto`, `--port=` to pick a session's browser).

<a id="understand-the-design"></a>
## Understand the design

**A browser belongs to a conversation.** The plugin keys everything by the harness session id: the sidebar tab names the session on its WebSocket and is given that session's browser; a tool call is resolved against the session the call came from. A conversation that opens three tabs still has one browser, and no other conversation can see it.

**The sidebar tab is a window, not the resource.** Closing it unsubscribes that viewer and leaves the browser running — reopen it and the browser is still there. To stop a browser, use "Close browser" in the pane's status row. A browser survives between tool calls on purpose: that is what makes a conversation feel like it has a browser rather than a series of page loads.

**One process, one profile.** Chrome locks a profile directory to a single running process, so each session's browser gets its own subdirectory of the configured profiles directory. The consequence is deliberate and worth stating plainly: **sign-ins are not shared between conversations.** A site you log into in one conversation starts signed out in another.

**Ports are allocated, not assumed.** `debugPort` is the first port tried; each session's browser probes upward for a free one and holds it until that browser closes. Read `/dsh-browser/status` to learn which session is on which port rather than assuming the configured number.

**A dead browser is replaced, not mourned.** If you close the window or the process crashes, the instance moves to `closed` with the reason, the pane shows it and offers "Restart browser", and the next tool call starts a fresh browser on its own.

**Frames follow repaints.** `Page.startScreencast` is repaint-driven, so a page that never changes produces almost no frames. The sidebar keeps the last frame; that is not a hang.

<a id="configuration"></a>
## Configuration

**Settings page**: Settings → "Browser", where window mode, automation markers, profiles, browser choice, page size, quality, and CDP port are editable. The banner at the top reads the plugin's own `GET /dsh-browser/status` route (the settings page belongs to no session, so it lists every session's browser). It reports the instances that are actually running — not the current configuration — because otherwise there is no way to tell a saved value from one a browser is using.

The settings page writes to the harness settings document (`dsh-browser` in `~/.dsh/settings.yaml`) and records **user overrides only**: clearing a field falls back to the composed configuration below, and an overridden field shows a "Reset" button.

The `config` in `cordis.yml` is the **base layer**, with settings-page changes on top:

| Field | Default | Meaning |
|---|---|---|
| `channel` | `chrome` | Which installed browser to drive (`chrome` / `msedge`) |
| `executablePath` | empty | Explicit browser binary; overrides `channel` |
| `headless` | `true` | No window. Nothing to occlude or minimize, so it is the recommended value |
| `stealth` | `true` | Removes the two automation markers a Playwright-started browser carries: `--disable-blink-features=AutomationControlled` (makes `navigator.webdriver` false) and rewriting the headless user agent's `Headless` token. Measured: with the markers Google served its "unusual traffic" page 3/3 times; without them, 0/3. Set `false` to reproduce the comparison |
| `userDataDir` | empty | **Parent** directory of the per-session profiles; empty means a fresh temporary profile per browser |
| `debugPort` | `9333` | First CDP port; each browser probes upward from here |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | **Page size in headless mode.** Headless has no window to take a size from, and the virtual one it uses is far smaller than a page expects (measured 764×485, which crops most sites) |
| `quality` | `70` | JPEG quality of mirrored frames |
| `maxWidth` / `maxHeight` | `1600` / `1200` | Longest mirrored frame edge |
| `everyNthFrame` | `1` | Mirror every Nth composited frame |
| `snapshotNodes` | `300` | Most accessibility-tree nodes one `browser_snapshot` prints |
| `maxInstances` | `4` | How many session browsers may run at once; reaching it fails the request rather than evicting a browser someone is watching |
| `startupUrl` | `about:blank` | First address the browser opens |
| `extraArgs` | `[]` | Extra browser launch arguments |

In a deployment with no settings provider the page does not appear and the configuration is exactly what `cordis.yml` says.

<a id="tools"></a>
## Tools

| Tool | What it does |
|---|---|
| `browser_navigate` | Open an address; returns the final URL, title, and the tab list |
| `browser_snapshot` | Read the page as a tree of roles, names, and refs (`- button "Sign in" [ref=e2]`), plus the tab list |
| `browser_click` | Click the element a snapshot ref names, with real mouse events at its position |
| `browser_type` | Type into the element a ref names (replacing its content by default), optionally pressing a key such as Enter |
| `browser_screenshot` | Capture the page to a JPEG file and return its path |
| `browser_evaluate` | Evaluate a JavaScript expression in the page — the general-purpose tool for reading values, scrolling, waiting, going back |

Refs belong to one snapshot of one page: navigate and they are gone, which is why a stale ref fails with a message pointing at `browser_snapshot` rather than clicking something else.

Screenshots return a path rather than an inline image: an image block needs a reference the attachment service owns, which a plugin cannot mint, and the shipped adapters accept images only in user messages. Read the file with the ordinary file tools.

A tool called without a session — a scheduled job, or a subagent without one — fails rather than landing in someone else's browser.

## Known limitations

- **IME composition does not work.** During composition `event.key` is `Process` rather than a character, and key forwarding handles single characters plus a few named keys (Enter, Tab, arrows). Pasting and plain ASCII typing are fine.
- **The mirror follows the newest page.** A link that opens a tab, or `window.open`, moves the mirrored page and the tools with it; a page opened by hand inside the browser window does not. The sidebar has no tab strip yet (that needs the 0.1.7 `multiple` slot capability).
- **Frames only when the page repaints.** A completely static page produces almost no frames; the sidebar keeps the last one.
- **Not interactive while minimized.** Headless is unaffected; in windowed mode a minimized window stops both frames and input.
- **Verified on Windows only.** macOS and Linux have not been run (`channel: 'chrome'` lookup, temporary directories, process teardown).

<a id="dev-note"></a>
## Dev note

```sh
pnpm run typecheck
pnpm test                  # node --test (native TypeScript stripping; no tsx)
pnpm run build
node scripts/prove.mjs     # prerequisites: CDP port, screencast, input dispatch, screenshot
node scripts/modes.mjs     # headless / windowed / minimized comparison
node scripts/cdp.mjs list  # read the mirrored browser over its external CDP port
```

`pnpm test` runs the unit suite: input mapping, coordinate conversion, screencast acknowledgement and teardown order, configuration validation, profile-directory escaping, port allocation, pool isolation/limits/recycling, accessibility-tree formatting, and the pane's and tools' session resolution. Browser-dependent tests use a recording launcher in `test/support/`, so they need no Chrome.

`scripts/` holds the measurement rigs from development, kept as regression tools; `.prove/` is their output directory.
