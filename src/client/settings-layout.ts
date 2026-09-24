/**
 * The shape of the 浏览器 settings page, as data.
 *
 * The page is one form with two tiers. The first is what a browser needs to
 * start at all — which one, whether it gets a window, and where its profile
 * lives. The second is everything that already has a working default and only
 * gets touched when something is unusual: automation markers, the executable
 * path, the CDP port, the headless page size, the mirror quality, and what the
 * agent's snapshot prints. The second tier is folded away.
 *
 * The tables here are the single source of that shape: the component renders the
 * groups in the order declared, and TypeScript refuses to build a component that
 * has no control for a placed field. The point is that adding a field to the
 * configuration cannot silently leave the page with a control that never
 * renders — or with a field the user can no longer override.
 *
 * It is a plain `.ts` module because the section itself is a `.tsx`, which no
 * test can import: Node strips types, not JSX. Everything here is free of React,
 * so the page's copy decisions — the fold's own summary line, the group
 * headings, the status banner — are testable on their own.
 */
import type { DshBrowserKey } from './locales.ts'
import type { ClientBrowserReport, ClientBrowserStatus } from './api.ts'

/** The configuration fields the settings page edits. */
export interface BrowserSettingsView {
  readonly channel: 'chrome' | 'msedge'
  readonly executablePath: string
  readonly headless: boolean
  readonly stealth: boolean
  readonly userDataDir: string
  readonly debugPortMin: number
  readonly debugPortMax: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly quality: number
  readonly snapshotAttributes: string
  readonly snapshotIgnore: string
}

/**
 * The blocks inside the fold, in page order.
 *
 * This list is the page's structure, not a hint: a group missing from it would
 * have its fields placed but never rendered, which the tests reject. A group is
 * folded as a whole — splitting one would leave a heading with nothing under it
 * in the visible tier.
 */
export const ADVANCED_GROUPS = ['process', 'mirror', 'snapshot'] as const

/** One block inside the fold. */
export type AdvancedGroup = typeof ADVANCED_GROUPS[number]

/** Every block of the page; `everyday` is the visible tier. */
export type SettingsGroup = 'everyday' | AdvancedGroup

/** One field's place on the page. */
export interface FieldPlacement {
  /** The configuration field this placement renders. */
  readonly field: keyof BrowserSettingsView
  /** The block it belongs to. */
  readonly group: SettingsGroup
}

/**
 * Every editable field, in the order the page renders it.
 *
 * The set is exactly the volatile half of the configuration schema — a field the
 * loader lets the settings page write has to appear here, and
 * `test/settings-layout.test.ts` fails when the two lists drift apart.
 */
export const FIELD_PLACEMENTS: readonly FieldPlacement[] = [
  { field: 'headless', group: 'everyday' },
  { field: 'channel', group: 'everyday' },
  { field: 'userDataDir', group: 'everyday' },
  { field: 'stealth', group: 'process' },
  { field: 'executablePath', group: 'process' },
  { field: 'debugPortMin', group: 'process' },
  { field: 'debugPortMax', group: 'process' },
  { field: 'viewportWidth', group: 'mirror' },
  { field: 'viewportHeight', group: 'mirror' },
  { field: 'quality', group: 'mirror' },
  { field: 'snapshotAttributes', group: 'snapshot' },
  { field: 'snapshotIgnore', group: 'snapshot' },
]

/** The label and hint one field's row renders. */
export interface FieldCopy {
  /** The row's visible label. */
  readonly label: DshBrowserKey
  /** The line under it, when the label alone does not explain the field. */
  readonly hint?: DshBrowserKey
}

/**
 * Copy for every placed field.
 *
 * A separate table from {@link FIELD_PLACEMENTS} because the order the page
 * renders in and the words it uses are different concerns that happen to share a
 * key; keeping the record total means a new field cannot appear unlabelled.
 */
export const FIELD_COPY: Record<keyof BrowserSettingsView, FieldCopy> = {
  headless: { label: 'settingsMode', hint: 'settingsHeadlessNote' },
  channel: { label: 'settingsBrowser' },
  // The hint belongs to the directory row below this one, which only exists in
  // persistent mode; the mode select explains itself through its options.
  userDataDir: { label: 'settingsProfile' },
  stealth: { label: 'settingsStealth', hint: 'settingsStealthNote' },
  executablePath: { label: 'settingsExecutable' },
  debugPortMin: { label: 'settingsDebugPortMin', hint: 'settingsDebugPortHint' },
  debugPortMax: { label: 'settingsDebugPortMax' },
  viewportWidth: { label: 'settingsWidth' },
  viewportHeight: { label: 'settingsHeight' },
  quality: { label: 'settingsQuality' },
  snapshotAttributes: { label: 'settingsSnapshotAttributes', hint: 'settingsSnapshotAttributesHint' },
  snapshotIgnore: { label: 'settingsSnapshotIgnore', hint: 'settingsSnapshotIgnoreHint' },
}

