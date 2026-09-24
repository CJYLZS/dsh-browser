/**
 * The page as a tree of roles, names, and refs.
 *
 * A model that can only read a page through JavaScript has to know what it is
 * looking at before it can look; this is the other way round. Chrome's
 * accessibility tree is already that description, so it is printed rather than
 * reinterpreted, with four changes that make it usable:
 *
 * - `ref` labels the DOM node behind a line, which is how a later click or type
 *   names its target without inventing a selector that may not survive. A label
 *   belongs to the page, not to one snapshot: re-printing a page does not
 *   renumber it, so a ref taken before a menu opened still names the element it
 *   named then, and a label minted for the first time is marked `*`.
 * - Nodes Chrome marks ignored are dropped and their children promoted, since
 *   they are wrappers that describe nothing — except a subtree hidden from
 *   assistive technology, which is dropped whole rather than promoted.
 * - Nodes that only repeat what the reader already has are dropped: the
 *   one-character `InlineTextBox` runs Chrome emits per rendering run, text an
 *   ancestor already names, decorative images, and nameless wrappers that group
 *   nothing. Measured on github.com/trending (2026-09-24): 1148 nodes collapse
 *   to 408 lines with the structure intact.
 * - What a node cannot say in a role and a name is said in whitelisted
 *   properties, truncated and deduplicated, so the line stays readable.
 *
 * A snapshot that could not print everything says so, and says which parameter
 * would have printed the rest: the model's next call is the point of the note.
 *
 * The format is deliberately plain text with one node per line: it reads the
 * same to a model, to a log, and to a person debugging the tool.
 */

/** One node of the accessibility tree, as CDP reports it. */
export interface AxNode {
  /** Identity within the tree, used to resolve children. */
  readonly nodeId?: string
  /** Whether Chrome considers this node irrelevant to accessibility. */
  readonly ignored?: boolean
  /** Why Chrome ignored it; the reason decides whether children are promoted. */
  readonly ignoredReasons?: readonly { readonly name?: string }[]
  /** ARIA role. */
  readonly role?: { readonly value?: unknown }
  /** Accessible name. */
  readonly name?: { readonly value?: unknown }
  /** Current value, for roles that carry one. */
  readonly value?: { readonly value?: unknown }
  /** Accessible description, often the `title` attribute. */
  readonly description?: { readonly value?: unknown }
  /** Node states and properties such as `disabled`, `checked`, or `url`. */
  readonly properties?: readonly {
    readonly name?: string
    readonly value?: { readonly value?: unknown }
  }[]
  /** Ids of this node's children, in order. */
  readonly childIds?: readonly string[]
  /** The DOM node this describes, absent for purely structural nodes. */
  readonly backendDOMNodeId?: number
}

/** A DOM node a ref names, with the semantics the snapshot recorded for it. */
export interface RefTarget {
  /** The DOM node behind the ref. */
  readonly backendNodeId: number
  /** The role the node had when it was labelled. */
  readonly role: string
  /** The accessible name the node had when it was labelled. */
  readonly name: string
}

/** A node the caller asked to print instead of the whole page. */
export interface SnapshotTarget {
  /** The DOM node whose subtree is wanted. */
  readonly backendNodeId: number
  /** How the caller named it, for the error when it is gone. */
  readonly described: string
}

/** One element's box, in the coordinates input is dispatched in. */
export interface Box {
  /** Distance from the viewport's left edge, in CSS pixels. */
  readonly x: number
  /** Distance from the viewport's top edge, in CSS pixels. */
  readonly y: number
  /** Width in CSS pixels. */
  readonly width: number
  /** Height in CSS pixels. */
  readonly height: number
}

/**
 * A question a snapshot answers, instead of printing the whole page.
 *
 * A query is tested against what a line says — role, name, value, and the
 * properties the whitelist prints — so the words a reader can see in a snapshot
 * are the words it can search for.
 */
export interface SnapshotQuery {
  /** The query as the caller wrote it, for the text that reports a miss. */
  readonly described: string
  /**
   * Whether what one node says answers the query.
   * @param fields - what the node says, as the lines that print it say it.
   * @returns whether it matches.
   */
  matches(fields: readonly string[]): boolean
}

