/**
 * The configuration schema is the plugin's only validated input: it arrives
 * from cordis.yml and from the settings page. These tests hold the defaults
 * deployments rely on and the rejections that keep a bad value from reaching a
 * browser launch.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
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
    profileMode: 'temp',
    debugPortMin: 9038,
    debugPortMax: 9237,
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
  assert.equal(resolved.debugPortMax, 9237)
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

test('the default profile mode keeps nothing, which is what the plugin always did', () => {
  // `session` as a default would start writing profiles for every deployment
  // that never opened the settings page; the mode is the one place persistence
  // is chosen, so its default has to be the non-committal one.
  assert.equal(resolve({}).profileMode, 'temp')
})

test('a profile directory is carried as a plain string, so the settings page can edit it', () => {
  // The schema crosses a wire: the settings shell rehydrates `Config.toJSON()`
  // into a live schema. A `transform()` does not survive that (its callback
  // travels as source text and is re-evaluated where nothing it mentions
  // exists), and the browser settings section stopped rendering entirely. The
  // absolute-path rule therefore lives in the host, where the directory is used.
  assert.equal(Config.dict.userDataDir.type, 'string')
  assert.equal(resolve({ userDataDir: 'relative' }).userDataDir, 'relative')
})

test('the schema survives the settings shell\'s round trip', () => {
  // Rehydrate the way the shell does, then check the section would still have
  // every control it places.
  const rehydrated = new Schema(JSON.parse(JSON.stringify(Config)) as never)
  const volatile = Object.entries(rehydrated.dict)
    .filter(([, field]) => field?.meta?.volatile === true)
    .map(([field]) => field)
  assert.deepEqual(volatile.sort(), [
    'channel', 'debugPortMax', 'debugPortMin', 'executablePath', 'headless', 'profileMode', 'quality',
    'snapshotAttributes', 'snapshotIgnore', 'stealth', 'userDataDir', 'viewportHeight', 'viewportWidth',
  ])
})

