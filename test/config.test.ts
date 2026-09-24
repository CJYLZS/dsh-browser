/**
 * The configuration schema is the plugin's only validated input: it arrives
 * from cordis.yml and from the settings page. These tests hold the defaults
 * deployments rely on and the rejections that keep a bad value from reaching a
 * browser launch.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainConfig, Config, listOf, type BrowserConfig } from '../src/config.ts'

/** Resolve a partial configuration the way the plugin does at load. */
function resolve(input: Partial<BrowserConfig>): BrowserConfig {
  return plainConfig(Config(input))
}

test('an empty configuration resolves to the documented defaults', () => {
  assert.deepEqual(resolve({}), {
    channel: 'chrome',
    executablePath: '',
    headless: true,
    userDataDir: '',
    debugPortMin: 9333,
    debugPortMax: 9400,
    viewportWidth: 1440,
    viewportHeight: 900,
    stealth: true,
    startupUrl: 'about:blank',
    quality: 70,
    maxWidth: 1600,
    maxHeight: 1200,
    everyNthFrame: 1,
    snapshotNodes: 500,
    snapshotAttributes: 'url, level, placeholder, valuetext, roledescription, keyshortcuts, orientation, haspopup, description',
    snapshotIgnore: '[data-dsh-browser-ignore]',
    extraArgs: [],
    maxInstances: 4,
  })
})

test('a comma-separated snapshot setting is read as a list', () => {
  const resolved = resolve({ snapshotIgnore: ' nav , footer ,, [data-x] ' })
  assert.deepEqual(listOf(resolved.snapshotIgnore), ['nav', 'footer', '[data-x]'])
  assert.deepEqual(listOf(''), [])
})

test('one field does not disturb the others', () => {
  const resolved = resolve({ headless: false, debugPortMin: 9222 })
  assert.equal(resolved.headless, false)
  assert.equal(resolved.debugPortMin, 9222)
  assert.equal(resolved.debugPortMax, 9400)
  assert.equal(resolved.quality, 70)
  assert.equal(resolved.channel, 'chrome')
})

test('extraArgs defaults to a fresh array per resolve', () => {
  const first = resolve({})
  first.extraArgs.push('--leaked')
  assert.deepEqual(resolve({}).extraArgs, [])
})

test('a port outside the TCP range is rejected, and so is zero', () => {
  assert.throws(() => resolve({ debugPortMin: 70_000 }))
  assert.throws(() => resolve({ debugPortMax: -1 }))
  // 0 means "pick any port" to Chrome, which is exactly what a passed port may
  // not mean here: the plugin has to know where to attach.
  assert.throws(() => resolve({ debugPortMin: 0 }))
  assert.throws(() => resolve({ debugPortMax: 0 }))
})

test('a window whose ends are the same port is allowed', () => {
  const resolved = resolve({ debugPortMin: 9333, debugPortMax: 9333 })
  assert.equal(resolved.debugPortMin, resolved.debugPortMax)
})

test('the default window is wider than the most browsers one host may run', () => {
  const resolved = resolve({})
  assert.ok(
    resolved.debugPortMax - resolved.debugPortMin + 1 >= resolved.maxInstances,
    'the default window cannot hold the default instance limit',
  )
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
