/**
 * Finding the element an action means, when the caller has no ref.
 *
 * A ref is resolved once, by a snapshot, against the DOM as it was then: a
 * client-rendered page that re-renders a control leaves the ref pointing at a
 * node nobody is looking at, and a page with two identically named controls
 * gives the caller no way to say which one it meant. A locator is resolved at
 * the moment of the action instead, and when it is ambiguous this refuses
 * rather than choosing.
 *
 * The refusal is the feature. Both other answers are worse: picking the first
 * match clicks an element the caller did not name, and picking none reports a
 * page as empty. What makes the refusal usable is the list it carries — every
 * candidate with the nearest ancestor that has a name, which is usually the
 * only fact that tells two identically named controls apart ("the one in
 * Settings" against "the one in the instance list").
 *
 * Matching reads the accessibility tree, so what a locator can match is what a
 * snapshot prints; the words a reader sees in a snapshot are the words it can
 * search for. `role` is compared as a whole word and `name`/`text` as
 * case-insensitive substrings, which is the same latitude `find=` gives.
 */
import { isTextRun, nameOf, refTargetOf, roleOf, type AxNode, type RefTarget } from './aria.ts'

/**
 * How a caller names an element without holding a ref.
 *
 * One of these, or a ref, is how every element-naming parameter resolves. The
 * three locator forms are alternatives rather than filters: `role` with an
 * optional `name` names a control by what it is, `text` names it by what it
 * says, and `selector` hands the question to CSS.
 */
export interface Locator {
  /** ARIA role to match, case-insensitively and as a whole word. */
  readonly role?: string
  /** Accessible name to match, case-insensitive substring; needs `role`. */
  readonly name?: string
  /** Accessible name to match as a case-insensitive substring, without a role. */
  readonly text?: string
  /** CSS selector resolved against the document, for what the tree cannot name. */
  readonly selector?: string
}

/** One element a locator could mean, with what tells it from the others. */
export interface Located extends RefTarget {
  /** Names of the nearest ancestors that have one, nearest first. */
  readonly trail: readonly string[]
}

/** How many named ancestors a candidate reports; enough to tell siblings apart. */
const TRAIL_DEPTH = 3

/**
 * How a caller's locator is named in a message.
 *
 * It quotes the locator rather than the element, because the element is what
 * the caller could not name — a message that answered with the element's own
 * role and name would read as though the question had been understood.
 * @param locator - what the caller asked for.
 * @returns the locator as a short phrase.
 */
export function describeLocator(locator: Locator): string {
  if (locator.selector !== undefined) return `selector ${JSON.stringify(locator.selector)}`
  if (locator.text !== undefined) return `text ${JSON.stringify(locator.text)}`
  if (locator.role !== undefined) {
    return locator.name === undefined
      ? `role ${locator.role}`
      : `${locator.role} ${JSON.stringify(locator.name)}`
  }
  return 'the given locator'
}

/** Whether a locator asks the accessibility tree anything, rather than CSS. */
export function locatorIsTreeShaped(locator: Locator): boolean {
  return locator.role !== undefined || locator.name !== undefined || locator.text !== undefined
}

/**
 * Ancestor names of every node, nearest first.
 *
 * Built from `childIds`, which is the only parent link CDP reports, so a node
 * appears under the parent that claimed it; a node nothing claims has none.
 * @param nodes - the flat node list.
 * @returns the parent of each node id.
 */
function parentsOf(nodes: readonly AxNode[]): Map<string, AxNode> {
  const parents = new Map<string, AxNode>()
  for (const node of nodes) {
    if (node.nodeId === undefined) continue
    for (const child of node.childIds ?? []) parents.set(child, node)
  }
  return parents
}

/**
 * The names of a node's nearest named ancestors, nearest first.
 * @param node - the node to walk up from.
 * @param parents - the parent map.
 * @returns up to {@link TRAIL_DEPTH} ancestor names, skipping the unnamed ones.
 */
function trailOf(node: AxNode, parents: ReadonlyMap<string, AxNode>): string[] {
  const trail: string[] = []
  let current = node.nodeId === undefined ? undefined : parents.get(node.nodeId)
  // Bounded twice: by a hop cap against a malformed tree that points at itself,
  // and by the depth the caller actually needs.
  for (let hop = 0; current !== undefined && hop < 64 && trail.length < TRAIL_DEPTH; hop += 1) {
    const name = nameOf(current)
    // An unnamed wrapper says nothing that tells two candidates apart, and
    // printing `generic ""` for it would push a real name out of the list.
    if (name !== '') trail.push(`${roleOf(current)} ${JSON.stringify(name)}`)
    current = current.nodeId === undefined ? undefined : parents.get(current.nodeId)
  }
  return trail
}

