/**
 * The mirror's viewer: a canvas fed by the plugin's WebSocket, and the few
 * controls that act on the browser behind it.
 *
 * Input leaves as fractions of the frame rather than pixels, so the host never
 * needs to know the viewer's size and resizing the Sidebar cannot shift a
 * click. Printable keys go as text and named keys as key events, mirroring how
 * the host dispatches them.
 *
 * Styles are inline: this plugin builds its client bundle outside the
 * repository's stylesheet pipeline, so a CSS import would have no owner.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { en, type DshBrowserKey } from './locales.ts'

/** Absolute path the host serves the mirror on. */
const STREAM_PATH = '/dsh-browser/stream'

/** Milliseconds between forwarded pointer moves, so a drag does not flood the socket. */
const MOVE_INTERVAL_MS = 33

/** Keys dispatched as key events; anything else printable goes as text. */
const NAMED_KEYS: readonly string[] = [
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]

/** What the viewer knows about the browser it mirrors. */
interface MirrorStatus {
  readonly state: 'idle' | 'starting' | 'ready' | 'failed' | 'closed'
  readonly debugPort?: number | undefined
  readonly url?: string | undefined
  readonly error?: string | undefined
}

/** Composed slot props for this body. */
export interface BrowserBodyProps {
  /**
   * The session this pane belongs to.
   *
   * It is what the viewer names on the socket, and therefore the only thing
   * that decides which browser is mirrored here: two conversations open the
   * same pane and see two different browsers.
   */
  readonly sessionId: string
  /** Copy for this namespace; without it the built-in English dictionary is used. */
  readonly t?: (key: DshBrowserKey) => string
}

/** Translate one key, falling back to the bundled dictionary at this dynamic boundary. */
function copyOf(t: BrowserBodyProps['t']): (key: DshBrowserKey) => string {
  return key => t === undefined ? en[key] : t(key)
}

/**
 * Where a pointer event landed, as a fraction of the frame.
 *
 * The canvas fits the frame into its box with `object-fit: contain`, so the
 * drawn image is smaller than the box on one axis and centred in it. Measuring
 * against the box would offset every click wherever the two aspect ratios
 * differ, which is exactly the case for a wide page in a narrow Sidebar.
 * @param element - the canvas the event arrived on.
 * @param clientX - pointer x in viewport coordinates.
 * @param clientY - pointer y in viewport coordinates.
 * @returns the position in `0..1` of the frame, clamped to the frame.
 */
function fractionOf(element: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0 || element.width === 0 || element.height === 0) return { x: 0, y: 0 }
  const scale = Math.min(rect.width / element.width, rect.height / element.height)
  const drawnWidth = element.width * scale
  const drawnHeight = element.height * scale
  const x = (clientX - rect.left - (rect.width - drawnWidth) / 2) / drawnWidth
  const y = (clientY - rect.top - (rect.height - drawnHeight) / 2) / drawnHeight
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

/**
 * Name a DOM button number the way the host's input messages spell it.
 * @param button - the event's button number.
 * @returns the matching button name.
 */
function buttonOf(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

/** Height of the address bar, which its pill radius is derived from. */
const OMNIBOX_HEIGHT = 30

/**
 * The design tokens the address bar borrows, so it matches the app in either
 * theme. `--dsw-alias-*` are the theme's own aliases: a layer for the field, a
 * border for its edge, and label colours for the text and the icons.
 */
const style: Readonly<Record<string, CSSProperties>> = {
  // Both of these state a height and then add padding or a border to it, so they
  // size to the border box: without that the pane is 12px taller than the box it
  // is given and cuts off its own last row, and the address bar is 2px taller
  // than the radius drawn on it.
  root: {
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
    height: '100%', minHeight: 0, gap: '6px', padding: '6px',
  },
  omnibox: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto',
    height: `${String(OMNIBOX_HEIGHT)}px`, padding: '0 3px 0 9px',
    borderRadius: `${String(OMNIBOX_HEIGHT / 2)}px`,
    background: 'var(--dsw-alias-bg-layer-2, #22262c)',
    border: '1px solid var(--dsw-alias-border-l2, #333b44)',
  },
  omniboxFocused: { borderColor: 'var(--dsw-alias-border-l4, #4a5560)' },
  scheme: { display: 'flex', alignItems: 'center', flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, #93a1b0)' },
  schemeInsecure: { color: 'var(--dsw-alias-state-warn-label, #d19a66)' },
  address: {
    flex: '1 1 auto', minWidth: 0, height: '100%', padding: '0 4px',
    border: 'none', outline: 'none', background: 'transparent',
    color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '12px',
  },
  iconButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
    width: `${String(OMNIBOX_HEIGHT - 6)}px`, height: `${String(OMNIBOX_HEIGHT - 6)}px`,
    padding: 0, border: 'none', borderRadius: '50%', cursor: 'pointer',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary, #93a1b0)',
  },
  iconButtonHovered: {
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))',
    color: 'var(--dsw-alias-label-primary, #fff)',
  },
  stage: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', background: '#101418' },
  canvas: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', outline: 'none' },
  note: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: '8px',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '12px',
    fontSize: '12px', color: '#93a1b0', pointerEvents: 'none',
  },
  // The canvas is the page, so the overlay sits on whatever colour that page
  // happens to be: without its own background it disappears on a white one.
  noteCard: {
    display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center',
    maxWidth: '90%', padding: '10px 14px', borderRadius: '8px',
    background: 'rgba(16, 20, 24, 0.88)', color: '#d7dee6', lineHeight: 1.5,
  },
  // The overlay ignores pointer events so a click reaches the page beneath it;
  // its button has to opt back in.
  noteButton: {
    padding: '4px 8px', fontSize: '12px', cursor: 'pointer', pointerEvents: 'auto',
    background: 'var(--dsh-button-background, #2b6cb0)', color: '#fff',
    border: 'none', borderRadius: '4px',
  },
  status: {
    flex: '0 0 auto', display: 'flex', gap: '6px', alignItems: 'center',
    fontSize: '11px', color: '#93a1b0',
  },
  statusText: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusButton: {
    flex: '0 0 auto', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l2, #333b44)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, inherit)',
  },
}

