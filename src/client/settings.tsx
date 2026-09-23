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
 * Styles are inline: this plugin builds its client bundle outside the
 * repository's stylesheet pipeline, so a CSS import would have no owner.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { SettingsScope, SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DshBrowserKey } from './locales.ts'
import { browserStatus, type ClientBrowserReport, type ClientBrowserStatus } from './api.ts'

/** The configuration fields this page edits. */
export interface BrowserSettingsView {
  readonly channel: 'chrome' | 'msedge'
  readonly executablePath: string
  readonly headless: boolean
  readonly stealth: boolean
  readonly userDataDir: string
  readonly debugPort: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly quality: number
}

/** Injected face bound in the plugin's apply closure. */
export interface BrowserSettingsInjected {
  /** The namespace scope this page reads and writes. */
  readonly scope: SettingsScope<BrowserSettingsView>
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
  statusDetail: { fontSize: '11px', opacity: 0.65, wordBreak: 'break-all' },
  statusFailed: { color: 'var(--dsh-danger, #e06c75)' },
  save: { margin: 0, fontSize: '11px', opacity: 0.75, minHeight: '15px' },
  saveFailed: { margin: 0, fontSize: '11px', color: 'var(--dsh-danger, #e06c75)', minHeight: '15px' },
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

/**
 * What the banner says about the browsers right now.
 *
 * The state is the host's, not the form's: it is the only way a user can tell a
 * saved value from a value a browser is actually running with.
 * @param report - the last read, or `undefined` before the first answer.
 * @param t - copy for this namespace.
 * @returns the banner's summary line.
 */
function statusLine(report: ClientBrowserReport | undefined, t: (key: DshBrowserKey) => string): string {
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
function instanceLine(instance: ClientBrowserStatus, t: (key: DshBrowserKey) => string): string {
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

/**
 * The 浏览器 settings page.
 * @param props - section owner props plus the bound namespace scope.
 * @returns the section element.
 */
export function BrowserSettingsSection(
  props: SettingsSectionOwnerProps & BrowserSettingsInjected,
): ReactElement {
  const { scope, t } = props
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const snapshot = useSyncExternalStore(subscribe, () => scope.getSnapshot())
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
   * @param operation - the scope write to track.
   */
  const commit = (operation: Promise<void>): void => {
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
    commit(scope.set(field, next))
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
        commit(scope.unset(field))
      }}
    >
      {control}
    </Row>
  )

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
            <>
              <span style={styles.statusDetail}>{t('settingsSessions')}</span>
              {status?.instances.map(instance => (
                <span key={instance.sessionId} style={styles.statusDetail}>
                  {instanceLine(instance, t)}
                </span>
              ))}
            </>
          )}
        </div>
        <button type="button" style={styles.reset} onClick={refresh}>{t('settingsRefresh')}</button>
      </div>

      {saveError !== undefined
        ? <p style={styles.saveFailed}>{t('settingsSaveFailed').replace('{error}', saveError)}</p>
        : <p style={styles.save}>{saved ? t('settingsSaved') : ''}</p>}

      <div style={styles.group}>
        {row(
          t('settingsMode'),
          'headless',
          <select
            style={styles.select}
            value={value.headless ? 'headless' : 'headful'}
            onChange={(event) => { write('headless', event.target.value === 'headless') }}
          >
            <option value="headless">{t('settingsHeadless')}</option>
            <option value="headful">{t('settingsHeadful')}</option>
          </select>,
          t('settingsHeadlessNote'),
        )}
        {row(
          t('settingsStealth'),
          'stealth',
          <select
            style={styles.select}
            value={value.stealth ? 'on' : 'off'}
            onChange={(event) => { write('stealth', event.target.value === 'on') }}
          >
            <option value="on">{t('settingsStealthOn')}</option>
            <option value="off">{t('settingsStealthOff')}</option>
          </select>,
          t('settingsStealthNote'),
        )}
        {row(
          t('settingsProfile'),
          'userDataDir',
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
          </select>,
          t('settingsProfileDirHint'),
        )}
        {persistent
          ? row(
              t('settingsProfileDir'),
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
            )
          : null}
      </div>

      <div style={styles.group}>
        {row(
          t('settingsBrowser'),
          'channel',
          <select
            style={styles.select}
            value={value.channel}
            onChange={(event) => { write('channel', event.target.value) }}
          >
            <option value="chrome">{t('settingsChannelChrome')}</option>
            <option value="msedge">{t('settingsChannelEdge')}</option>
          </select>,
        )}
        {row(
          t('settingsExecutable'),
          'executablePath',
          <input
            style={styles.input}
            value={value.executablePath}
            spellCheck={false}
            onChange={(event) => { write('executablePath', event.target.value) }}
          />,
        )}
        {row(
          t('settingsDebugPort'),
          'debugPort',
          <input
            style={styles.number}
            type="number"
            min={1}
            max={65535}
            value={value.debugPort}
            onChange={(event) => { write('debugPort', Number(event.target.value)) }}
          />,
        )}
      </div>

      <div style={styles.group}>
        {row(
          t('settingsPage'),
          'viewportWidth',
          <>
            <input
              style={styles.number}
              type="number"
              min={320}
              max={3840}
              value={value.viewportWidth}
              onChange={(event) => { write('viewportWidth', Number(event.target.value)) }}
              aria-label={t('settingsWidth')}
            />
            <input
              style={styles.number}
              type="number"
              min={240}
              max={2160}
              value={value.viewportHeight}
              onChange={(event) => { write('viewportHeight', Number(event.target.value)) }}
              aria-label={t('settingsHeight')}
            />
          </>,
        )}
        {row(
          t('settingsQuality'),
          'quality',
          <input
            style={styles.number}
            type="number"
            min={1}
            max={100}
            value={value.quality}
            onChange={(event) => { write('quality', Number(event.target.value)) }}
          />,
        )}
      </div>

      <p style={styles.note}>{t('settingsApplied')}</p>
    </div>
  )
}
