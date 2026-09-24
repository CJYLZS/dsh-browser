/**
 * The settings page is one long form with a fold in the middle, so its shape is
 * a decision worth pinning down: which fields a user must see, which ones only
 * matter when something is unusual, whether every field has words, and whether
 * the status banner still says enough once its per-session detail is collapsed.
 *
 * The layout lives in `src/client/settings-layout.ts` rather than in the
 * component because a `.tsx` cannot be imported here — Node strips types, not
 * JSX — and because these are decisions, not markup.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../src/config.ts'
import { en, zh, type DshBrowserKey } from '../src/client/locales.ts'
import type { ClientBrowserStatus } from '../src/client/api.ts'
import {
  ADVANCED_GROUPS,
  FIELD_COPY,
  FIELD_PLACEMENTS,
  GROUP_COPY,
  PROFILE_DIR_COPY,
  advancedSummary,
  foldedPlacements,
  instanceLine,
  overriddenCount,
  placementsIn,
  statusLine,
  visiblePlacements,
} from '../src/client/settings-layout.ts'

/** One copy function, as the section receives it. */
const english = (key: keyof typeof en): string => en[key]

/** The same, in the other shipped language. */
const chinese = (key: keyof typeof en): string => zh[key]

/** The fields the schema lets the settings page edit. */
function volatileFields(): string[] {
  const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict
  return Object.entries(dict)
    .filter(([, schema]) => schema.meta?.volatile === true)
    .map(([field]) => field)
    .sort()
}

/** The fields the page places. */
const placedFields = (): string[] => FIELD_PLACEMENTS.map(placement => placement.field).sort()

test('the page edits exactly the configuration fields the schema marks volatile', () => {
  assert.deepEqual(placedFields(), volatileFields())
})

test('every field is placed once, so no control is rendered twice or dropped', () => {
  const fields = placedFields()
  assert.equal(new Set(fields).size, fields.length, 'a field is placed more than once')
  assert.ok(fields.length > 0)
})

test('only the fields a browser needs to work are outside the fold', () => {
  assert.deepEqual(visiblePlacements().map(placement => placement.field), ['headless', 'channel', 'userDataDir'])
  const folded = foldedPlacements().map(placement => placement.field).sort()
  assert.deepEqual(folded, ['debugPortMax', 'debugPortMin', 'executablePath', 'quality', 'snapshotAttributes', 'snapshotIgnore', 'stealth', 'viewportHeight', 'viewportWidth'])
})

test('every placed field is reachable from a block the page renders', () => {
  const rendered = [...visiblePlacements(), ...foldedPlacements()].map(placement => placement.field).sort()
  assert.deepEqual(rendered, placedFields(), 'a placement sits in a block the page never renders')
})

test('every folded block has a heading and is not empty', () => {
  for (const group of ADVANCED_GROUPS) {
    assert.ok(placementsIn(group).length > 0, `${group} renders a heading over nothing`)
    assert.notEqual(GROUP_COPY[group], undefined, `${group} has no copy`)
  }
  assert.deepEqual([...ADVANCED_GROUPS], ['process', 'mirror', 'snapshot'])
})

test('placementsIn returns one block in table order', () => {
  const process = placementsIn('process')
  assert.deepEqual(process.map(placement => placement.field), ['stealth', 'executablePath', 'debugPortMin', 'debugPortMax'])
  assert.deepEqual(placementsIn('everyday').map(placement => placement.field), ['headless', 'channel', 'userDataDir'])
})

test('every labelled row has copy in both shipped languages', () => {
  // Field rows and block headings carry the same two strings under different
  // names; flattening them here is what lets one loop cover both.
  const rows: { label: DshBrowserKey; hint?: DshBrowserKey }[] = [
    ...Object.values(FIELD_COPY),
    PROFILE_DIR_COPY,
    ...Object.values(GROUP_COPY).map(entry => ({ label: entry.title, hint: entry.hint })),
  ]
  for (const row of rows) {
    for (const key of [row.label, ...(row.hint === undefined ? [] : [row.hint])]) {
      assert.ok(key in en, `${key} is missing from English`)
      assert.ok(key in zh, `${key} is missing from Chinese`)
      assert.notEqual(en[key].trim(), '', `${key} is empty`)
    }
  }
  // A placed field with no copy would render a row with an empty label.
  for (const placement of FIELD_PLACEMENTS) {
    assert.notEqual(FIELD_COPY[placement.field], undefined, `${placement.field} has no copy`)
  }
})

test('the fold advertises the fields it hides that the user has changed', () => {
  const user = { headless: true, debugPortMin: 9334, snapshotIgnore: 'nav', unrelated: 1 }
  assert.equal(overriddenCount(user, visiblePlacements()), 1)
  assert.equal(overriddenCount(user, placementsIn('process')), 1)
  assert.equal(overriddenCount(user, foldedPlacements()), 2)
  assert.equal(overriddenCount({}, FIELD_PLACEMENTS), 0)
})

test('the fold says nothing about changes when nothing is hidden behind it', () => {
  assert.equal(advancedSummary(english, 0), en.settingsAdvanced)
  assert.notEqual(advancedSummary(english, 2), en.settingsAdvanced)
  assert.match(advancedSummary(english, 2), /\b2\b/)
  assert.match(advancedSummary(chinese, 3), /3/)
})

test('the banner reports the strongest state among the running browsers', () => {
  const ready = { maxInstances: 4, instances: [status({ state: 'ready' }), status({ state: 'starting' })] }
  assert.equal(statusLine(ready, english), '1 session browser(s) running')
  assert.equal(statusLine({ maxInstances: 4, instances: [status({ state: 'starting' })] }, english), '1 session browser(s) starting')
  assert.equal(statusLine({ maxInstances: 4, instances: [] }, english), en.settingsStatusNone)
  assert.equal(statusLine(undefined, english), en.settingsStatusReading)
})

test('a session line names the session, its state, and only the facts it has', () => {
  const line = instanceLine(status({
    state: 'ready',
    debugPort: 9334,
    mode: 'headless',
    tabs: [
      { index: 0, url: 'https://example.com/', active: true },
      { index: 1, url: 'https://example.com/b', active: false },
    ],
  }), english)
  assert.ok(line.includes('127.0.0.1:9334'), line)
  assert.ok(line.includes('headless'), line)
  assert.ok(line.includes('2 page(s)'), line)
  assert.ok(!line.includes('session-'), `the raw session id leaked into "${line}"`)

  const stopped = instanceLine(status({ state: 'closed' }), english)
  assert.ok(stopped.includes(en.settingsInstanceStateStopped), stopped)
  assert.ok(!stopped.includes('CDP'), stopped)

  const failed = instanceLine(status({ state: 'failed', error: 'port in use' }), english)
  assert.ok(failed.includes('port in use'), failed)
})

/** One instance of the host's report, with the fields a case cares about. */
function status(fields: Partial<ClientBrowserStatus>): ClientBrowserStatus {
  return { sessionId: 'session-abcdef123456', state: 'idle', ...fields }
}
