/**
 * The recording launcher is handed a *real* temporary directory, because the
 * plugin creates the profile before it ever calls the launcher: `ensure()`
 * mkdtemps a `dsh-browser-*` directory and only then launches into it. A browser
 * that no test ever closes is a browser the plugin never cleans up after, so
 * without a sweep every `pnpm test` run would drop one directory per launch into
 * %TEMP% — measured at 45 empty directories for a single run.
 *
 * What the sweep must *not* touch matters just as much. It is a record of the
 * directories this run's launches were handed, not a glob over the temporary
 * directory: another dsh instance's running browser also has a `dsh-browser-*`
 * profile there, and deleting that would break a browser nobody asked to touch.
 * A configured profile directory is a user's own path for the same reason.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { plainConfig, Config, type BrowserConfig } from '../src/config.ts'
import { PortAllocator, portWindow } from '../src/browser/ports.ts'
import { SessionBrowser } from '../src/browser/session-browser.ts'
import { fakeLauncher, removeTemporaryProfiles, type FakeLaunch } from './support/browser.ts'

/** A silent logger. */
const logger = { info: () => {}, warn: () => {} } as unknown as Context['logger']

/**
 * Start a session browser over the recording launcher.
 * @param config - overrides on top of the schema defaults.
 * @returns the browser and the launcher's record.
 */
async function started(config: Partial<BrowserConfig> = {}): Promise<{ browser: SessionBrowser; launch: FakeLaunch }> {
  const launch = fakeLauncher()
  const browser = new SessionBrowser('session-a', {
    config: plainConfig(Config(config)),
    ports: new PortAllocator(portWindow(9333, 9340), [], async () => true),
    launch: launch.launch,
    logger,
  })
  await browser.ensure()
  return { browser, launch }
}

test('the temporary profile a launch was handed is removed by the sweep', async () => {
  const { launch } = await started()
  const profile = String(launch.browsers[0]?.profileDir)
  assert.ok(profile.startsWith(tmpdir()), profile)
  assert.ok(existsSync(profile), 'the plugin should have created the profile directory')

  removeTemporaryProfiles()

  assert.equal(existsSync(profile), false, 'the sweep should remove the profile it saw created')
})

test('a configured profile directory is left alone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-browser-config-'))
  try {
    const { launch } = await started({ userDataDir: base })
    assert.equal(launch.browsers[0]?.profileDir, join(base, 'session-a'))

    removeTemporaryProfiles()

    assert.ok(existsSync(base), 'a directory the deployment named is not this suite\'s to delete')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a profile-looking directory this run never launched into is left alone', async () => {
  // What another dsh instance's running browser looks like from here.
  const stranger = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
  try {
    removeTemporaryProfiles()

    assert.ok(existsSync(stranger), 'the sweep must be a record, not a glob over %TEMP%')
  } finally {
    await rm(stranger, { recursive: true, force: true })
  }
})
