/**
 * The 浏览器 settings section.
 *
 * Values arrive from the plugin's settings namespace — the composition entry
 * with the user's overrides resolved over it — and every control writes one
 * field back through the bound scope, so the page never holds a draft that can
 * disagree with what the browser was launched from.
 *
 * The profile mode is the one exception: an empty directory is what selects a
 * fresh temporary profile, so "persistent" has nothing to store until the user
 * names a directory. That choice is local until a path exists, because
 * inventing one would silently create a profile somewhere the user did not ask
 * for.
 *
 * Which fields exist, where they sit, and what they are called all come from
 * `settings-layout.ts`: this file only turns each placement into a control. That
 * split is what keeps a new configuration field from slipping onto the page
 * unlabelled or missing entirely, and it is what the tests can reach.
 *
 * Styles are inline: this plugin builds its client bundle outside the
 * repository's stylesheet pipeline, so a CSS import would have no owner.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ConfigForm, SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DshBrowserKey } from './locales.ts'
import { browserStatus, type ClientBrowserReport } from './api.ts'
import {
  ADVANCED_GROUPS,
  FIELD_COPY,
  GROUP_COPY,
  PROFILE_DIR_COPY,
  advancedSummary,
  foldedPlacements,
  instanceLine,
  overriddenCount,
  placementsIn,
  statusLine,
  type BrowserSettingsView,
  type FieldPlacement,
} from './settings-layout.ts'

/** Injected face bound in the plugin's apply closure. */
export interface BrowserSettingsInjected {
  /** The namespace form this page reads and writes. */
  readonly form: ConfigForm<BrowserSettingsView>
  /** Copy for this namespace. */
  readonly t: (key: DshBrowserKey) => string
}

const styles: Readonly<Record<string, CSSProperties>> = {
  page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '720px' },
  intro: { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.75 },
  group: { display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '12px' },
  row: { display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between' },
  label: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
  name: { fontSize: '13px' },
  hint: { fontSize: '11px', opacity: 0.6, lineHeight: 1.5 },
  control: { display: 'flex', gap: '6px', alignItems: 'center', flex: '0 0 auto' },
  input: {
    padding: '4px 6px', fontSize: '12px', width: '240px', borderRadius: '4px',
    border: '1px solid var(--dsh-border, #333b44)', background: 'var(--dsh-input-background, #1b1f24)', color: 'inherit',
  },
  number: {
    padding: '4px 6px', fontSize: '12px', width: '84px', borderRadius: '4px',
    border: '1px solid var(--dsh-border, #333b44)', background: 'var(--dsh-input-background, #1b1f24)', color: 'inherit',
  },
  select: {
    padding: '4px 6px', fontSize: '12px', borderRadius: '4px',
    border: '1px solid var(--dsh-border, #333b44)', background: 'var(--dsh-input-background, #1b1f24)', color: 'inherit',
  },
  reset: {
    padding: '3px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: '4px',
    border: '1px solid var(--dsh-border, #333b44)', background: 'transparent', color: 'inherit', opacity: 0.8,
  },
  note: { margin: 0, fontSize: '11px', opacity: 0.6 },
  status: {
    display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 10px', borderRadius: '6px', fontSize: '12px',
    border: '1px solid rgba(128,128,128,0.3)', background: 'rgba(128,128,128,0.08)',
  },
  statusText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  statusDetail: { fontSize: '11px', opacity: 0.65, wordBreak: 'break-all', display: 'block' },
  statusSummary: { fontSize: '11px', opacity: 0.65, cursor: 'pointer' },
  statusFailed: { color: 'var(--dsh-danger, #e06c75)' },
  fold: { display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '12px' },
  foldSummary: { cursor: 'pointer', fontSize: '13px', opacity: 0.9 },
  block: { display: 'flex', flexDirection: 'column', gap: '10px' },
  blockDivided: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    borderTop: '1px solid rgba(128,128,128,0.16)', paddingTop: '12px',
  },
  blockTitle: { margin: 0, fontSize: '12px', fontWeight: 600, opacity: 0.85 },
  blockHint: { margin: 0, fontSize: '11px', opacity: 0.6, lineHeight: 1.5 },
  save: { margin: 0, fontSize: '11px', opacity: 0.75, minHeight: '15px' },
  saveFailed: { margin: 0, fontSize: '11px', color: 'var(--dsh-danger, #e06c75)', minHeight: '15px' },
}

