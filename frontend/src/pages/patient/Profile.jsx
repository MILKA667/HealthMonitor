import { useState } from 'react'
import { download, post, put } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { useApi } from '../../hooks.js'
import { CONDITIONS, fmtDate, fmtDateTime } from '../../format.js'
import { Card, ErrorBox, Field, Loadable, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { SecurityCard } from '../shared/Security.jsx'

const REQ_STATUS = { pending: 'на рассмотрении', approved: 'одобрена', rejected: 'отклонена' }

export function ProfilePage() {
  const { user, profile, refresh } = useAuth()
  const [form, setForm] = useState({ fullName: user.fullName, phone: user.phone ?? '', conditions: profile?.conditions ?? [], birthDate: profile?.birthDate ?? '', peakFlowBest: profile?.peakFlowBest ?? '' })
  const [saved, setSaved] = useState(false)
  const save = useAction()

  return (
    <>
      <PageHeader title="Профиль и согласия" />
      <div className="grid-2">
        <div className="stack">
          <Card title="Профиль">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const body = { ...form, peakFlowBest: form.peakFlowBest ? Number(form.peakFlowBest) : undefined, birthDate: form.birthDate || undefined }; await put('/patients/me/profile', body); await refresh(); setSaved(true) }) }}>
              <div className="form-grid">
                <Field label="ФИО" error={save.error?.details?.fullName}><input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
                <Field label="Телефон" error={save.error?.details?.phone}><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                <Field label="Дата рождения"><input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} /></Field>
                {form.conditions.includes('asthma') && (
                  <Field label="Лучшая ПСВ, л/мин" error={save.error?.details?.peakFlowBest}><input inputMode="numeric" value={form.peakFlowBest} onChange={(e) => setForm({ ...form, peakFlowBest: e.target.value })} /></Field>
                )}
              </div>
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small muted" style={{ marginBottom: 6 }}>Заболевания</legend>
                {Object.entries(CONDITIONS).map(([k, label]) => (
                  <label key={k} className="check"><input type="checkbox" checked={form.conditions.includes(k)} onChange={(e) => { setSaved(false); setForm({ ...form, conditions: e.target.checked ? [...form.conditions, k] : form.conditions.filter((c) => c !== k) }) }} />{label}</label>
                ))}
              </fieldset>
              <ErrorBox error={save.error && !save.error.details ? save.error : null} />
              <div className="row"><button disabled={save.busy}>Сохранить</button>{saved && <span className="small muted" role="status">Сохранено</span>}</div>
            </form>
          </Card>
          <DoctorChoice />
          <ReportCard patientId={user.id} />
        </div>
        <div className="stack">
          <ConsentsCard />
          <SecurityCard />
        </div>
      </div>
    </>
  )
}

function DoctorChoice() {
  const { profile, refresh } = useAuth()
  const doctors = useApi('/doctors')
  const requests = useApi('/patients/me/doctor-requests')
  const [doctorId, setDoctorId] = useState('')
  const { busy, error, run } = useAction()
  const pending = requests.data?.find((r) => r.status === 'pending')
  return (
    <Card title="Лечащий врач">
      <div className="stack">
        <div>{profile?.doctorName ? <>Текущий врач: <b>{profile.doctorName}</b></> : 'Врач не назначен'}</div>
        {pending ? (
          <div className="notice">Заявка к врачу {pending.doctorName} на рассмотрении.</div>
        ) : (
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/patients/me/doctor-requests', { doctorId: Number(doctorId) }); requests.reload(); refresh() }) }}>
            <select aria-label="Врач" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required style={{ flex: 1 }}>
              <option value="">Выберите врача…</option>
              {(doctors.data ?? []).filter((d) => d.id !== profile?.doctorId).map((d) => <option key={d.id} value={d.id}>{d.fullName}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
            </select>
            <button disabled={busy || !doctorId}>Отправить заявку</button>
          </form>
        )}
        <ErrorBox error={error} />
        {requests.data?.length > 0 && (
          <ul className="list small">
            {requests.data.map((r) => <li key={r.id}>{fmtDate(r.createdAt)} · {r.doctorName} · {REQ_STATUS[r.status]}{r.comment ? ` («${r.comment}»)` : ''}</li>)}
          </ul>
        )}
      </div>
    </Card>
  )
}

function ReportCard({ patientId }) {
  const { busy, error, run } = useAction()
  return (
    <Card title="Отчёт за 30 дней">
      <p className="small muted">PDF с динамикой показателей и алертами — можно показать врачу на очном приёме.</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => run(() => download(`/reports/patients/${patientId}/pdf`, 'healthmonitor-report.pdf'))}>{busy ? 'Формирование…' : 'Скачать PDF'}</button>
      <ErrorBox error={error} />
    </Card>
  )
}

/** Consents: separate documents, versions, revocation (KAN-49). */
export function ConsentsCard() {
  const { refresh } = useAuth()
  const state = useApi('/consents/me')
  const { busy, error, run } = useAction()
  return (
    <Card title="Согласия на обработку данных">
      <Loadable state={state}>
        {(data) => (
          <div className="stack">
            {data.documents.map((d) => {
              const active = data.consents.find((c) => c.type === d.type && !c.revokedAt)
              const latest = data.status[d.type]?.latestAccepted
              return (
                <div key={d.id} className="consent-doc">
                  <div className="row">
                    <div className="title" style={{ flex: 1 }}>{d.title}</div>
                    <span className={`badge ${active ? (latest ? 'ok' : 'warning') : 'critical'}`}>{active ? (latest ? 'действует' : 'новая редакция') : 'не дано'}</span>
                  </div>
                  <div className="small muted">Версия {d.version}{active ? ` · дано ${fmtDateTime(active.grantedAt)} (v${active.version})` : ''}</div>
                  <details><summary>Текст документа</summary><p>{d.body}</p></details>
                  <div className="row" style={{ marginTop: 6 }}>
                    {(!active || !latest) && <button type="button" className="small" disabled={busy} onClick={() => run(async () => { await post('/consents', { documentId: d.id }); await state.reload(); refresh() })}>{d.type === 'user_agreement' ? 'Принять' : 'Дать согласие'}</button>}
                    {active && d.type !== 'user_agreement' && (
                      <button type="button" className="secondary small" disabled={busy} onClick={() => { if (window.confirm(d.type === 'health_data' ? 'После отзыва врач и родственники потеряют доступ к вашим медицинским данным, а ввод показателей будет приостановлен. Отозвать?' : 'Отозвать согласие?')) run(async () => { for (const c of data.consents.filter((x) => x.type === d.type && !x.revokedAt)) await post(`/consents/${c.id}/revoke`); await state.reload(); refresh() }) }}>Отозвать</button>
                    )}
                  </div>
                </div>
              )
            })}
            <ErrorBox error={error} />
          </div>
        )}
      </Loadable>
    </Card>
  )
}
