/**
 * Every session's browser needs its own external CDP port, and the configured
 * one is only the first candidate: two sessions cannot both listen on 9333.
 * The allocator hands out the lowest port that nothing else holds, and holds it
 * for the caller until the browser using it is gone.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { test } from 'node:test'
import { canBind, PortAllocator, PORT_SCAN_RANGE } from '../src/browser/ports.ts'

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

test('a free base port is the one handed out', async () => {
  const allocator = new PortAllocator(9333, [], async () => true)
  assert.equal(await allocator.allocate(), 9333)
})

test('ports another process holds are skipped', async () => {
  const allocator = new PortAllocator(9333, [], async port => port !== 9333 && port !== 9334)
  assert.equal(await allocator.allocate(), 9335)
})

test('two allocations never return the same port', async () => {
  const allocator = new PortAllocator(9333, [], async () => true)
  const first = await allocator.allocate()
  const second = await allocator.allocate()
  assert.notEqual(first, second)
})

test('an allocation made concurrently still lands on distinct ports', async () => {
  const allocator = new PortAllocator(9333, [], async () => true)
  const ports = await Promise.all([allocator.allocate(), allocator.allocate(), allocator.allocate()])
  assert.deepEqual([...new Set(ports)].length, 3)
})

test('a released port becomes available again', async () => {
  const allocator = new PortAllocator(9333, [], async () => true)
  const first = await allocator.allocate()
  allocator.release(first)
  assert.equal(await allocator.allocate(), first)
})

test('a port already known to be held is not probed', async () => {
  const probed: number[] = []
  const allocator = new PortAllocator(9333, [9333, 9334], async (port) => { probed.push(port); return true })
  assert.equal(await allocator.allocate(), 9335)
  assert.deepEqual(probed, [9335])
})

test('exhausting the scan range fails naming the ports that were tried', async () => {
  const allocator = new PortAllocator(9333, [], async () => false)
  const last = 9333 + PORT_SCAN_RANGE - 1
  await assert.rejects(() => allocator.allocate(), new RegExp(`9333-${last}`))
})

test('a real listener is reported as unbindable and skipped', async () => {
  const held = await occupy()
  try {
    assert.equal(await canBind(held.port), false)
    const allocator = new PortAllocator(held.port)
    const assigned = await allocator.allocate()
    assert.notEqual(assigned, held.port)
    assert.ok(assigned > held.port && assigned <= held.port + PORT_SCAN_RANGE)
  } finally {
    await held.release()
  }
})