/**
 * A control is missing.
 *
 * This only compiles while the caller's switch covers every field of
 * {@link BrowserSettingsView}, so adding a configuration field fails the build
 * here until it gets a control — the runtime throw is a backstop that never
 * runs in a build that passed.
 * @param field - the field nothing renders.
 * @returns never.
 */
function unreachableField(field: never): ReactElement {
  throw new Error(`no control for ${String(field)}`)
}

/** One labelled control, with a reset affordance once the user layer holds the field. */
function Row(props: {
  readonly label: string
  readonly hint: string | undefined
  readonly overridden: boolean
  readonly resetLabel: string
  readonly onReset: () => void
  readonly children: ReactNode
}): ReactElement {
  return (
    <div style={styles.row}>
      <div style={styles.label}>
        <span style={styles.name}>{props.label}</span>
        {props.hint === undefined ? null : <span style={styles.hint}>{props.hint}</span>}
      </div>
      <div style={styles.control}>
        {props.children}
        {props.overridden
          ? <button type="button" style={styles.reset} onClick={props.onReset}>{props.resetLabel}</button>
          : null}
      </div>
    </div>
  )
}

/** One block inside the fold: what it covers, then its rows. */
function Block(props: {
  readonly title: string
  readonly hint: string
  readonly divided: boolean
  readonly children: ReactNode
}): ReactElement {
  // A labelled region rather than a heading: the settings page this renders into
  // has no document outline of its own, so a heading level here would be an
  // invented one. The label is what a screen reader announces on entry.
  return (
    <section aria-label={props.title} style={props.divided ? styles.blockDivided : styles.block}>
      <div style={styles.blockTitle}>{props.title}</div>
      <p style={styles.blockHint}>{props.hint}</p>
      {props.children}
    </section>
  )
}

/**
 * The 浏览器 settings page.
 * @param props - section owner props plus the bound namespace scope.
 * @returns the section element.
 */