/**
 * Read a query the way the tool's `find` parameter writes one.
 *
 * A query wrapped in slashes is a regular expression, for the cases a substring
 * cannot express — `/(sign|log) ?in/i` — and anything else is a substring,
 * matched without regard to case, because a page's capitalisation is not
 * something a caller should have to reproduce from memory.
 * @param query - what the caller asked for.
 * @returns the query to test nodes with.
 * @throws {Error} when a `/…/` query is not a valid expression.
 */
export function parseQuery(query: string): SnapshotQuery {
  const asRegex = /^\/(.*)\/([a-z]*)$/su.exec(query)
  if (asRegex === null) {
    const needle = query.toLowerCase()
    return {
      described: query,
      matches: fields => fields.some(field => field.toLowerCase().includes(needle)),
    }
  }
  const source = asRegex[1] ?? ''
  // `g` and `y` make `test` remember where the last call stopped, so the same
  // query would answer differently for every other node it was tried against.
  const flags = (asRegex[2] ?? '').replace(/[gy]/gu, '')
  let expression: RegExp
  try {
    expression = new RegExp(source, flags.includes('i') ? flags : `${flags}i`)
  } catch (error) {
    throw new Error(
      `dsh-browser: ${query} is not a regular expression `
      + `(${error instanceof Error ? error.message : String(error)}); `
      + 'write plain text to match a substring, or /pattern/flags for an expression',
    )
  }
  return { described: query, matches: fields => fields.some(field => expression.test(field)) }
}

/** What one snapshot produced. */
export interface AxSnapshot {
  /** The tree as text, one node per line. */
  readonly text: string
  /** Ref label to the DOM node it names, for the labels printed here. */
  readonly refs: ReadonlyMap<string, number>
  /** Whether anything was left out, by budget or by depth. */
  readonly truncated: boolean
  /** Lines printed. */
  readonly nodes: number
  /** What was left out, and why. */
  readonly elided: { readonly budget: number; readonly depth: number }
  /** Labels for nodes the page gained since the snapshot before this one. */
  readonly fresh: ReadonlySet<string>
}

/** How a snapshot is bounded and annotated. */
export interface SnapshotOptions {
  /** Most nodes to print before truncating. */
  readonly maxNodes?: number
  /** Deepest level to print, counting the first printed node as 0. */
  readonly depth?: number
  /** Print only this node's subtree. */
  readonly target?: SnapshotTarget
  /** DOM nodes to drop, with their subtrees. */
  readonly ignore?: ReadonlySet<number>
  /** Accessibility properties to print, in this order. */
  readonly attributes?: readonly string[]
  /** Print only what matches this query, with the path that leads to it. */
  readonly find?: SnapshotQuery
  /** Boxes to print beside the elements they belong to, by DOM node. */
  readonly boxes?: ReadonlyMap<number, Box>
  /** The page's label registry; omit for a throwaway one. */
  readonly labels?: RefLabels
}

/** Nodes printed when the caller sets no budget. */
export const DEFAULT_MAX_NODES = 500

/**
 * Properties worth printing unless the caller says otherwise.
 *
 * Deliberately short: `focusable`, `editable`, and `multiline` describe how the
 * tree was built rather than what the page says, and a line is only worth
 * printing if it tells the model something it could not act on anyway.
 */
export const DEFAULT_ATTRIBUTES: readonly string[] = [
  'url', 'level', 'placeholder', 'valuetext', 'roledescription', 'keyshortcuts', 'orientation', 'haspopup', 'description',
]

/** States worth printing, in the order they appear on a line. */
const STATES = ['checked', 'disabled', 'expanded', 'selected', 'required', 'pressed'] as const

/** Roles that are pure text: a rendering detail, never something to act on. */
const TEXT_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ListMarker'])

/** Roles that describe nesting rather than content, when they have no name. */
const STRUCTURAL_ROLES = new Set(['none', 'generic', 'paragraph', 'listitem', 'article', 'list', 'group', 'section'])

/** Longest property value printed before it is cut, in characters. */
const ATTRIBUTE_MAX = 60

/** Render one value for display inside quotes. */
function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Read a CDP value field, which is `unknown` because the protocol allows any type. */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** A node's role, with a placeholder for the nodes that report none. */
function roleOf(node: AxNode): string {
  return text(node.role?.value) || 'node'
}

/** A node's accessible name. */
function nameOf(node: AxNode): string {
  return text(node.name?.value)
}

