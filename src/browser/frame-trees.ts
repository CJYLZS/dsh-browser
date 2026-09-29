/**
 * Splice child frames' accessibility trees into the page's own.
 *
 * Chrome answers the page-level tree with every iframe element carrying no
 * children — measured 2026-09-29 on a same-origin pair, the `Iframe` nodes'
 * `childIds` are `[]` — because each frame's tree is a separate answer. The
 * content of a same-process frame is fetched per frame (`frameId`) and spliced
 * in at the element that owns it (`DOM.getFrameOwner` returns that element's
 * node), which is what makes a frame's controls visible, ref-able, and
 * clickable like any other element's. A frame in another process cannot be
 * reached by this session's connection; its nodes are left out rather than
 * guessed at, and so is a frame whose owner the page's own tree does not
 * describe — hanging them at the top would print frame content as page content.
 */
import type { AxNode } from './aria.ts'

/** One child frame's tree, and the DOM node that owns the frame. */
export interface FrameTree {
  /** The `backendDOMNodeId` of the element that owns the frame. */
  readonly ownerBackendNodeId: number
  /** The frame's own flat node list, as CDP answered it. */
  readonly nodes: readonly AxNode[]
}

/**
 * Splice the frames' trees into the page's own flat list.
 * @param root - the page's own flat node list.
 * @param frames - each child frame's tree with the node that owns it, parents
 * before children, so a nested frame's owner is already in the list.
 * @returns one flat list: the page's tree with each frame's tree hanging under
 * the element that owns it, node ids rewritten so frames cannot collide.
 */
export function mergeFrameTrees(root: readonly AxNode[], frames: readonly FrameTree[]): AxNode[] {
  const merged = [...root]
  for (const [index, frame] of frames.entries()) {
    const prefix = `frame${String(index)}:`
    const renamed = new Map<string, string>()
    for (const node of frame.nodes) {
      if (node.nodeId !== undefined) renamed.set(node.nodeId, prefix + node.nodeId)
    }
    // A frame's own roots are what nothing in it claims as a child, and they
    // are what hangs under the element that owns the frame.
    const claimed = new Set<string>()
    for (const node of frame.nodes) {
      for (const child of node.childIds ?? []) claimed.add(child)
    }
    const roots: string[] = []
    for (const node of frame.nodes) {
      if (node.nodeId === undefined || claimed.has(node.nodeId)) continue
      const id = renamed.get(node.nodeId)
      if (id !== undefined) roots.push(id)
    }
    if (roots.length === 0) continue
    const at = merged.findIndex(node => node.backendDOMNodeId === frame.ownerBackendNodeId)
    // Without the owner there is nowhere to hang the frame's content, and
    // nothing claimed as a child would print it at the top of the page.
    if (at === -1) continue
    const owner = merged[at]
    if (owner === undefined) continue
    merged[at] = { ...owner, childIds: [...(owner.childIds ?? []), ...roots] }
    for (const node of frame.nodes) {
      const nodeId = node.nodeId === undefined ? undefined : renamed.get(node.nodeId)
      merged.push({
        ...node,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(node.childIds === undefined ? {} : {
          childIds: node.childIds.map(child => renamed.get(child) ?? child),
        }),
      })
    }
  }
  return merged
}
