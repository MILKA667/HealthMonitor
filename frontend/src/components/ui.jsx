import { useEffect, useId, useRef, useState } from 'react'
import { SEVERITY } from '../format.js'

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Загрузка" />
}

export function ErrorBox({ error }) {
  if (!error) return null
  return <div className="notice error" role="alert">{error.message || String(error)}</div>
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Field({ label, error, children }) {
  return (
    <label className="field">
      {label}
      {children}
      {error && <span className="err">{error}</span>}
    </label>
  )
}

/**
 * Alarm priority mark: the state is encoded by shape as well as colour (IEC 60601-1-8 style):
 * critical — triangle, warning — diamond, no data — ring. Normal has no mark.
 */
export function Mark({ severity, size = 12 }) {
  const common = { className: 'mark', width: size, height: size, viewBox: '0 0 12 12', 'aria-hidden': true }
  if (severity === 'critical') return <svg {...common}><path d="M6 1 11.2 10.5H.8Z" fill="var(--critical)" /></svg>
  if (severity === 'warning') return <svg {...common}><path d="M6 .8 11.2 6 6 11.2.8 6Z" fill="var(--warning-fill)" /></svg>
  if (severity === 'stale') return <svg {...common}><circle cx="6" cy="6" r="4.2" fill="none" stroke="var(--stale)" strokeWidth="2" /></svg>
  return null
}

export function SeverityBadge({ severity }) {
  return <span className={`badge ${severity}`}><Mark severity={severity} size={10} />{SEVERITY[severity] ?? severity}</span>
}

export function Stat({ label, value, unit, hint, tone }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Loadable({ state, children }) {
  if (state.loading && !state.data) return <Spinner />
  if (state.error && !state.data) return <ErrorBox error={state.error} />
  return children(state.data)
}

/** Runs an async action with a busy flag and error capture. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function run(fn) {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e)
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={v} className={v === value ? 'active' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

export function ReadOnlyTag() {
  return (
    <span className="readonly-tag">
      <Icon name="eye" size={15} />
      Только просмотр
    </span>
  )
}

const ICONS = {
  menu: 'M3 6h14M3 10h14M3 14h14',
  close: 'M5 5l10 10M15 5 5 15',
  bell: 'M10 3a4.5 4.5 0 0 0-4.5 4.5c0 3.5-1.5 5-2 5.5h13c-.5-.5-2-2-2-5.5A4.5 4.5 0 0 0 10 3ZM8.2 15.5a1.9 1.9 0 0 0 3.6 0',
  eye: 'M1.8 10S4.7 4.5 10 4.5 18.2 10 18.2 10 15.3 15.5 10 15.5 1.8 10 1.8 10ZM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  lock: 'M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9M4.5 9h11v8h-11Z',
  file: 'M5 2.5h6.5L15 6v11.5H5ZM11 2.5V6.5h4',
  chat: 'M3.5 4.5h13v9h-7l-4 3v-3h-2Z',
}

export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

/**
 * Accessible replacement for window.confirm / window.prompt.
 * `const [dialog, ask] = useDialog()` — render `{dialog}`, then `const r = await ask({ title, body, confirmLabel, danger, input })`;
 * resolves to `false` when cancelled, otherwise `true` or the entered text (when `input` is a label).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useDialog() {
  const [req, setReq] = useState(null)
  const ask = (opts) => new Promise((resolve) => setReq({ ...opts, resolve }))
  const close = (result) => {
    req?.resolve(result)
    setReq(null)
  }
  return [req ? <Dialog key="dialog" {...req} onClose={close} /> : null, ask]
}

function Dialog({ title, body, confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger, input, onClose }) {
  const ref = useRef(null)
  const id = useId()
  const [value, setValue] = useState('')
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector('input, button.confirm')?.focus()
    return () => previous?.focus?.()
  }, [])
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose(false)
    }
    if (e.key === 'Tab') {
      const items = [...ref.current.querySelectorAll('input, button')]
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
  return (
    <div className="dialog-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(false) }}>
      <form ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={body ? `${id}-b` : undefined} onKeyDown={onKeyDown} onSubmit={(e) => { e.preventDefault(); onClose(input ? value : true) }}>
        <h2 id={`${id}-t`}>{title}</h2>
        {body && <p id={`${id}-b`}>{body}</p>}
        {input && <Field label={input}><input value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        <div className="actions">
          <button type="button" className="secondary" onClick={() => onClose(false)}>{cancelLabel}</button>
          <button className={`confirm ${danger ? 'danger' : ''}`}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--primary)" />
      <path d="M4 17.5h6l2.2-5.5 3.6 10 3-8.5 1.6 4H28" fill="none" stroke="var(--primary-ink)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
