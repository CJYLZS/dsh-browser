/**
 * Hand out one external CDP port per browser.
 *
 * The configured port is a starting point rather than an address: the first
 * session's browser takes it, and the next one probes upward, because a second
 * listener on the same port cannot exist. Probing binds the port and releases
 * it, which is the only way to ask the operating system — and because the
 * answer is stale the moment it is given, an allocator also *holds* each port
 * it hands out until its browser is gone.
 *
 * The window is bounded on purpose. A browser that cannot listen inside it is a
 * failure worth reporting, not a reason to walk the whole range.
 */
import { createServer } from 'node:net'

/** How many ports above the base are tried before failing. */
export const PORT_SCAN_RANGE = 100

/** Decides whether one port could be listened on right now. */
export type PortProbe = (port: number) => Promise<boolean>

/**
 * Ask the operating system whether a port is free on loopback.
 *
 * The listener is closed again before this resolves, so the answer is about
 * availability at this instant; callers that need the port for longer hold it
 * through {@link PortAllocator}.
 * @param port - the port to test.
 * @returns whether the port could be bound.
 */
export async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.once('listening', () => {
      server.close(() => { resolve(true) })
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Assigns CDP ports and remembers which ones are spoken for.
 *
 * Allocation is serialised: two sessions asking at the same time would
 * otherwise both see the same port free and both take it.
 */
export class PortAllocator {
  private readonly held: Set<number>
  private pending: Promise<unknown> = Promise.resolve()
  private base: number
  private readonly probe: PortProbe

  /**
   * @param base - the configured first port.
   * @param taken - ports known to be in use already.
   * @param probe - availability test, replaced in tests.
   */
  constructor(base: number, taken: Iterable<number> = [], probe: PortProbe = canBind) {
    this.base = base
    this.held = new Set(taken)
    this.probe = probe
  }

  /**
   * Take the lowest free port.
   * @returns the port, held for this allocator until {@link release}.
   * @throws {Error} when no port in the scan range is free.
   */
  async allocate(): Promise<number> {
    const attempt = this.pending.then(async () => await this.search())
    this.pending = attempt.catch(() => {})
    return await attempt
  }

  /**
   * Give a port back, so a later browser may take it.
   * @param port - the port whose browser is gone.
   */
  release(port: number): void {
    this.held.delete(port)
  }

  /**
   * Change where the next search starts, after the configured port changed.
   *
   * Ports already held stay held: the browsers listening on them are still
   * running, whatever the configuration now says.
   * @param base - the newly configured first port.
   */
  setBase(base: number): void {
    this.base = base
  }

  /** Ports currently held, for diagnostics. */
  get heldPorts(): readonly number[] {
    return [...this.held]
  }

  /** Probe upward until a port answers free. */
  private async search(): Promise<number> {
    for (let offset = 0; offset < PORT_SCAN_RANGE; offset++) {
      const port = this.base + offset
      if (port > 65_535) break
      if (this.held.has(port)) continue
      if (!await this.probe(port)) continue
      this.held.add(port)
      return port
    }
    throw new Error(
      `dsh-browser: no free port for the CDP listener in ${this.base}-${this.base + PORT_SCAN_RANGE - 1}; `
      + 'another process holds them, or too many session browsers are running',
    )
  }
}
