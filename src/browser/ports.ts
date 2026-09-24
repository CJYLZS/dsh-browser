/**
 * Hand out one external CDP port per browser.
 *
 * The configuration names a *window* of ports rather than an address: every
 * session gets its own browser, every browser needs its own port, and the first
 * session's browser takes the lowest free port in the window while the next one
 * takes the next. Probing binds the port and releases it, which is the only way
 * to ask the operating system — and because the answer is stale the moment it is
 * given, an allocator also *holds* each port it hands out until its browser is
 * gone.
 *
 * The window is bounded on purpose. A browser that cannot listen inside it is a
 * failure worth reporting, and the message names the window so a deployment can
 * widen it — walking past the top would collide with whatever else this machine
 * runs, which is exactly what the end is there to prevent.
 */
import { createServer } from 'node:net'

/** The ports session browsers may listen on, both ends included. */
export interface PortWindow {
  /** Lowest port in the window. */
  readonly low: number
  /** Highest port in the window. */
  readonly high: number
}

/**
 * Read a window from its two configured ends.
 *
 * The ends are sorted rather than validated: a deployment that fills the two
 * boxes the other way round means the same window, and refusing to start a
 * browser over it would be a worse answer than using it.
 * @param first - one end of the window.
 * @param second - the other end.
 * @returns the window, lowest end first.
 */
export function portWindow(first: number, second: number): PortWindow {
  return first <= second ? { low: first, high: second } : { low: second, high: first }
}

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
  private range: PortWindow
  private readonly probe: PortProbe

  /**
   * @param range - the window to search.
   * @param taken - ports known to be in use already.
   * @param probe - availability test, replaced in tests.
   */
  constructor(range: PortWindow, taken: Iterable<number> = [], probe: PortProbe = canBind) {
    this.range = range
    this.held = new Set(taken)
    this.probe = probe
  }

  /**
   * Take the lowest free port.
   * @returns the port, held for this allocator until {@link release}.
   * @throws {Error} when nothing in the window is free.
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
   * Move the window, after the configured range changed.
   *
   * Ports already held stay held: the browsers listening on them are still
   * running, whatever the configuration now says, and they come back only when
   * those browsers close.
   * @param range - the newly configured window.
   */
  setWindow(range: PortWindow): void {
    this.range = range
  }

  /** The window currently searched. */
  get window(): PortWindow {
    return this.range
  }

  /** Ports currently held, for diagnostics. */
  get heldPorts(): readonly number[] {
    return [...this.held]
  }

  /** Probe the window from its lowest end upwards. */
  private async search(): Promise<number> {
    for (let port = this.range.low; port <= this.range.high && port <= 65_535; port++) {
      if (this.held.has(port)) continue
      if (!await this.probe(port)) continue
      this.held.add(port)
      return port
    }
    throw new Error(
      `dsh-browser: no free CDP port in ${this.range.low}-${this.range.high}; `
      + 'another process holds them, or the window is narrower than the number of session browsers',
    )
  }
}
