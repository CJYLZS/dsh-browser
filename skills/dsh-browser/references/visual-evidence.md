# When a picture is the evidence

Read when the question is about pixels rather than structure: a layout, a chart, a canvas, a style regression, "does this look right". A snapshot answers most questions about a page more cheaply and more precisely.

## Pick the frame

- **Default (no options)** — the viewport: what a person looking at the window would see.
- **`fullPage: true`** — the whole document. This is what judging a layout needs when the page is taller than the window; a viewport capture of a scrolled page shows an arbitrary window onto it.
- **An element** — `ref`, or `role` + `name`, `text`, or a `selector`, exactly as the acting tools take one. The capture is that element alone, and the element never has to be scrolled to first.

## Look at it without a second call

The capture is always written to a file and the path comes back — that is what makes it durable in the conversation. `inline: true` also attaches the image to the result, so it can be looked at immediately instead of read back. That needs a model which declares image input; when it does not, the call is refused and says so, and dropping `inline` gives the file.

## What not to do

- **Do not ask for a snapshot and a picture together by default.** One of them answers the next question; the other is context spent twice.
- **Do not re-issue a capture that timed out, immediately.** The browser may still be completing the first one; wait, or reload the page, before trying once more.
- **Do not read a screenshot to find out what an element is.** Roles and names come from `browser_snapshot`; a picture cannot be grepped, and the model's reading of it is not evidence anyone can check.
- **Do not capture a page that is still moving** and treat the result as the state: wait for the state first (`references/waiting-for-app-state.md`).