/** The lock a secure address shows, drawn at the size the bar's icons share. */
const LOCK_ICON = (
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="2" />
    <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
  </>
)

/** The globe an insecure or empty address shows. */
const GLOBE_ICON = (
  <>
    <circle cx="8" cy="8" r="5.25" />
    <path d="M2.75 8h10.5M8 2.75c1.5 1.5 2.25 3.25 2.25 5.25S9.5 14.5 8 13.25C6.5 11.75 5.75 10 5.75 8S6.5 4.25 8 2.75Z" />
  </>
)

/** The circular arrow a page that needs no navigation shows. */
const RELOAD_ICON = (
  <>
    <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" />
    <path d="M12.9 2.6v3.1h-3.1" />
  </>
)

/** The arrow an edited address shows, which submits it. */
const GO_ICON = (
  <>
    <path d="M3 8h9.5" />
    <path d="M9 4.5 12.5 8 9 11.5" />
  </>
)

/**
 * One icon control inside the address bar.
 *
 * Hover is tracked in state rather than by a stylesheet: this plugin's client
 * bundle has no stylesheet of its own, so every appearance here is an inline
 * style, and a pseudo-class is not one.
 * @param props - the icon, its accessible name, and what it does.
 * @returns the button.
 */
function IconButton(props: {
  readonly label: string
  readonly icon: ReactNode
  readonly onClick: () => void
  readonly submit?: boolean
}): ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type={props.submit === true ? 'submit' : 'button'}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
      style={{ ...style.iconButton, ...hovered ? style.iconButtonHovered : {} }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {props.icon}
      </svg>
    </button>
  )
}

/**
 * The mirror's body: canvas, address bar, and the browser's own status.
 * @param props - composed slot props.
 * @returns the viewer.
 */
