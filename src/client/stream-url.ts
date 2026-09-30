/**
 * Where the viewer socket dials.
 *
 * The mirror is a WebSocket to the plugin's own host half, so what it needs is
 * the Host's origin rather than the document's. A Web page is served by that
 * Host and the two agree; a Desktop window is a `dsh-app://app` document, whose
 * `location.host` is the scheme's own `app` and reaches no Host at all. The shell
 * publishes the Host's HTTP origin as `__DSH_TRANSPORT__.streamBaseUrl`, and
 * Desktop attaches the Host's authentication cookie to a `ws://127.0.0.1/*`
 * handshake from that window — the seam the Gateway's own mux socket uses.
 *
 * HTTP stays relative: the Desktop scheme forwards it to the Host with the
 * cookie already, and an absolute cross-origin call would meet the trust fence.
 */

/** The transport descriptor the shell publishes for the page it serves. */
interface ClientTransport {
  readonly streamBaseUrl?: string
}

/**
 * Origin of the Host this page belongs to.
 * @returns the shell-published origin, or the document's own when it names none.
 */
export function hostOrigin(): string {
  const transport = globalThis as { __DSH_TRANSPORT__?: ClientTransport }
  const base = transport.__DSH_TRANSPORT__?.streamBaseUrl
  return base === undefined || base === '' ? location.origin : base
}

/**
 * Absolute address of one of the Host's WebSocket routes.
 * @param path - Host-absolute path, e.g. `/dsh-browser/stream`.
 * @param query - parameters to carry in the handshake.
 * @returns the `ws:`/`wss:` address to dial.
 */
export function streamUrl(path: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(path, hostOrigin())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return url.href
}
