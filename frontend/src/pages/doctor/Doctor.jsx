import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post } from '../../api.js'
import { useApi } from '../../hooks.js'
import { CONDITIONS, fmtDateTime, fmtNum, fmtValue, timeAgo } from '../../format.js'
import { Card, Empty, ErrorBox, Field, Loadable, Segmented, SeverityBadge, Stat, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { ChatThread } from '../shared/ChatThread.jsx'

const FILTERS = [['all', 'Все'], ['critical', 'Критические'], ['warning', 'Отклонения'], ['stale', 'Нет данных']]

/** Dashboard of all patients ordered by criticality (KAN-28, KAN-29). Refreshes every 30 s. */
export function DoctorDashboard() {
  const state = useApi('/doctor/dashboard', { intervalMs: 30_000 })
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Мои пациенты" />
      <Loadable state={state}>
        {(data) => {
          const items = data.patients.filter((p) => (filter === 'all' || p.priority === filter) && p.fullName.toLowerCase().includes(q.toLowerCase()))
          return (
            <div className="stack">
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                <Card><Stat label="Пациентов" value={data.totals.patients} /></Card>
                <Card><Stat label="С критическими алертами" value={data.totals.critical} tone={data.totals.critical ? 'critical' : undefined} /></Card>
                <Card><Stat label="С отклонениями" value={data.totals.warning} tone={data.totals.warning ? 'warning' : undefined} /></Card>
                <Card><Stat label="Без данных > 2 дней" value={data.totals.stale} /></Card>
                <Card><Stat label="Среднее время реакции" value={data.reaction.avgMinutes === null ? '—' : fmtNum(data.reaction.avgMinutes)} unit="мин" hint={`цель ≤ ${data.reaction.slaMinutes} мин`} tone={data.reaction.avgMinutes > data.reaction.slaMinutes ? 'critical' : undefined} /></Card>
              </div>
              <Card title="Приоритет по критичности" actions={<><input aria-label="Поиск пациента" placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} /><Segmented label="Фильтр" value={filter} onChange={setFilter} options={FILTERS} /></>}>
                {items.length ? (
                  <ul className="list">
                    {items.map((p) => (
                      <li key={p.id}>
                        <Link to={`/doctor/patients/${p.id}`} className="list-link">
                          <div className={`prio-bar ${p.priority}`} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="row">
                              <span className="title">{p.fullName}</span>
                              {p.priority !== 'normal' && <SeverityBadge severity={p.priority} />}
                              {p.openCritical > 0 && <span className="badge critical">{p.openCritical} крит.</span>}
                              {p.openWarning > 0 && <span className="badge warning">{p.openWarning} откл.</span>}
                              {!p.consent && <span className="badge">согласие отозвано</span>}
                            </div>
                            <div className="small muted">{p.conditions.map((c) => CONDITIONS[c]).join(', ') || 'нозология не указана'}</div>
                            <div className="small">{p.latest.map((m) => fmtValue(m.type, m.value)).join(' · ') || 'нет измерений'}</div>
                          </div>
                          <div className="small muted nowrap">{timeAgo(p.lastMeasurementAt)}</div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <Empty>{data.patients.length ? 'Нет пациентов по фильтру' : 'Пациенты ещё не прикреплены. Заявки пациентов — в разделе «Заявки».'}</Empty>}
              </Card>
            </div>
          )
        }}
      </Loadable>
    </>
  )
}

/** Alert feed with acknowledgement and closing (KAN-38). Refreshes every 15 s. */
export function AlertsPage() {
  const [status, setStatus] = useState('active')
  const state = useApi(`/alerts?status=${status}`, { intervalMs: 15_000 })
  return (
    <>
      <PageHeader title="Алерты">
        <Segmented label="Статус" value={status} onChange={setStatus} options={[['active', 'Активные'], ['open', 'Новые'], ['resolved', 'Закрытые']]} />
      </PageHeader>
      <Card>
        <Loadable state={state}>
          {(data) => data.items.length ? <ul className="list">{data.items.map((a) => <AlertItem key={a.id} alert={a} onChange={state.reload} showPatient />)}</ul> : <Empty>Алертов нет</Empty>}
        </Loadable>
      </Card>
    </>
  )
}

export function AlertItem({ alert: a, onChange, showPatient }) {
  const { busy, error, run } = useAction()
  const [note, setNote] = useState('')
  const [closing, setClosing] = useState(false)
  return (
    <li>
      <div className={`prio-bar ${a.severity}`} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row">
          <SeverityBadge severity={a.severity} />
          {showPatient && <Link to={`/doctor/patients/${a.patientId}`} className="title">{a.patientName}</Link>}
          {a.escalationLevel > 0 && <span className="badge critical">эскалация {a.escalationLevel}</span>}
          <span className="small muted">{fmtDateTime(a.createdAt)} · {timeAgo(a.createdAt)}</span>
        </div>
        <div>{a.message}</div>
        {a.measurement && <div className="small muted">Показание: {fmtValue(a.measurement.type, a.measurement.value)} ({a.measurement.source === 'device' ? 'устройство' : 'вручную'})</div>}
        {a.acknowledgedAt && <div className="small muted">Принят {fmtDateTime(a.acknowledgedAt)} ({a.acknowledgedByName}), реакция {fmtNum(a.reactionMinutes)} мин</div>}
        {a.resolutionNote && <div className="small">Комментарий: {a.resolutionNote}</div>}
        {closing && (
          <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await post(`/alerts/${a.id}/resolve`, { note }); onChange() }) }}>
            <input aria-label="Комментарий" placeholder="Что сделано (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
            <button className="small" disabled={busy}>Закрыть алерт</button>
          </form>
        )}
        <ErrorBox error={error} />
      </div>
      {onChange && a.status !== 'resolved' && (
        <div className="stack" style={{ gap: 6 }}>
          {a.status === 'open' && <button type="button" className="small" disabled={busy} onClick={() => run(async () => { await post(`/alerts/${a.id}/ack`); onChange() })}>Принять</button>}
          {!closing && <button type="button" className="secondary small" onClick={() => setClosing(true)}>Закрыть…</button>}
        </div>
      )}
    </li>
  )
}