/**
 * Join two text runs the way a reader would.
 *
 * Runs are separate DOM nodes only because the page marked them up that way;
 * `Hello ` and `bold` are one sentence, while `$` and `12` are one amount. A
 * space appears only where neither side brought one, and never before
 * punctuation that would not take one.
 * @param left - the text so far.
 * @param right - the run being added.
 * @returns the joined text.
 */
function joinRuns(left: string, right: string): string {
  if (left === '') return right
  if (right === '') return left
  return /[\s(\u2014-]$/u.test(left) || /^[\s.,;:!?)\u2014-]/u.test(right) ? left + right : `${left} ${right}`
}

/** The states this node reports, rendered for the line. */
function statesOf(node: AxNode): string {
  const reported = new Map<string, string>()
  for (const property of node.properties ?? []) {
    if (property.name === undefined) continue
    reported.set(property.name, text(property.value?.value))
  }
  const rendered: string[] = []
  for (const name of STATES) {
    const value = reported.get(name)
    if (value === 'true') rendered.push(`[${name}]`)
    // Only `checked` and `pressed` have a third state worth showing; a false
    // `expanded` is the default and would be noise on every line.
    else if (value === 'mixed') rendered.push(`[${name}=mixed]`)
  }
  return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`
}

/** Whether a node reports a state worth keeping it for. */
function hasStates(node: AxNode): boolean {
  return statesOf(node) !== ''
}

/** The properties the whitelist asked for, in the whitelist's order. */
function attributesOf(node: AxNode, whitelist: readonly string[]): [string, string][] {
  if (whitelist.length === 0) return []
  const reported = new Map<string, string>()
  for (const property of node.properties ?? []) {
    if (property.name === undefined) continue
    reported.set(property.name, text(property.value?.value))
  }
  const rendered: [string, string][] = []
  for (const name of whitelist) {
    if ((STATES as readonly string[]).includes(name)) continue
    const value = name === 'description' ? text(node.description?.value) : reported.get(name)
    if (value === undefined || value === '') continue
    rendered.push([name, value.length > ATTRIBUTE_MAX ? `${value.slice(0, ATTRIBUTE_MAX)}…` : value])
  }
  return rendered
}

/** One node rendered as its own line, without indentation. */
function lineOf(
  node: AxNode,
  ref: string | undefined,
  whitelist: readonly string[],
  fresh: boolean,
  box?: Box,
): string {
  const name = nameOf(node)
  const value = text(node.value?.value)
  let line = `- ${roleOf(node)}`
  if (name !== '') line += ` ${quoted(name)}`
  if (value !== '') line += ` value=${quoted(value)}`
  // A property that only repeats the name or the value spends a line's worth of
  // attention without adding anything to it; the same goes for a value another
  // property already printed.
  const said = new Set([name, value].filter(entry => entry !== ''))
  for (const [key, attributeValue] of attributesOf(node, whitelist)) {
    if (said.has(attributeValue)) continue
    said.add(attributeValue)
    line += ` ${key}=${quoted(attributeValue)}`
  }
  line += statesOf(node)
  if (ref !== undefined) line += ` ${fresh ? '*' : ''}[ref=${ref}]`
  // Where the element is, in the pixels a click would use. Only elements that
  // report a box get one: an element the page puts nowhere has no position,
  // and printing `0,0` would read as the top-left corner of the page.
  if (box !== undefined) {
    line += ` box=${String(box.x)},${String(box.y)} ${String(box.width)}x${String(box.height)}`
  }
  return line
}

/** What one node says, for a query to test. */
function fieldsOf(node: AxNode, whitelist: readonly string[]): string[] {
  return [
    roleOf(node),
    nameOf(node),
    text(node.value?.value),
    ...attributesOf(node, whitelist).map(([, value]) => value),
  ].filter(field => field !== '')
}

/**
 * The refs one page hands out.
 *
 * Labels are stable for as long as the page is loaded: a node that already has
 * one keeps it however much appears above it, which is what makes a ref worth
 * remembering and what stops a new snapshot from invalidating the refs of the
 * last one. The role and name are kept beside the label so an action can look
 * for the element again after the DOM replaced it.
 *
 * Numbering runs across the pages one browser shows, not per page. A page that
 * goes away has its labels forgotten, but the next page starts counting where
 * it stopped, because a ref a caller kept is only a string: if the new page
 * minted `e1` again, that string would name one element on the new page and had
 * named another on the old one, and nothing could tell the two apart.
 */
export class RefLabels {
  private readonly byNode = new Map<number, { label: string; role: string; name: string }>()
  private readonly byLabel = new Map<string, number>()
  private next = 1
  /** Every DOM node the page held at the last snapshot, for deciding novelty. */
  private present: ReadonlySet<number> | undefined

  /**
   * The label for one DOM node, minting one the first time it is asked for.
   * @param backendNodeId - the DOM node behind the line.
   * @param role - the role the node reports now.
   * @param name - the accessible name the node reports now.
   * @returns the label, and whether the page gained this node since the last
   * snapshot — a node a depth limit or a budget kept out of the text was there
   * all along, and calling that new would send a model looking for a change it
   * made itself by asking for more of the page.
   */
  labelFor(backendNodeId: number, role: string, name: string): { label: string; fresh: boolean } {
    const existing = this.byNode.get(backendNodeId)
    if (existing !== undefined) {
      // The node is the same node; its name is whatever it says now.
      existing.role = role
      existing.name = name
      return { label: existing.label, fresh: false }
    }
    const label = `e${String(this.next)}`
    this.next += 1
    this.byNode.set(backendNodeId, { label, role, name })
    this.byLabel.set(label, backendNodeId)
    return { label, fresh: this.present !== undefined && !this.present.has(backendNodeId) }
  }

  /**
   * What a label names.
   * @param label - a ref label.
   * @returns the DOM node and its recorded semantics, or `undefined`.
   */
  targetOf(label: string): RefTarget | undefined {
    const backendNodeId = this.byLabel.get(label)
    if (backendNodeId === undefined) return undefined
    const entry = this.byNode.get(backendNodeId)
    if (entry === undefined) return undefined
    return { backendNodeId, role: entry.role, name: entry.name }
  }

  /**
   * Point a label at the node that now stands for it.
   * @param label - the label to re-point.
   * @param target - the node that replaced the one the label named.
   */
  rebind(label: string, target: RefTarget): void {
    const previous = this.byLabel.get(label)
    if (previous !== undefined) this.byNode.delete(previous)
    // A node has exactly one label; a second one would let two labels drift
    // apart while naming the same element.
    for (const [backendNodeId, entry] of this.byNode) {
      if (backendNodeId === target.backendNodeId) this.byLabel.delete(entry.label)
    }
    this.byNode.set(target.backendNodeId, { label, role: target.role, name: target.name })
    this.byLabel.set(label, target.backendNodeId)
  }

  /** Every label this page has handed out. */
  entries(): ReadonlyMap<string, number> {
    const entries = new Map<string, number>()
    for (const [backendNodeId, entry] of this.byNode) entries.set(entry.label, backendNodeId)
    return entries
  }

  /** How many labels this page has handed out. */
  get size(): number {
    return this.byNode.size
  }

  /**
   * Forget a page that is no longer loaded.
   *
   * The number the next page starts from deliberately carries on from here.
   * Forgetting the labels is what makes a ref from the page before stop working;
   * restarting the count would instead hand that ref to whatever the new page
   * puts in its place, and a caller has no way to tell the difference.
   */
  forgetPage(): void {
    this.byNode.clear()
    this.byLabel.clear()
    this.present = undefined
  }

  /**
   * Record the DOM nodes the page held when a snapshot was taken.
   *
   * Novelty is decided against this rather than against what the last snapshot
   * printed. A depth limit or a budget leaves nodes out of the text without
   * their having appeared since, and a `*` has to mean the page changed.
   * @param present - the DOM nodes the accessibility tree held at the time.
   */
  observe(present: Iterable<number>): void {
    this.present = new Set(present)
  }
}

/** Whether a node is hidden from assistive technology, children included. */
function hiddenFromAt(node: AxNode): boolean {
  return (node.ignoredReasons ?? []).some(
    reason => reason.name === 'ariaHiddenSubtree' || reason.name === 'ariaHiddenElement',
  )
}

/**
 * The ref target a node makes, when it has a DOM node behind it.
 *
 * This is the same reading a printed line uses, which is what lets an action
 * look for an element again by what the snapshot said about it.
 * @param node - one node of the accessibility tree.
 * @returns the DOM node and its semantics, or `undefined` for a node with neither.
 */
export function refTargetOf(node: AxNode): RefTarget | undefined {
  if (node.backendDOMNodeId === undefined || node.ignored === true) return undefined
  return { backendNodeId: node.backendDOMNodeId, role: roleOf(node), name: nameOf(node) }
}

/**
 * Print an accessibility tree.
 *
 * Traversal is depth-first in the tree's own child order. Nodes the filters drop
 * are not counted as elided — they were never part of the page as described —
 * but nodes the budget or the depth limit left out are, and the text says which
 * parameter would have printed them.
 * @param nodes - the flat node list CDP returns.
 * @param options - budget, depth, target subtree, filters, and label registry.
 * @returns the text, the labels it used, and what it left out.
 */
export function formatAxTree(nodes: readonly AxNode[], options: SnapshotOptions = {}): AxSnapshot {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const whitelist = options.attributes ?? DEFAULT_ATTRIBUTES
  const depthLimit = options.depth
  const ignore = options.ignore
  const labels = options.labels ?? new RefLabels()

  const byId = new Map<string, AxNode>()
  const present = new Set<number>()
  for (const node of nodes) {
    if (node.nodeId !== undefined) byId.set(node.nodeId, node)
    if (node.backendDOMNodeId !== undefined) present.add(node.backendDOMNodeId)
  }
  const isChild = new Set<string>()
  for (const node of nodes) {
    for (const child of node.childIds ?? []) isChild.add(child)
  }
  // A node nothing claims as a child is a root. Chrome returns one, but a
  // partial tree (a subtree query) can return several, and every node has to be
  // reachable or the page would be described only in part.
  const roots = nodes.filter(node => node.nodeId === undefined || !isChild.has(node.nodeId))

  /** Children of a node, in order, resolved through the flat list. */
  const childrenOf = (node: AxNode): AxNode[] => {
    const children: AxNode[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child !== undefined) children.push(child)
    }
    return children
  }

  /** Whether this node is dropped with its whole subtree rather than promoted. */
  const dropWholeSubtree = (node: AxNode): boolean => {
    if (hiddenFromAt(node)) return true
    return ignore !== undefined && node.backendDOMNodeId !== undefined && ignore.has(node.backendDOMNodeId)
  }

  /** Whether a node survives every filter except the grouping rule. */
  const passesFilters = (node: AxNode, ancestors: readonly string[]): boolean => {
    if (node.ignored === true || dropWholeSubtree(node)) return false
    const role = roleOf(node)
    if (TEXT_ROLES.has(role)) return false
    const name = nameOf(node)
    const value = text(node.value?.value)
    // A run of text an ancestor already says adds nothing; the ancestor's line
    // is what a reader hears, and it is printed above this one.
    if (role === 'StaticText') return name !== '' && !ancestors.some(ancestor => ancestor.includes(name))
    if (role === 'image' && value === '' && !hasStates(node)) {
      return name !== '' && !ancestors.some(ancestor => ancestor.includes(name))
    }
    return true
  }

  // First pass: how many lines each subtree would print. A nameless wrapper is
  // only worth a line when it groups several of them; one that groups a single
  // child says nothing the indentation does not already say.
  const units = new Map<AxNode, number>()
  const printable = new Set<AxNode>()
  /** Measure one node's subtree, counting consecutive text runs as one line. */
  const measure = (node: AxNode, ancestors: readonly string[]): void => {
    const hidden = dropWholeSubtree(node)
    const name = nameOf(node)
    const childAncestors = name === '' ? ancestors : [...ancestors, name]
    let total = 0
    if (!hidden) {
      let runOpen = false
      for (const child of childrenOf(node)) {
        if (roleOf(child) === 'StaticText' && passesFilters(child, childAncestors)) {
          // Consecutive runs print as one line, so they count as one — but each
          // of them is printable, because that is what the printer walks.
          printable.add(child)
          if (!runOpen) total += 1
          runOpen = true
          continue
        }
        runOpen = false
        measure(child, childAncestors)
        total += (printable.has(child) ? 1 : 0) + (units.get(child) ?? 0)
      }
    }
    units.set(node, total)
    if (!hidden && passesFilters(node, ancestors)) {
      const wrapper = name === '' && text(node.value?.value) === '' && !hasStates(node)
        && STRUCTURAL_ROLES.has(roleOf(node))
      if (!wrapper || total > 1) printable.add(node)
    }
  }

  const start = options.target === undefined
    ? roots
    : [targetNode(nodes, options.target)]
  for (const root of start) measure(root, [])

  /**
   * The text of the run of consecutive text nodes that starts at one sibling.
   *
   * Consecutive runs print as one line, so the words a reader sees are the run's
   * rather than any one node's; both the printer and a query have to read them
   * the same way, which is why this is written once.
   * @param children - the siblings.
   * @param index - where the run starts.
   * @returns the merged text, and the index after the last node in the run.
   */
  const runAt = (children: readonly AxNode[], index: number): { text: string; end: number } => {
    let text = nameOf(children[index] ?? {})
    let next = index + 1
    while (next < children.length) {
      const following = children[next]
      if (following === undefined || roleOf(following) !== 'StaticText' || !printable.has(following)) break
      text = joinRuns(text, nameOf(following))
      next += 1
    }
    return { text, end: next }
  }

  /** The line each text run prints as, by node. */
  const runText = new Map<AxNode, string>()
  const collectRuns = (node: AxNode): void => {
    const children = childrenOf(node)
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (child === undefined) continue
      if (roleOf(child) === 'StaticText' && printable.has(child)) {
        const run = runAt(children, index)
        for (let member = index; member < run.end; member += 1) {
          const part = children[member]
          if (part !== undefined) runText.set(part, run.text)
        }
        index = run.end - 1
        continue
      }
      collectRuns(child)
    }
  }
  for (const root of start) collectRuns(root)

  // A query turns the tree into the paths that answer it. Every ancestor of a
  // match is wanted too: a matching link with no list above it does not say
  // where in the page it is, which is half of what a reader needs.
  let wanted: ReadonlySet<AxNode> | undefined
  let matched = 0
  if (options.find !== undefined) {
    const query = options.find
    const matches = new Set<AxNode>()
    const ancestors = new Set<AxNode>()
    const walk = (candidate: AxNode, path: readonly AxNode[]): void => {
      // Only what a snapshot would print can be a match: a node the filters
      // drop is noise or a duplicate of an ancestor's words, and that ancestor
      // is where a reader would see the text anyway.
      if (printable.has(candidate)) {
        const run = runText.get(candidate)
        const fields = run === undefined ? fieldsOf(candidate, whitelist) : [run, ...fieldsOf(candidate, whitelist)]
        if (query.matches(fields)) {
          matches.add(candidate)
          for (const ancestor of path) ancestors.add(ancestor)
        }
      }
      for (const child of childrenOf(candidate)) walk(child, [...path, candidate])
    }
    for (const root of start) walk(root, [])
    wanted = new Set([...matches, ...ancestors])
    matched = matches.size
  }

  const lines: string[] = []
  const refs = new Map<string, number>()
  const fresh = new Set<string>()
  let nodesPrinted = 0
  let budgetElided = 0
  let depthElided = 0

  /** Print one line for a node, or count it as elided. */
  const emit = (node: AxNode, depth: number, below: number, force = false): boolean => {
    // A node no path to a match runs through is not elided, it is not wanted:
    // counting it would make every narrow query look like a truncated page.
    if (wanted !== undefined && !wanted.has(node)) return false
    if (!force && !printable.has(node)) return false
    if (depthLimit !== undefined && depth > depthLimit) {
      depthElided += 1 + below
      return false
    }
    if (nodesPrinted >= maxNodes) {
      budgetElided += 1 + below
      return false
    }
    const backendNodeId = node.backendDOMNodeId
    let ref: string | undefined
    if (backendNodeId !== undefined && roleOf(node) !== 'StaticText' && !TEXT_ROLES.has(roleOf(node))) {
      const labelled = labels.labelFor(backendNodeId, roleOf(node), nameOf(node))
      ref = labelled.label
      refs.set(labelled.label, backendNodeId)
      if (labelled.fresh) fresh.add(labelled.label)
    }
    const box = backendNodeId === undefined ? undefined : options.boxes?.get(backendNodeId)
    lines.push(`${'  '.repeat(depth)}${lineOf(node, ref, whitelist, ref !== undefined && fresh.has(ref), box)}`)
    nodesPrinted += 1
    return true
  }

  /** Print the children of a node, promoting the children of the dropped ones. */
  const printChildren = (node: AxNode, childDepth: number): void => {
    const children = childrenOf(node)
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (child === undefined) continue
      if (!printable.has(child)) {
        // Dropped: its printable descendants take its place, at its own depth.
        if (!dropWholeSubtree(child)) printChildren(child, childDepth)
        continue
      }
      if (wanted !== undefined && !wanted.has(child)) continue
      if (roleOf(child) === 'StaticText') {
        // Text runs that sit next to each other read as one line, so the whole
        // run is gathered before anything is printed or counted.
        const run = runAt(children, index)
        index = run.end - 1
        if (depthLimit !== undefined && childDepth > depthLimit) depthElided += 1
        else if (nodesPrinted >= maxNodes) budgetElided += 1
        else {
          lines.push(`${'  '.repeat(childDepth)}- StaticText ${quoted(run.text)}`)
          nodesPrinted += 1
        }
        continue
      }
      const below = units.get(child) ?? 0
      if (emit(child, childDepth, below)) printChildren(child, childDepth + 1)
    }
  }

  for (const root of start) {
    // The node the caller asked for is printed whatever it is; anything else
    // that groups nothing is dropped and its children take its place.
    const forced = options.target !== undefined && root === start[0]
    const below = units.get(root) ?? 0
    if (emit(root, 0, below, forced)) printChildren(root, 1)
    else if (!printable.has(root)) printChildren(root, 0)
  }

  const notes: string[] = []
  if (options.find !== undefined) {
    if (matched === 0) {
      notes.push(
        `Nothing in the page matches ${JSON.stringify(options.find.described)}; a query is tested against `
        + 'the text a snapshot prints, so take one to see what the page says',
      )
    } else {
      notes.push(
        `… ${String(matched)} node${matched === 1 ? '' : 's'} ${matched === 1 ? 'matches' : 'match'} `
        + `${JSON.stringify(options.find.described)}; take target="<ref>" for one match's subtree, `
        + 'or drop find to read the whole page',
      )
    }
  }
  if (budgetElided > 0) {
    notes.push(
      `… ${String(budgetElided)} more nodes were not printed; take a narrower snapshot with `
      + 'target="<ref or CSS selector>" for one subtree, or depth=<n> to stop at a level',
    )
  }
  if (depthElided > 0) {
    notes.push(
      `… ${String(depthElided)} nodes are deeper than depth=${String(depthLimit ?? 0)}`
      + ' and were not printed; raise depth to see them',
    )
  }
  const body = lines.join('\n')
  const note = notes.join('\n')

  labels.observe(present)
  return {
    text: note === '' ? body : body === '' ? note : `${body}\n\n${note}`,
    refs,
    truncated: budgetElided > 0 || depthElided > 0,
    nodes: nodesPrinted,
    elided: { budget: budgetElided, depth: depthElided },
    fresh,
  }
}