export function BrowserSettingsSection(
  props: SettingsSectionOwnerProps & BrowserSettingsInjected,
): ReactElement {
  const { form, t } = props
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const snapshot = useSyncExternalStore(subscribe, () => form.getSnapshot())
  // Held above the early returns so the hook order never changes between the
  // loading, unavailable, and ready renders.
  const [persistentChoice, setPersistentChoice] = useState<boolean | undefined>(undefined)
  const [status, setStatus] = useState<ClientBrowserReport | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const timers = useRef<number[]>([])

  /** Read the host's live state; the page cannot see the browser any other way. */
  const refresh = useCallback((): void => {
    void browserStatus().then((next) => {
      setStatus(next)
      setStatusError(undefined)
    }).catch((error: unknown) => {
      setStatusError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  useEffect(() => {
    refresh()
    const pending = timers.current
    return () => {
      for (const id of pending) window.clearTimeout(id)
      pending.length = 0
    }
  }, [refresh])

  /**
   * Report one settings write, then re-read the browser it may have restarted.
   * A launch field closes the running browser and the next frame request starts
   * a new one, so the later reads are what catch the restarted instance rather
   * than the one that is on its way out. Resetting a field is a write like any
   * other and goes through here too — otherwise the banner keeps reporting the
   * browser the user just replaced.
   * @param operation - the form write to track.
   */
  const commit = (operation: Promise<unknown>): void => {
    setSaved(false)
    setSaveError(undefined)
    void operation.then(() => {
      setSaved(true)
      for (const delay of [1_500, 4_000, 8_000]) {
        timers.current.push(window.setTimeout(refresh, delay))
      }
    }).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * Write one field and report both the write and the browser it may restart.
   * @param field - the configuration field.
   * @param next - its new value.
   */
  const write = (field: keyof BrowserSettingsView, next: unknown): void => {
    commit(form.set(field, next))
  }

  if (snapshot.status === 'loading') return <p style={styles.intro}>{t('settingsLoading')}</p>
  const value = snapshot.value
  if (value === undefined) return <p style={styles.intro}>{t('settingsUnavailable')}</p>

  const user = (typeof snapshot.user === 'object' && snapshot.user !== null ? snapshot.user : {}) as Record<string, unknown>
  const persistent = persistentChoice ?? value.userDataDir !== ''
  /** A field the user layer holds, so clearing it restores the composed value. */
  const owns = (field: keyof BrowserSettingsView): boolean => Object.hasOwn(user, field)
  /** A field is overridden once the user layer holds it. */
  const row = (
    label: string,
    field: keyof BrowserSettingsView,
    control: ReactNode,
    hint?: string,
  ): ReactElement => (
    <Row
      label={label}
      hint={hint}
      overridden={owns(field)}
      resetLabel={t('settingsReset')}
      onReset={() => {
        if (field === 'userDataDir') setPersistentChoice(undefined)
        commit(form.unset(field))
      }}
    >
      {control}
    </Row>
  )

  /** The control one placed field renders. */
  const control = (field: keyof BrowserSettingsView): ReactElement => {
    switch (field) {
      case 'headless':
        return (
          <select
            style={styles.select}
            value={value.headless ? 'headless' : 'headful'}
            onChange={(event) => { write('headless', event.target.value === 'headless') }}
          >
            <option value="headless">{t('settingsHeadless')}</option>
            <option value="headful">{t('settingsHeadful')}</option>
          </select>
        )
      case 'channel':
        return (
          <select
            style={styles.select}
            value={value.channel}
            onChange={(event) => { write('channel', event.target.value) }}
          >
            <option value="chrome">{t('settingsChannelChrome')}</option>
            <option value="msedge">{t('settingsChannelEdge')}</option>
          </select>
        )
      case 'userDataDir':
        return (
          <select
            style={styles.select}
            value={persistent ? 'persistent' : 'temp'}
            onChange={(event) => {
              const next = event.target.value === 'persistent'
              setPersistentChoice(next)
              // Empty is what selects a fresh temporary profile; the persistent
              // branch keeps the empty value until the user names a directory.
              if (!next) write('userDataDir', '')
            }}
          >
            <option value="temp">{t('settingsProfileTemp')}</option>
            <option value="persistent">{t('settingsProfilePersistent')}</option>
          </select>
        )
      case 'stealth':
        return (
          <select
            style={styles.select}
            value={value.stealth ? 'on' : 'off'}
            onChange={(event) => { write('stealth', event.target.value === 'on') }}
          >
            <option value="on">{t('settingsStealthOn')}</option>
            <option value="off">{t('settingsStealthOff')}</option>
          </select>
        )
      case 'executablePath':
        return (
          <input
            style={styles.input}
            value={value.executablePath}
            spellCheck={false}
            onChange={(event) => { write('executablePath', event.target.value) }}
          />
        )
      case 'debugPortMin':
        return (
          <input
            style={styles.number}
            type="number"
            min={1}
            max={65535}
            value={value.debugPortMin}
            onChange={(event) => { write('debugPortMin', Number(event.target.value)) }}
          />
        )
      case 'debugPortMax':
        return (
          <input
            style={styles.number}
            type="number"
            min={1}
            max={65535}
            value={value.debugPortMax}
            onChange={(event) => { write('debugPortMax', Number(event.target.value)) }}
          />
        )
      case 'viewportWidth':
        return (
          <input
            style={styles.number}
            type="number"
            min={320}
            max={3840}
            value={value.viewportWidth}
            onChange={(event) => { write('viewportWidth', Number(event.target.value)) }}
          />
        )
      case 'viewportHeight':
        return (
          <input
            style={styles.number}
            type="number"
            min={240}
            max={2160}
            value={value.viewportHeight}
            onChange={(event) => { write('viewportHeight', Number(event.target.value)) }}
          />
        )
      case 'quality':
        return (
          <input
            style={styles.number}
            type="number"
            min={1}
            max={100}
            value={value.quality}
            onChange={(event) => { write('quality', Number(event.target.value)) }}
          />
        )
      case 'snapshotAttributes':
        return (
          <input
            style={styles.input}
            value={value.snapshotAttributes}
            spellCheck={false}
            onChange={(event) => { write('snapshotAttributes', event.target.value) }}
          />
        )
      case 'snapshotIgnore':
        return (
          <input
            style={styles.input}
            value={value.snapshotIgnore}
            spellCheck={false}
            onChange={(event) => { write('snapshotIgnore', event.target.value) }}
          />
        )
    }
    return unreachableField(field)
  }

  /** One placed field as a labelled row. */
  const placedRow = (placement: FieldPlacement): ReactElement => {
    const copy = FIELD_COPY[placement.field]
    return row(
      t(copy.label),
      placement.field,
      control(placement.field),
      copy.hint === undefined ? undefined : t(copy.hint),
    )
  }

  const hiddenChanges = overriddenCount(user, foldedPlacements())

  return (
    <div style={styles.page}>
      <p style={styles.intro}>{t('settingsIntro')}</p>

      <div style={styles.status}>
        <div style={styles.statusText}>
          <span style={statusError !== undefined ? styles.statusFailed : undefined}>
            {statusError !== undefined
              ? t('settingsStatusUnknown').replace('{error}', statusError)
              : statusLine(status, t)}
          </span>
          {(status?.instances.length ?? 0) === 0 ? null : (
            <details>
              <summary style={styles.statusSummary}>
                {t('settingsSessionsCount').replace('{count}', String(status?.instances.length ?? 0))}
              </summary>
              {status?.instances.map(instance => (
                <span key={instance.sessionId} style={styles.statusDetail}>
                  {instanceLine(instance, t)}
                </span>
              ))}
            </details>
          )}
        </div>
        <button type="button" style={styles.reset} onClick={refresh}>{t('settingsRefresh')}</button>
      </div>

      {saveError !== undefined
        ? <p style={styles.saveFailed}>{t('settingsSaveFailed').replace('{error}', saveError)}</p>
        : <p style={styles.save}>{saved ? t('settingsSaved') : ''}</p>}

      <div style={styles.group}>
        {placementsIn('everyday').map(placement => placedRow(placement))}
        {persistent
          ? row(
              t(PROFILE_DIR_COPY.label),
              'userDataDir',
              <input
                style={styles.input}
                value={value.userDataDir}
                spellCheck={false}
                placeholder="D:\\chrome-profile"
                onChange={(event) => {
                  setPersistentChoice(true)
                  write('userDataDir', event.target.value)
                }}
              />,
              PROFILE_DIR_COPY.hint === undefined ? undefined : t(PROFILE_DIR_COPY.hint),
            )
          : null}
      </div>

      <details style={styles.fold}>
        <summary style={styles.foldSummary}>{advancedSummary(t, hiddenChanges)}</summary>
        <p style={styles.note}>{t('settingsAdvancedHint')}</p>
        {ADVANCED_GROUPS.map((group, index) => (
          <Block
            key={group}
            title={t(GROUP_COPY[group].title)}
            hint={t(GROUP_COPY[group].hint)}
            divided={index > 0}
          >
            {placementsIn(group).map(placement => placedRow(placement))}
          </Block>
        ))}
      </details>

      <p style={styles.note}>{t('settingsApplied')}</p>
    </div>
  )
}
