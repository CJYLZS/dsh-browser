# Reading a page

Read when you need text or structure out of a page: a list of results, one section, an element's own words.

## Start from the snapshot, not from `body`

`browser_snapshot` is the reading tool. It prints roles, names, and refs, drops what cannot be read or acted on, and stops at a budget, so a page of 1148 nodes prints as roughly 364 lines. `document.body.textContent` has none of that: it carries `<style>` and `<script>` source, invisible and `aria-hidden` content, and nothing bounds it.

- The whole page: `browser_snapshot`.
- One part of it: `target: "<ref>"` for a subtree, or a CSS selector (`target: "main"`).
- One question: `find: "Total"`, or `find: "/\\$[\\d.]+/"` for an expression. It prints only the matching lines, with the path to each.
- The shape without the detail: `depth: 2`.
- Positions rather than a picture: `boxes: true`.
- Too large to read here: `file: true` writes it down and returns the path.

## One element's own words

When you already know how to address the element, `browser_evaluate` is the shorter road:

```js
document.querySelector('#total')?.textContent?.trim()
```

A string comes back as the string, so there is nothing to unescape. An expression that reads the whole document is not dangerous, only wasteful: a result too large to print is written to a file and comes back as `{ truncated: true, path }` — the value is whole in that file, never cut.

## What the snapshot's words are

The roles and names in a snapshot are the browser's *computed* ones, which is why they can be clicked and waited for. The `role` and `preview` in an action's change list are what the element *declares* — a different fact, and the reason the list is a pointer: take a snapshot when you need to know what an element is.
