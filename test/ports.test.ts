/**
 * Every session's browser needs its own external CDP port, so one configured
 * number could never be the address: the configuration names a *window* of ports
 * and the allocator hands out the lowest one inside it that nothing else holds,
 * keeping it for the caller until the browser using it is gone.
 *
 * The window's upper end is what keeps a search from wandering into whatever
 * else the machine runs, so these tests care as much about where allocation
 * stops as about where it starts.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { test } from 'node:test'
import { canBind, portWindow, PortAllocator } from '../src/browser/ports.ts'

/**
 * Take a real port on loopback, the way a running browser would.
 * @returns the port and a stopper releasing it.
 */
async function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  const server: Server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    release: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

test('the lowest free port in the window is handed out', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9340), [], async () => true)
  assert.equal(await allocator.allocate(), 9333)
})

test('ports another process holds are skipped', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9340), [], async port => port !== 9333 && port !== 9334)
  assert.equal(await allocator.allocate(), 9335)
})

test('two allocations never return the same port', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9340), [], async () => true)
  const first = await allocator.allocate()
  const second = await allocator.allocate()
  assert.notEqual(first, second)
})

test('an allocation made concurrently still lands on distinct ports', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9340), [], async () => true)
  const ports = await Promise.all([allocator.allocate(), allocator.allocate(), allocator.allocate()])
  assert.deepEqual([...new Set(ports)].length, 3)
})

test('a released port becomes available again', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9340), [], async () => true)
  const first = await allocator.allocate()
  allocator.release(first)
  assert.equal(await allocator.allocate(), first)
})

test('a port already known to be held is not probed', async () => {
  const probed: number[] = []
  const allocator = new PortAllocator(portWindow(9333, 9340), [9333, 9334], async (port) => { probed.push(port); return true })
  assert.equal(await allocator.allocate(), 9335)
  assert.deepEqual(probed, [9335])
})

test('allocation never looks past the top of the window', async () => {
  const probed: number[] = []
  const allocator = new PortAllocator(portWindow(9333, 9335), [], async (port) => { probed.push(port); return false })
  await assert.rejects(() => allocator.allocate())
  assert.deepEqual(probed, [9333, 9334, 9335])
})

test('an exhausted window fails naming both of its ends', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9335), [], async () => false)
  await assert.rejects(() => allocator.allocate(), /9333-9335/)
})

test('a one-port window allocates that port and then has nothing left', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9333), [], async () => true)
  assert.equal(await allocator.allocate(), 9333)
  await assert.rejects(() => allocator.allocate(), /9333-9333/)
})

test('a window whose ends are given the other way round is the same window', async () => {
  assert.deepEqual(portWindow(9340, 9333), { low: 9333, high: 9340 })
  const allocator = new PortAllocator(portWindow(9340, 9333), [], async () => true)
  assert.equal(await allocator.allocate(), 9333)
})

test('moving the window keeps the ports already handed out', async () => {
  const allocator = new PortAllocator(portWindow(9333, 9334), [], async () => true)
  const first = await allocator.allocate()
  assert.equal(first, 9333)

  allocator.setWindow(portWindow(9400, 9405))

  // The browser on the old port is still running, whatever the configuration
  // now says, so the allocator neither forgets it nor hands it out again.
  assert.deepEqual(allocator.heldPorts, [9333])
  assert.equal(await allocator.allocate(), 9400)
  allocator.release(first)
  assert.deepEqual(allocator.heldPorts, [9400])
})

test('a real listener is reported as unbindable and skipped', async () => {
  const held = await occupy()
  try {
    assert.equal(await canBind(held.port), false)
    const allocator = new PortAllocator(portWindow(held.port, held.port + 5))
    const assigned = await allocator.allocate()
    assert.notEqual(assigned, held.port)
    assert.ok(assigned > held.port && assigned <= held.port + 5)
  } finally {
    await held.release()
  }
})
