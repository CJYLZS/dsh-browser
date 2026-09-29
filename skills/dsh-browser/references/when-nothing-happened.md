# When an action's expected effect never appeared

Read when a click, a key press, or a typed value came back without the change you expected.

## Read the result in this order

1. **The change list.** `dom: +1 status "Saved"` is the page having done something. `The page did not change.` means exactly that and no more: it is evidence about the page, not a verdict on the action, so the next move is to look further rather than to re-send the same press.
2. **`obstructed`.** A click goes to a point, so an open menu's backdrop or a sticky header can take it. The result names what received it; `force: true` sends the press anyway and says so.
3. **`dialogs`.** A dialog blocks the page until it is answered, and only the call that opens it can answer; a call that dismissed the wrong one says so here.
4. **`browser_console({ levels: ["error"] })`.** A handler that threw, a request that failed, a script that never loaded: none of those leave a mark in the DOM, and this is where they show. It reports the whole history since the page loaded — including the load itself — not just the last call.
5. **A fresh `browser_snapshot`.** The element may have been replaced by the page, or the state you were reading may have moved.

## Then change something

- **Do not repeat the action unchanged.** The same input in the same state produces the same result, and for a toggle-shaped control it produces the opposite of what you meant (a menu that was open is now closed).
- If the click was refused as obstructed, deal with what is over it: close the menu, or re-read the page and act on the blocker.
- If the work is asynchronous, wait for the state rather than re-clicking — see `references/waiting-for-app-state.md`.