/**
 * The AX node behind a target.
 * @param nodes - the flat node list CDP returned.
 * @param target - the node the caller named.
 * @returns the node to print from.
 * @throws {Error} when the tree holds no node for that DOM node.
 */
function targetNode(nodes: readonly AxNode[], target: SnapshotTarget): AxNode {
  const found = nodes.find(node => node.backendDOMNodeId === target.backendNodeId)
  if (found === undefined) {
    throw new Error(
      `dsh-browser: ${target.described} has no node in the accessibility tree; `
      + 'take a snapshot of the whole page and pick a ref from it',
    )
  }
  return found
}

/**
 * The centre of a content quad, in the coordinates CDP reported it in.
 *
 * A quad is four corner pairs; their average is a point inside the element for
 * every quad a browser produces, including one rotated by a CSS transform,
 * where the midpoint of the bounding box would be outside it.
 * @param quad - eight numbers, `x1 y1 x2 y2 x3 y3 x4 y4`.
 * @returns the centre point.
 */
export function centerOfQuad(quad: readonly number[]): { x: number; y: number } {
  const points: { x: number; y: number }[] = []
  for (let index = 0; index + 1 < quad.length; index += 2) {
    points.push({ x: quad[index] ?? 0, y: quad[index + 1] ?? 0 })
  }
  if (points.length === 0) throw new Error('dsh-browser: the element reported no box to click')
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}
