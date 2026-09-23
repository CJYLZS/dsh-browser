/**
 * The page as a tree of roles, names, and refs.
 *
 * A model that can only read a page through JavaScript has to know what it is
 * looking at before it can look; this is the other way round. Chrome's
 * accessibility tree is already that description, so it is printed rather than
 * reinterpreted, with two changes that make it usable:
 *
 * - `ref` labels the DOM node behind a line, which is how a later click or type
 *   names its target without inventing a selector that may not survive.
 * - Nodes Chrome marks ignored are dropped and their children promoted, since
 *   they are wrappers that describe nothing.
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
  /** ARIA role. */
  readonly role?: { readonly value?: unknown }
  /** Accessible name. */
  readonly name?: { readonly value?: unknown }
  /** Current value, for roles that carry one. */
  readonly value?: { readonly value?: unknown }
  /** Node states such as `disabled` or `checked`. */
  readonly properties?: readonly {
    readonly name?: string
    readonly value?: { readonly value?: unknown }
  }[]
  /** Ids of this node's children, in order. */
  readonly childIds?: readonly string[]
  /** The DOM node this describes, absent for purely structural nodes. */
  readonly backendDOMNodeId?: number
}

/** What one snapshot produced. */
export interface AxSnapshot {
  /** The tree as text, one node per line. */
  readonly text: string
  /** Ref label to the DOM node it names. */
  readonly refs: ReadonlyMap<string, number>
  /** Whether the node budget cut the tree short. */
  readonly truncated: boolean
}

/** How a snapshot is bounded. */
export interface SnapshotOptions {
  /** Most nodes to print before truncating. */
  readonly maxNodes?: number
}

/** Nodes printed when the caller sets no budget. */
const DEFAULT_MAX_NODES = 300

/** States worth printing, in the order they appear on a line. */
const STATES = ['checked', 'disabled', 'expanded', 'selected', 'required'] as const

/** Render one node's name for display inside quotes. */
function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Read a CDP value field, which is `unknown` because the protocol allows any type. */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
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

/** One node rendered as its own line, without indentation. */
function lineOf(node: AxNode, ref: string | undefined): string {
  const role = text(node.role?.value) || 'node'
  const name = text(node.name?.value)
  const value = text(node.value?.value)
  return `- ${role}${name === '' ? '' : ` ${quoted(name)}`}`
    + `${value === '' ? '' : ` value=${quoted(value)}`}`
    + statesOf(node)
    + `${ref === undefined ? '' : ` [ref=${ref}]`}`
}

/**
 * Print an accessibility tree.
 *
 * Traversal is depth-first in the tree's own child order, which is what makes
 * ref labels stable between two snapshots of an unchanged page. Nodes the
 * caller's budget could not fit are counted, not silently dropped.
 * @param nodes - the flat node list CDP returns.
 * @param options - node budget.
 * @returns the text, the ref labels it used, and whether it truncated.
 */
export function formatAxTree(nodes: readonly AxNode[], options: SnapshotOptions = {}): AxSnapshot {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const byId = new Map<string, AxNode>()
  for (const node of nodes) {
    if (node.nodeId !== undefined) byId.set(node.nodeId, node)
  }
  const isChild = new Set<string>()
  for (const node of nodes) {
    for (const child of node.childIds ?? []) isChild.add(child)
  }
  // A node nothing claims as a child is a root. Chrome returns one, but a
  // partial tree (a subtree query) can return several, and every node has to be
  // reachable or the page would be described only in part.
  const roots = nodes.filter(node => node.nodeId === undefined || !isChild.has(node.nodeId))

  const lines: string[] = []
  const refs = new Map<string, number>()
  let printed = 0
  let skipped = 0

  /**
   * Print one node and its children.
   * @param node - the node to print.
   * @param depth - indentation level.
   */
  const visit = (node: AxNode, depth: number): void => {
    const backendNodeId = node.backendDOMNodeId
    const ref = backendNodeId === undefined || node.ignored === true ? undefined : `e${String(refs.size + 1)}`
    if (node.ignored !== true) {
      if (printed < maxNodes) {
        if (ref !== undefined && backendNodeId !== undefined) refs.set(ref, backendNodeId)
        lines.push(`${'  '.repeat(depth)}${lineOf(node, ref)}`)
        printed += 1
      } else {
        // The walk continues past the budget so the count is of everything the
        // caller did not get, not just this branch.
        skipped += 1
      }
    }
    const childDepth = node.ignored === true ? depth : depth + 1
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child !== undefined) visit(child, childDepth)
    }
  }

  for (const root of roots) visit(root, 0)

  return {
    text: skipped === 0 ? lines.join('\n') : `${lines.join('\n')}\n… ${String(skipped)} more nodes`,
    refs,
    truncated: skipped > 0,
  }
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
