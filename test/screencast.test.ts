/**
 * The screencast has one rule that silently breaks the mirror when it is
 * missed: every frame must be acknowledged or Chrome stops sending. These
 * tests hold that, the base64 decoding, and the teardown order.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startScreencast, type MirrorFrame } from '../src/browser/screencast.ts'
import { fakeCdp } from './support/cdp.ts'

/** The encoding every test starts with, so the assertions are about frames. */
const OPTIONS = { quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }

test('starting sends the encoding settings to CDP', async () => {
  const cdp = fakeCdp()
  await startScreencast(cdp.session, OPTIONS, () => {}, () => {})
  assert.deepEqual(cdp.method('Page.startScreencast')[0]?.params, {
    format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1,
  })
})

test('a frame is decoded, forwarded with its dimensions, and acknowledged', async () => {
  const cdp = fakeCdp()
  const frames: MirrorFrame[] = []
  await startScreencast(cdp.session, OPTIONS, frame => frames.push(frame), () => {})
  cdp.emit('Page.screencastFrame', {
    data: Buffer.from('jpeg bytes').toString('base64'),
    sessionId: 7,
    metadata: { deviceWidth: 1280, deviceHeight: 720 },
  })
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.jpeg.toString(), 'jpeg bytes')
  assert.equal(frames[0]?.deviceWidth, 1280)
  assert.equal(frames[0]?.deviceHeight, 720)
  assert.deepEqual(cdp.method('Page.screencastFrameAck')[0]?.params, { sessionId: 7 })
})

test('a frame without dimensions is still forwarded', async () => {
  const cdp = fakeCdp()
  const frames: MirrorFrame[] = []
  await startScreencast(cdp.session, OPTIONS, frame => frames.push(frame), () => {})
  cdp.emit('Page.screencastFrame', { data: '', sessionId: 1 })
  assert.deepEqual(frames, [{ jpeg: Buffer.from(''), deviceWidth: 0, deviceHeight: 0 }])
})

test('a refused acknowledgement is reported without ending the stream', async () => {
  const cdp = fakeCdp()
  cdp.failWith('Page.screencastFrameAck', 'the session is gone')
  const errors: unknown[] = []
  const frames: MirrorFrame[] = []
  await startScreencast(cdp.session, OPTIONS, frame => frames.push(frame), error => errors.push(error))
  cdp.emit('Page.screencastFrame', { data: '', sessionId: 1 })
  await Promise.resolve()
  assert.equal(frames.length, 1)
  assert.match(String(errors[0]), /the session is gone/)
})

test('stopping detaches the listener before asking Chrome to stop', async () => {
  const cdp = fakeCdp()
  const frames: MirrorFrame[] = []
  const stop = await startScreencast(cdp.session, OPTIONS, frame => frames.push(frame), () => {})
  await stop()
  cdp.emit('Page.screencastFrame', { data: '', sessionId: 1 })
  assert.deepEqual(frames, [])
  assert.equal(cdp.method('Page.stopScreencast').length, 1)
})
