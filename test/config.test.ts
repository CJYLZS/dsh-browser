/**
 * The configuration schema is the plugin's only validated input: it arrives
 * from cordis.yml and from the settings page. These tests hold the defaults
 * deployments rely on and the rejections that keep a bad value from reaching a
 * browser launch.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, type BrowserConfig } from '../src/config.ts'

/** Resolve a partial configuration the way the plugin does at load. */
function resolve(input: Partial<BrowserConfig>): BrowserConfig {
  return Config(input) as BrowserConfig
}

test('an empty configuration resolves to the documented defaults', () => {
  assert.deepEqual(resolve({}), {
    channel: 'chrome',
    executablePath: '',
    headless: true,
    userDataDir: '',
    debugPort: 9333,
    viewportWidth: 1440,
    viewportHeight: 900,
    stealth: true,
    startupUrl: 'about:blank',
    quality: 70,
    maxWidth: 1600,
    maxHeight: 1200,
    everyNthFrame: 1,
    snapshotNodes: 300,
    extraArgs: [],
    maxInstances: 4,
  })
})

test('one field does not disturb the others', () => {
  const resolved = resolve({ headless: false, debugPort: 9222 })
  assert.equal(resolved.headless, false)
  assert.equal(resolved.debugPort, 9222)
  assert.equal(resolved.quality, 70)
  assert.equal(resolved.channel, 'chrome')
})

test('extraArgs defaults to a fresh array per resolve', () => {
  const first = resolve({})
  first.extraArgs.push('--leaked')
  assert.deepEqual(resolve({}).extraArgs, [])
})

test('a port outside the TCP range is rejected', () => {
  assert.throws(() => resolve({ debugPort: 70_000 }))
  assert.throws(() => resolve({ debugPort: -1 }))
})

test('a JPEG quality outside 1-100 is rejected', () => {
  assert.throws(() => resolve({ quality: 101 }))
  assert.throws(() => resolve({ quality: 0 }))
})

test('an unknown browser channel is rejected', () => {
  assert.throws(() => resolve({ channel: 'firefox' as BrowserConfig['channel'] }))
})

test('a fractional or negative size is rejected', () => {
  assert.throws(() => resolve({ viewportWidth: -1 }))
  assert.throws(() => resolve({ maxInstances: 0 }))
})