/**
 * Whether one node answers a locator.
 * @param node - the node to test.
 * @param locator - what the caller asked for.
 * @returns whether this node is a candidate.
 */
function matches(node: AxNode, locator: Locator): boolean {
  if (locator.text !== undefined) {
    return nameOf(node).toLowerCase().includes(locator.text.toLowerCase())
  }
  if (locator.role !== undefined) {
    if (roleOf(node).toLowerCase() !== locator.role.toLowerCase()) return false
  }
  if (locator.name !== undefined) {
    return nameOf(node).toLowerCase().includes(locator.name.toLowerCase())
  }
  return locator.role !== undefined
}

/**
 * Every element in an accessibility tree a locator could mean.
 *
 * Nodes with no DOM node behind them and nodes hidden from assistive technology
 * are not candidates: an action cannot reach either, so offering one would be
 * offering a choice that fails.
 *
 * A run of text is a candidate only when nothing above it already answers the
 * same question. Measured 2026-09-29 on a real page: an element whose accessible
 * name is computed from its contents — `role="status"`, a link, a button —
 * carries the same words as the text run inside it, so both match. The run says
 * nothing the element does not, and the element is what an action can reach, so
 * reporting both would turn every such page into a false ambiguity. A run inside
 * an element that computes no name of its own is the *only* thing that says the
 * words, which is why it cannot simply be dropped: that is the shape of a plain
 * `<div>Loading…</div>`, which is how most pages state what they are doing.
 * @param nodes - the flat node list CDP returned.
 * @param locator - what the caller asked for.
 * @returns the candidates, in the order the tree listed them.
 */
export function locateInTree(nodes: readonly AxNode[], locator: Locator): Located[] {
  if (!locatorIsTreeShaped(locator)) return []
  const parents = parentsOf(nodes)
  const matched: AxNode[] = []
  for (const node of nodes) {
    if (refTargetOf(node) === undefined || !matches(node, locator)) continue
    matched.push(node)
  }
  const answered = new Set(matched)
  /** Whether an ancestor of this run already answers the locator. */
  const covered = (node: AxNode): boolean => {
    if (!isTextRun(node)) return false
    let current = node.nodeId === undefined ? undefined : parents.get(node.nodeId)
    while (current !== undefined) {
      if (answered.has(current)) return true
      current = current.nodeId === undefined ? undefined : parents.get(current.nodeId)
    }
    return false
  }
  const found: Located[] = []
  for (const node of matched) {
    if (covered(node)) continue
    const target = refTargetOf(node)
    if (target === undefined) continue
    found.push({ ...target, trail: trailOf(node, parents) })
  }
  return found
}

/**
 * The error a locator gets when the page has nothing that answers it.
 * @param locator - what the caller asked for.
 * @returns the error to throw.
 */
export function locateMissError(locator: Locator): Error {
  return new Error(
    `dsh-browser: no element matches ${describeLocator(locator)}; check it, `
    + 'or call browser_snapshot and act on a ref from its result',
  )
}

/**
 * The error a locator gets when the page has several elements that answer it.
 *
 * The candidates are listed whether or not there are many, because the caller's
 * next move — narrowing the locator, or acting on a ref — needs to know which
 * ones it was choosing between, and one of them is usually obviously the one
 * meant once its ancestors are visible.
 * @param locator - what the caller asked for.
 * @param candidates - every element that answered it.
 * @returns the error to throw.
 */
export function locateAmbiguousError(locator: Locator, candidates: readonly Located[]): Error {
  const lines = candidates.map((candidate, index) => {
    const where = candidate.trail.length === 0 ? 'no named ancestor' : `in ${candidate.trail.join(' < ')}`
    return `\n  ${String(index + 1)}. ${candidate.role} ${JSON.stringify(candidate.name)} — ${where}`
  })
  return new Error(
    `dsh-browser: ${describeLocator(locator)} matches ${String(candidates.length)} elements:`
    + `${lines.join('')}\nNarrow it with a name that is unique, or call browser_snapshot and act on the ref of the one you mean.`,
  )
}