export function BrowserBody({ sessionId, t }: BrowserBodyProps): ReactNode {
  const copy = copyOf(t)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const lastMoveRef = useRef(0)
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<MirrorStatus | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [painted, setPainted] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [focused, setFocused] = useState(false)

  /**
   * Draw one received frame.
   * @param buffer - the JPEG bytes of the frame.
   */
  const drawFrame = useCallback(async (buffer: ArrayBuffer): Promise<void> => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }))
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    setPainted(true)
  }, [])

  useEffect(() => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = new URLSearchParams({ session: sessionId })
    const socket = new WebSocket(`${scheme}//${location.host}${STREAM_PATH}?${query.toString()}`)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => { setConnected(true) }
    socket.onclose = () => { setConnected(false) }
    socket.onerror = () => { setConnected(false) }
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') {
        void drawFrame(event.data)
        return
      }
      const parsed = JSON.parse(event.data) as { type?: string; status?: MirrorStatus; message?: unknown }
      if (parsed.type === 'status' && parsed.status !== undefined) {
        setStatus(parsed.status)
        setFailure(undefined)
        return
      }
      // A refused action is otherwise invisible: the status the viewer holds is
      // unchanged, so the failure is what explains why nothing moved.
      if (parsed.type === 'error') setFailure(String(parsed.message))
    }
    socketRef.current = socket
    return () => {
      socketRef.current = undefined
      socket.close()
    }
  }, [drawFrame, sessionId])

  // The agent drives the same browser, so the address bar follows the page
  // rather than owning it.
  const browserUrl = status?.url
  useEffect(() => {
    if (browserUrl !== undefined && browserUrl !== '' && browserUrl !== 'about:blank') setAddress(browserUrl)
  }, [browserUrl])

  /**
   * Send one viewer message.
   * @param payload - the message to encode.
   */
  const send = useCallback((payload: unknown): void => {
    const socket = socketRef.current
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }, [])

  /**
   * Send one input message.
   * @param message - the host's input message.
   */
  const sendInput = useCallback((message: unknown): void => {
    send({ type: 'input', message })
  }, [send])

  /**
   * Navigate to what the address bar holds.
   *
   * Both Enter and the arrow button land here, because an implicit form
   * submission is not the only way this pane is asked to navigate and the two
   * must not drift apart.
   */
  const submit = useCallback((): void => {
    const target = address.trim()
    if (target !== '') send({ type: 'navigate', url: target })
  }, [address, send])

  const state = status?.state
  const shownUrl = status?.url ?? ''
  /** Whether the address bar holds something the browser is not on. */
  const dirty = address.trim() !== '' && address !== shownUrl
  const secure = shownUrl.startsWith('https://')
  const note = failure !== undefined
    ? failure
    : !connected
      ? copy('connecting')
      : painted && state !== 'failed' && state !== 'closed'
        ? undefined
        : state === 'failed'
          ? `${copy('failed')} ${status?.error ?? ''}`.trim()
          : state === 'starting'
            ? copy('starting')
            : state === 'ready'
              ? copy('waiting')
              : state === 'closed'
                ? `${copy('closed')} ${status?.error ?? ''}`.trim()
                : copy('idle')
  // A browser that is gone or broken cannot be recovered by waiting: the pane
  // offers the one action that does recover it, which is starting a new one.
  const recoverable = failure !== undefined || state === 'failed' || state === 'closed'
  const live = state === 'ready' || state === 'starting'

  return (
    <div style={style.root}>
      <form
        style={{ ...style.omnibox, ...focused ? style.omniboxFocused : {} }}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <span
          style={{ ...style.scheme, ...secure ? {} : style.schemeInsecure }}
          title={secure ? copy('secure') : copy('insecure')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {secure ? LOCK_ICON : GLOBE_ICON}
          </svg>
        </span>
        <input
          style={style.address}
          value={address}
          placeholder={copy('address')}
          spellCheck={false}
          autoComplete="off"
          aria-label={copy('address')}
          onFocus={(event) => {
            setFocused(true)
            // A browser hands you the whole address to replace, not a caret in it.
            event.currentTarget.select()
          }}
          onBlur={() => { setFocused(false) }}
          onChange={(event) => { setAddress(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        {dirty
          ? <IconButton label={copy('go')} icon={GO_ICON} onClick={submit} submit />
          : <IconButton label={copy('reload')} icon={RELOAD_ICON} onClick={() => { send({ type: 'reload' }) }} />}
      </form>
      <div style={style.stage}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          style={style.canvas}
          onContextMenu={(event) => { event.preventDefault() }}
          onMouseDown={(event) => {
            const at = fractionOf(event.currentTarget, event.clientX, event.clientY)
            sendInput({ type: 'mouse', action: 'down', x: at.x, y: at.y, button: buttonOf(event.button), clickCount: 1 })
          }}
          onMouseUp={(event) => {
            const at = fractionOf(event.currentTarget, event.clientX, event.clientY)
            sendInput({ type: 'mouse', action: 'up', x: at.x, y: at.y, button: buttonOf(event.button), clickCount: 1 })
          }}
          onMouseMove={(event) => {
            const now = Date.now()
            if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return
            lastMoveRef.current = now
            const at = fractionOf(event.currentTarget, event.clientX, event.clientY)
            sendInput({ type: 'mouse', action: 'move', x: at.x, y: at.y })
          }}
          onWheel={(event) => {
            const at = fractionOf(event.currentTarget, event.clientX, event.clientY)
            sendInput({ type: 'wheel', x: at.x, y: at.y, deltaX: event.deltaX, deltaY: event.deltaY })
          }}
          onKeyDown={(event) => {
            if (event.key.length === 1) {
              sendInput({ type: 'text', text: event.key })
              event.preventDefault()
              return
            }
            if (NAMED_KEYS.includes(event.key)) {
              sendInput({ type: 'key', key: event.key })
              event.preventDefault()
            }
          }}
        />
        {note === undefined ? null : (
          <div style={style.note}>
            <div style={style.noteCard}>
              <span>{note}</span>
              {recoverable
                ? (
                  <button type="button" style={style.noteButton} onClick={() => { send({ type: 'restart' }) }}>
                    {copy('restart')}
                  </button>
                )
                : null}
            </div>
          </div>
        )}
      </div>
      <div style={style.status}>
        {/* The address bar carries the page; this row carries what the address
            bar cannot — which browser is behind it. */}
        <span style={style.statusText}>
          {status?.debugPort === undefined ? '' : `${copy('endpoint')} 127.0.0.1:${status.debugPort}`}
        </span>
        {live
          ? (
            <button type="button" style={style.statusButton} onClick={() => { send({ type: 'close' }) }}>
              {copy('closeBrowser')}
            </button>
          )
          : null}
      </div>
    </div>
  )
}