export function DoctorChatList() {
  const list = useApi('/chat', { intervalMs: 15_000 })
  const [active, setActive] = useState(null)
  return (
    <>
      <PageHeader title="Сообщения" />
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
        <Card title="Пациенты">
          <Loadable state={list}>
            {(items) => items.length ? (
              <ul className="list">
                {items.map((c) => (
                  <li key={c.patientId}>
                    <button type="button" className="ghost" style={{ flex: 1, justifyContent: 'flex-start', textAlign: 'left', color: 'var(--text)', whiteSpace: 'normal', fontWeight: active === c.patientId ? 700 : 400 }} onClick={() => setActive(c.patientId)}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {c.patientName}
                        <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.lastMessage?.body ?? 'нет сообщений'}</span>
                      </span>
                      {c.unread > 0 && <span className="badge primary">{c.unread}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty>Нет прикреплённых пациентов</Empty>}
          </Loadable>
        </Card>
        <Card title={list.data?.find((c) => c.patientId === active)?.patientName ?? 'Выберите пациента'}>
          {active ? <ChatThread key={active} patientId={active} /> : <Empty>Выберите диалог слева</Empty>}
        </Card>
      </div>
    </>
  )
}

/** Patients' requests to be observed by this doctor (moderation, KAN-45). */
export function DoctorRequests() {
  const list = useApi('/doctor/requests')
  const { busy, error, run } = useAction()
  const [comment, setComment] = useState('')
  return (
    <>
      <PageHeader title="Заявки пациентов" />
      <Card>
        <Field label="Комментарий к решению (необязательно)"><input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <Loadable state={list}>
          {(items) => items.length ? (
            <ul className="list">
              {items.map((r) => (
                <li key={r.id}>
                  <div style={{ flex: 1 }}>
                    <div className="title">{r.patientName}</div>
                    <div className="small muted">{r.conditions.map((c) => CONDITIONS[c]).join(', ')} · {fmtDateTime(r.createdAt)}</div>
                  </div>
                  {r.status === 'pending' ? (
                    <div className="row">
                      <button type="button" className="small" disabled={busy} onClick={() => run(async () => { await post(`/doctor/requests/${r.id}/approve`, { comment }); list.reload() })}>Принять</button>
                      <button type="button" className="secondary small" disabled={busy} onClick={() => run(async () => { await post(`/doctor/requests/${r.id}/reject`, { comment }); list.reload() })}>Отклонить</button>
                    </div>
                  ) : <span className={`badge ${r.status === 'approved' ? 'ok' : ''}`}>{r.status === 'approved' ? 'принята' : 'отклонена'}</span>}
                </li>
              ))}
            </ul>
          ) : <Empty>Заявок нет</Empty>}
        </Loadable>
      </Card>
    </>
  )
}
