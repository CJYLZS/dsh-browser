# When a control's name is not unique

Read when a locator matched several elements, or when the page shows two controls with the same words — three buttons called 暂停, an "Open" on every row.

## The refusal is the useful part

A call whose locator matches several elements is refused, and the refusal lists each candidate with the ancestors that tell them apart (`button "Open" — in dialog "Settings"`). Pick the candidate whose ancestors name the place you meant; that list is the disambiguation, not an error to work around.

## Then narrow, in this order

1. **`role` + `name`** when the snapshot showed the role. The roles the snapshot prints are the ones the tools accept.
2. **`selector`** when the element has something durable: `[data-testid="save"]`, `#total`, `[href="/pricing"]`. This is also the only way to reach an element the accessibility tree does not name.
3. **A ref from a narrowed snapshot**: `browser_snapshot({ target: "main" })`, then the ref from that subtree, when the container is what makes the name unique.

If the page re-rendered the control, a `ref` is refused and a locator is not — a locator is resolved at the moment of the action, which is why it is the more robust of the two.

## What not to do

- **Do not pick by position.** There is no "the second one" parameter, on purpose: a positional choice silently changes meaning the moment the page re-renders, and the click lands on whatever moved into that place.
- **Do not guess a role to make a name unique.** A snapshot-proven heading or visible text does not need a `link` or `button` role; `role` + `name` is for narrowing, not for inventing.
- **Do not work around the refusal with `force`.** `force` answers "something is over the element", not "I could not tell which element you meant".
