import { useState } from 'react'
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

export function SeverityBadge({ severity }) {
  return <span className={`badge ${severity}`}>{SEVERITY[severity] ?? severity}</span>
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

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M5 17h5l2.5-6 4 11 3-8 1.5 3H27" fill="none" stroke="var(--primary-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
