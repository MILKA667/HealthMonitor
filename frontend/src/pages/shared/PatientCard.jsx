import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { del, download, put } from '../../api.js'
import { useApi } from '../../hooks.js'
import { CONDITIONS, METRICS, fmtDate, fmtNum, timeAgo, typesFor } from '../../format.js'
import { Card, Empty, ErrorBox, Loadable, Stat, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { History } from './History.jsx'
import { ChatThread } from './ChatThread.jsx'
import { AlertItem } from '../doctor/Doctor.jsx'

/** Patient card (KAN-30): for the doctor with thresholds, report export and chat; read-only for relatives. */
export function PatientCard({ mode = 'doctor' }) {
  const { id } = useParams()
  const card = useApi(`/patients/${id}`, { intervalMs: 30_000 })
  const [tab, setTab] = useState('history')
  const doctor = mode === 'doctor'
  return (
    <Loadable state={card}>
      {(c) => {
        const types = typesFor(c.profile.conditions)
        return (
          <>
            <PageHeader title={c.patient.fullName} />
            <div className="stack">
              <Card>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div>{c.profile.conditions.map((x) => CONDITIONS[x]).join(', ') || 'Нозология не указана'}</div>
                    <div className="small muted">
                      {doctor && c.patient.phone && <>Тел.: {c.patient.phone} · </>}
                      {doctor && c.profile.birthDate && <>Дата рождения: {fmtDate(c.profile.birthDate)} · </>}
                      Последнее измерение: {timeAgo(c.lastMeasurementAt)}
                      {!doctor && c.profile.doctorName && <> · Врач: {c.profile.doctorName}</>}
                    </div>
                  </div>
                  {doctor && <ReportButton patientId={id} />}
                </div>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: 14 }}>
                  {Object.entries(c.summary30d).map(([m, s]) => (
                    <Stat key={m} label={`${METRICS[m]?.short ?? m}, 30 дн.`} value={fmtNum(s.avg)} unit={METRICS[m]?.unit} hint={`${fmtNum(s.min)}–${fmtNum(s.max)} · в диапазоне ${s.inRangePct}%`} />
                  ))}
                </div>
              </Card>
              {doctor && (
                <div className="tabs" role="tablist">
                  {[['history', 'Динамика'], ['alerts', 'Алерты'], ['thresholds', 'Пороги'], ['chat', 'Чат'], ['relatives', 'Родственники']].map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
                  ))}
                </div>
              )}
              {(tab === 'history' || !doctor) && <History patientId={id} types={types} thresholds={c.thresholds} />}
              {(tab === 'alerts' || !doctor) && (
                <Card title="Алерты">
                  {c.alerts.length ? <ul className="list">{c.alerts.map((a) => <AlertItem key={a.id} alert={a} onChange={doctor ? card.reload : null} />)}</ul> : <Empty>Алертов не было</Empty>}
                </Card>
              )}
              {doctor && tab === 'thresholds' && <ThresholdsEditor patientId={id} thresholds={c.thresholds} onSaved={card.reload} />}
              {doctor && tab === 'chat' && <Card title="Чат с пациентом"><ChatThread patientId={Number(id)} /></Card>}
              {doctor && tab === 'relatives' && (
                <Card title="Контакты родственников">
                  {c.relatives.length ? (
                    <ul className="list">{c.relatives.map((r) => <li key={r.id}><div><div className="title">{r.name} {r.relation && <span className="small muted">({r.relation})</span>}</div><div className="small muted">{r.phone} · {r.notifyEmergency ? 'получает экстренные SMS' : 'без экстренных SMS'}</div></div></li>)}</ul>
                  ) : <Empty>Пациент не указал родственников</Empty>}
                </Card>
              )}
            </div>
          </>
        )
      }}
    </Loadable>
  )
}

function ReportButton({ patientId }) {
  const { busy, error, run } = useAction()
  return (
    <div className="stack" style={{ alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="secondary" disabled={busy} onClick={() => run(() => download(`/reports/patients/${patientId}/pdf`, `report-${patientId}.pdf`))}>{busy ? 'Формирование…' : 'Отчёт PDF (30 дн.)'}</button>
      <ErrorBox error={error} />
    </div>
  )
}

const BOUNDS = [['critLow', 'Крит. нижний'], ['warnLow', 'Нижний'], ['warnHigh', 'Верхний'], ['critHigh', 'Крит. верхний']]

/** Individual alert thresholds per patient (KAN-31). */
function ThresholdsEditor({ patientId, thresholds, onSaved }) {
  const [values, setValues] = useState(() => Object.fromEntries(Object.entries(thresholds).map(([m, t]) => [m, Object.fromEntries(BOUNDS.map(([b]) => [b, t[b] ?? '']))])))
  const { busy, error, run } = useAction()
  const [saved, setSaved] = useState(null)
  const toNum = (v) => (v === '' || v === null ? null : Number(String(v).replace(',', '.')))
  return (
    <Card title="Индивидуальные пороговые значения">
      <p className="small muted">Пороги определяют, когда вы получите алерт (отклонение — push, критический — push + SMS и эскалация). Пустое поле — граница не проверяется.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Показатель</th>{BOUNDS.map(([b, l]) => <th key={b}>{l}</th>)}<th /></tr></thead>
          <tbody>
            {Object.keys(thresholds).map((m) => (
              <tr key={m}>
                <td>{METRICS[m]?.label}<div className="small muted">{METRICS[m]?.unit} · {thresholds[m].custom ? 'индивидуальные' : 'по умолчанию'}</div></td>
                {BOUNDS.map(([b]) => (
                  <td key={b}><input aria-label={`${METRICS[m]?.label} ${b}`} inputMode="decimal" style={{ width: 80 }} value={values[m][b]} onChange={(e) => setValues({ ...values, [m]: { ...values[m], [b]: e.target.value } })} /></td>
                ))}
                <td className="nowrap">
                  <button type="button" className="small" disabled={busy} onClick={() => run(async () => { await put(`/patients/${patientId}/thresholds/${m}`, Object.fromEntries(BOUNDS.map(([b]) => [b, toNum(values[m][b])]))); setSaved(m); onSaved() })}>Сохранить</button>
                  {thresholds[m].custom && <button type="button" className="ghost small" disabled={busy} onClick={() => run(async () => { const t = await del(`/patients/${patientId}/thresholds/${m}`); setValues({ ...values, [m]: Object.fromEntries(BOUNDS.map(([b]) => [b, t?.[b] ?? ''])) }); onSaved() })}>Сбросить</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={error} />
      {saved && !error && <div className="notice ok small" role="status">Пороги «{METRICS[saved]?.label}» сохранены</div>}
    </Card>
  )
}
