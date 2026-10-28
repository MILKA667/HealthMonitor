import { useState } from 'react'
import { post } from '../../api.js'
import { TYPES, fmtValue } from '../../format.js'
import { ErrorBox, Field, Segmented, SeverityBadge, useAction } from '../../components/ui.jsx'

const EMPTY = { glucose: '', unit: 'mmol/L', context: 'fasting', systolic: '', diastolic: '', pulse: '', peak_flow: '' }

function localNow() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/** Manual input of glucose, blood pressure and peak flow (KAN-25). */
export function MeasurementForm({ patientId, types, onSaved }) {
  const [type, setType] = useState(types[0])
  const [v, setV] = useState(EMPTY)
  const [at, setAt] = useState(localNow)
  const [result, setResult] = useState(null)
  const { busy, error, run } = useAction()
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const err = (k) => error?.details?.[k]

  const submit = (e) => {
    e.preventDefault()
    const value =
      type === 'glucose' ? { glucose: v.glucose, unit: v.unit, context: v.context }
        : type === 'blood_pressure' ? { systolic: v.systolic, diastolic: v.diastolic, ...(v.pulse ? { pulse: v.pulse } : {}) }
          : { peak_flow: v.peak_flow }
    run(async () => {
      const m = await post(`/patients/${patientId}/measurements`, { type, value, measuredAt: new Date(at).toISOString() })
      setResult(m)
      setV(EMPTY)
      setAt(localNow())
      onSaved?.(m)
    })
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Ввод показателя">
      {types.length > 1 && <Segmented label="Тип показателя" value={type} onChange={(t) => { setType(t); setResult(null) }} options={types.map((t) => [t, TYPES[t].label])} />}
      <div className="form-grid">
        {type === 'glucose' && (
          <>
            <Field label="Глюкоза" error={err('glucose')}><input inputMode="decimal" value={v.glucose} onChange={set('glucose')} required placeholder="5,6" /></Field>
            <Field label="Единицы" error={err('unit')}>
              <select value={v.unit} onChange={set('unit')}><option value="mmol/L">ммоль/л</option><option value="mg/dL">мг/дл</option></select>
            </Field>
            <Field label="Когда">
              <select value={v.context} onChange={set('context')}>
                <option value="fasting">Натощак</option><option value="before_meal">До еды</option><option value="after_meal">После еды</option><option value="bedtime">Перед сном</option><option value="other">Другое</option>
              </select>
            </Field>
          </>
        )}
        {type === 'blood_pressure' && (
          <>
            <Field label="Систолическое (верхнее)" error={err('systolic')}><input inputMode="numeric" value={v.systolic} onChange={set('systolic')} required placeholder="120" /></Field>
            <Field label="Диастолическое (нижнее)" error={err('diastolic')}><input inputMode="numeric" value={v.diastolic} onChange={set('diastolic')} required placeholder="80" /></Field>
            <Field label="Пульс" error={err('pulse')}><input inputMode="numeric" value={v.pulse} onChange={set('pulse')} placeholder="70" /></Field>
          </>
        )}
        {type === 'peak_flow' && (
          <Field label="ПСВ, л/мин" error={err('peak_flow')}><input inputMode="numeric" value={v.peak_flow} onChange={set('peak_flow')} required placeholder="400" /></Field>
        )}
        <Field label="Дата и время"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required max={localNow()} /></Field>
      </div>
      <ErrorBox error={error && !error.details ? error : null} />
      {error?.details && <div className="notice error" role="alert">Проверьте значения: {Object.values(error.details).join('; ')}</div>}
      <div className="row">
        <button disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
        {result && (
          <span className="row small" role="status">
            Сохранено: {fmtValue(result.type, result.value)} <SeverityBadge severity={result.severity} />
            {result.severity === 'critical' && <span className="muted">Лечащий врач получил уведомление.</span>}
          </span>
        )}
      </div>
    </form>
  )
}
