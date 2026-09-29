# Waiting for the page to reach a state

Read when the next step depends on something the page has not done yet: an engine starting, a socket connecting, a slow request landing.

## Wait for the state, not for a length of time

`browser_wait` takes exactly one condition and asks the page until it holds:

- `{ text: "就绪" }` — an element whose name contains this text.
- `{ role: "button", name: "启动并连接" }` — narrower, when the name alone is ambiguous.
- `{ selector: "#ready" }` — an element the accessibility tree does not name.
- `{ url: "/dashboard" }` — the address contains this text. This one reads no tree at all.
- `{ time: 8000 }` — a fixed wait, and the last resort: use it only when there is genuinely nothing to ask about yet.

The locator vocabulary is the same as `browser_click`'s, so nothing new has to be learned to wait for what you are about to click.

## `matched: false` is an answer

A wait that runs out of time is not an error. It returns where the page is now, what the page changed while you waited, and whether your condition matched at all — which together are what tells "still starting" from "this page will never do it". Raise `timeoutMs` only when the second reading looks like slow progress rather than a wall (default 10 s, at most 30 s).

## Where waiting does not help

- **A wait does not start a browser, and does not answer a dialog.** A page blocked on a dialog answers nothing, so a condition can never hold: answer the dialog on the call that opens it.
- **After a timeout, do not ask the same question again.** Look at what the page says instead — its snapshot for where it stopped, `browser_console` for what it complained about — and then decide.
- **Never substitute a sleep for a wait.** A fixed pause is wrong in both directions: too short and you conclude it did nothing, too long and you spend the conversation's time. `time:` exists only for the case where the page cannot be asked anything at all.