/** The heading and one-line explanation of a block inside the fold. */
export const GROUP_COPY: Record<AdvancedGroup, { readonly title: DshBrowserKey; readonly hint: DshBrowserKey }> = {
  process: { title: 'settingsGroupProcess', hint: 'settingsGroupProcessHint' },
  mirror: { title: 'settingsGroupMirror', hint: 'settingsGroupMirrorHint' },
  snapshot: { title: 'settingsGroupSnapshot', hint: 'settingsGroupSnapshotHint' },
}

/** The row that continues the profile field once a directory is wanted. */
export const PROFILE_DIR_COPY: FieldCopy = { label: 'settingsProfileDir', hint: 'settingsProfileDirHint' }

/**
 * The placements of one block, in page order.
 * @param group - the block to render.
 * @returns its fields, in the order they are declared.
 */
export function placementsIn(group: SettingsGroup): readonly FieldPlacement[] {
  return FIELD_PLACEMENTS.filter(placement => placement.group === group)
}

/**
 * The fields that start a browser, and therefore stay visible.
 * @returns the placements outside the fold.
 */
export function visiblePlacements(): readonly FieldPlacement[] {
  return placementsIn('everyday')
}

/**
 * The fields behind the fold, in page order.
 * @returns every folded placement.
 */
export function foldedPlacements(): readonly FieldPlacement[] {
  return ADVANCED_GROUPS.flatMap(group => placementsIn(group))
}

/**
 * How many of these fields the user layer holds.
 *
 * The fold hides its fields' controls, and with them their reset buttons, so a
 * change made inside it would otherwise be invisible from the collapsed page.
 * @param user - the user's own settings layer, as the form reports it.
 * @param placements - the fields to look at.
 * @returns the number of them the user has overridden.
 */
export function overriddenCount(
  user: Record<string, unknown>,
  placements: readonly FieldPlacement[],
): number {
  return placements.filter(placement => Object.hasOwn(user, placement.field)).length
}

/**
 * The line the fold shows while closed.
 * @param t - copy for this namespace.
 * @param overridden - how many hidden fields the user has changed.
 * @returns the summary, mentioning them when there are any.
 */
export function advancedSummary(t: (key: DshBrowserKey) => string, overridden: number): string {
  const title = t('settingsAdvanced')
  if (overridden === 0) return title
  return `${title} · ${t('settingsAdvancedOverridden').replace('{count}', String(overridden))}`
}

/**
 * What the banner says about the browsers right now.
 *
 * The state is the host's, not the form's: it is the only way a user can tell a
 * saved value from a value a browser is actually running with.
 * @param report - the last read, or `undefined` before the first answer.
 * @param t - copy for this namespace.
 * @returns the banner's summary line.
 */
export function statusLine(report: ClientBrowserReport | undefined, t: (key: DshBrowserKey) => string): string {
  if (report === undefined) return t('settingsStatusReading')
  const running = report.instances.filter(instance => instance.state === 'ready').length
  const starting = report.instances.filter(instance => instance.state === 'starting').length
  if (running > 0) return t('settingsStatusRunning').replace('{count}', String(running))
  if (starting > 0) return t('settingsStatusStarting').replace('{count}', String(starting))
  return t('settingsStatusNone')
}

/**
 * One session's browser as a single line: which session, what state, and the
 * facts only a running one has.
 * @param instance - one entry of the report.
 * @param t - copy for this namespace.
 * @returns the line to show for it.
 */
export function instanceLine(instance: ClientBrowserStatus, t: (key: DshBrowserKey) => string): string {
  const state = instance.state === 'ready'
    ? t('settingsInstanceStateRunning')
    : instance.state === 'starting'
      ? t('settingsInstanceStateStarting')
      : instance.state === 'failed'
        ? `${t('settingsInstanceStateFailed')} — ${instance.error ?? ''}`.trim()
        : t('settingsInstanceStateStopped')
  // Every session id starts with `session-`, so shortening the raw id would
  // print the same eight characters for all of them.
  const label = instance.sessionId.replace(/^session-/, '').slice(0, 8)
  const parts = [`${t('settingsSession')} ${label}`, state]
  if (instance.debugPort !== undefined) parts.push(`CDP 127.0.0.1:${instance.debugPort}`)
  if (instance.mode !== undefined) parts.push(instance.mode)
  const pages = instance.tabs?.length ?? 0
  if (pages > 0) parts.push(t('settingsInstancePages').replace('{count}', String(pages)))
  return parts.join(' · ')
}
