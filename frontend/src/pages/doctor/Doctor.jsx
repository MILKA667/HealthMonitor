import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { download, post } from '../../api.js'
import { useApi } from '../../hooks.js'
import { ALERT_STATUS, CONDITIONS, SEVERITY, fmtDateTime, fmtNum, fmtValue, timeAgo } from '../../format.js'
import { Card, Empty, ErrorBox, Field, Icon, Loadable, Mark, Segmented, SeverityBadge, Stat, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { ChatThread } from '../shared/ChatThread.jsx'

const FILTERS = [['all', 'Все'], ['critical', 'Критические'], ['warning', 'Отклонения'], ['stale', 'Нет данных']]
const SEVERITY_ORDER = { critical: 0, warning: 1 }
const QUEUE_SIZE = 6

/** Current time, refreshed every 30 s, for "waiting N min" counters. */
function useNow(stepMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}

function patientsWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'пациент'
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'пациента'
  return 'пациентов'
}

/** Dashboard of all patients ordered by criticality (KAN-28, KAN-29). Refreshes every 30 s. */
export function DoctorDashboard() {
  const state = useApi('/doctor/dashboard', { intervalMs: 30_000 })
  const queue = useApi('/alerts?status=open', { intervalMs: 15_000 })
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const reloadAll = () => {
    queue.reload()
    state.reload()
  }
  const total = state.data?.totals.patients
  return (
    <>
      <PageHeader title="Мои пациенты" sub={total ? `${total} ${patientsWord(total)} под наблюдением` : null} />
      <Loadable state={state}>
        {(data) => {
          const items = data.patients.filter((p) => (filter === 'all' || p.priority === filter) && p.fullName.toLowerCase().includes(q.toLowerCase()))
          return (
            <div className="stack-lg">
              <AlarmQueue state={queue} slaMinutes={data.reaction.slaMinutes} onChange={reloadAll} />
              <div className="census" role="group" aria-label="Сводка по пациентам">
                <Stat label="Критические" value={data.totals.critical} tone={data.totals.critical ? 'critical' : undefined} />
                <Stat label="С отклонениями" value={data.totals.warning} tone={data.totals.warning ? 'warning' : undefined} />
                <Stat label="Без данных более 2 дней" value={data.totals.stale} tone={data.totals.stale ? 'stale' : undefined} />
                <Stat label="Среднее время реакции" value={data.reaction.avgMinutes === null ? 'нет данных' : fmtNum(data.reaction.avgMinutes)} unit={data.reaction.avgMinutes === null ? undefined : 'мин'} hint={`цель — не более ${data.reaction.slaMinutes} мин`} tone={data.reaction.avgMinutes > data.reaction.slaMinutes ? 'critical' : undefined} />
              </div>
              <section className="card flush" aria-labelledby="ward-title">
                <div className="card-head">
                  <h2 id="ward-title">Пациенты по приоритету</h2>
                  <div className="row">
                    <input type="search" aria-label="Поиск пациента" placeholder="Поиск по ФИО" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
                    <Segmented label="Фильтр" value={filter} onChange={setFilter} options={FILTERS} />
                  </div>
                </div>
                {items.length ? (
                  <>
                    <div className="ward-head" aria-hidden="true"><span /><span>Пациент</span><span>Последние показатели</span><span style={{ textAlign: 'right' }}>Измерение</span></div>
                    <ul className="ward">
                      {items.map((p) => <WardRow key={p.id} patient={p} />)}
                    </ul>
                  </>
                ) : (
                  <div style={{ padding: '0 20px 8px' }}>
                    <Empty>{data.patients.length ? 'Нет пациентов по выбранному фильтру' : 'Пациенты ещё не прикреплены. Заявки пациентов — в разделе «Заявки».'}</Empty>
                  </div>
                )}
              </section>
            </div>
          )
        }}
      </Loadable>
    </>
  )
}

function WardRow({ patient: p }) {
  const { busy, error, run } = useAction()
  return (
    <li>
      <Link to={`/doctor/patients/${p.id}`} className={`bed ${p.priority}`}>
        <span>
          <Mark severity={p.priority} size={14} />
          {p.priority !== 'normal' && <span className="visually-hidden">{SEVERITY[p.priority]}</span>}
        </span>
        <span className="who">
          <span className="title">{p.fullName}</span>
          <span className="row" style={{ gap: 6, marginTop: 3 }}>
            {p.openCritical > 0 && <span className="badge critical">{p.openCritical} крит.</span>}
            {p.openWarning > 0 && <span className="badge warning">{p.openWarning} откл.</span>}
            {!p.consent && <span className="badge">согласие отозвано</span>}
            <span className="small muted">{p.conditions.map((c) => CONDITIONS[c]).join(', ') || 'нозология не указана'}</span>
          </span>
        </span>
        <span className="vitals">
          {p.latest.length ? p.latest.map((m) => <span key={m.type}>{fmtValue(m.type, m.value)}</span>) : <span className="none">нет измерений</span>}
        </span>
        <span className={`when ${p.priority === 'stale' ? 'stale' : ''}`}>{timeAgo(p.lastMeasurementAt)}</span>
      </Link>
      <div className="quick">
        <button type="button" className="ghost small icon" title="Отчёт PDF за 30 дней" aria-label={`Отчёт PDF: ${p.fullName}`} disabled={busy} onClick={() => run(() => download(`/reports/patients/${p.id}/pdf`, `report-${p.id}.pdf`))}>
          <Icon name="file" />
        </button>
        {error && <span className="visually-hidden" role="alert">{error.message}</span>}
      </div>
    </li>
  )
}

/** Open alerts waiting for the doctor's reaction, with waiting time against the SLA and one-click acknowledgement. */
function AlarmQueue({ state, slaMinutes, onChange }) {
  const now = useNow()
  const { busy, error, run } = useAction()
  if (!state.data) return state.error ? <ErrorBox error={state.error} /> : null
  const items = [...state.data.items].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2) || a.createdAt.localeCompare(b.createdAt))
  if (!items.length) {
    return (
      <section className="queue calm" aria-label="Новые алерты">
        <div className="queue-head">Новых алертов нет: все отклонения приняты в работу.</div>
      </section>
    )
  }
  return (
    <section className="queue" aria-labelledby="queue-title">
      <div className="queue-head">
        <Mark severity="critical" size={14} />
        <h2 id="queue-title" style={{ fontSize: 15, margin: 0 }}>Ожидают реакции: {items.length}</h2>
        <span className="small">принять в течение {slaMinutes} мин</span>
        <span className="spacer" />
        <Link to="/doctor/alerts" className="small" style={{ color: 'inherit' }}>Все алерты</Link>
      </div>
      <ul>
        {items.slice(0, QUEUE_SIZE).map((a) => {
          const waited = Math.max(0, Math.floor((now - new Date(a.createdAt).getTime()) / 60000))
          return (
            <li key={a.id}>
              <Mark severity={a.severity} size={14} />
              <div style={{ minWidth: 0 }}>
                <Link to={`/doctor/patients/${a.patientId}`} className="who">{a.patientName}</Link>
                <span className="visually-hidden">, {SEVERITY[a.severity]}</span>
                <div className="what">{a.message}</div>
              </div>
              <span className={`sla ${waited >= slaMinutes ? 'over' : ''}`}>
                {waited < 1 ? 'только что' : `ждёт ${waited} мин`}{a.escalationLevel > 0 ? `, эскалация ${a.escalationLevel}` : ''}
              </span>
              <button type="button" className="small" disabled={busy} aria-label={`Принять алерт: ${a.patientName}`} onClick={() => run(async () => { await post(`/alerts/${a.id}/ack`); onChange() })}>Принять</button>
            </li>
          )
        })}
      </ul>
      {items.length > QUEUE_SIZE && (
        <div className="queue-more"><Link to="/doctor/alerts">Ещё {items.length - QUEUE_SIZE} в ленте алертов</Link></div>
      )}
      <ErrorBox error={error} />
    </section>
  )
}

/** Alert feed with acknowledgement and closing (KAN-38). Refreshes every 15 s. */
export function AlertsPage() {
  const [status, setStatus] = useState('active')
  const state = useApi(`/alerts?status=${status}`, { intervalMs: 15_000 })
  return (
    <>
      <PageHeader title="Алерты" sub="Новый алерт сначала принимают, затем закрывают с комментарием">
        <Segmented label="Статус" value={status} onChange={setStatus} options={[['active', 'Активные'], ['open', 'Новые'], ['resolved', 'Закрытые']]} />
      </PageHeader>
      <Card>
        <Loadable state={state}>
          {(data) => data.items.length
            ? <ul className="list">{data.items.map((a) => <AlertItem key={a.id} alert={a} onChange={state.reload} showPatient />)}</ul>
            : <Empty>{status === 'resolved' ? 'Закрытых алертов нет' : 'Активных алертов нет'}</Empty>}
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          {showPatient && <Link to={`/doctor/patients/${a.patientId}`} className="title">{a.patientName}</Link>}
          <SeverityBadge severity={a.severity} />
          <span className={`badge ${a.status === 'open' ? 'primary' : ''}`}>{ALERT_STATUS[a.status]}</span>
          {a.escalationLevel > 0 && <span className="badge critical">эскалация {a.escalationLevel}</span>}
        </div>
        <div style={{ marginTop: 4 }}>{a.message}</div>
        <div className="meta-line" style={{ marginTop: 2 }}>
          <span>{fmtDateTime(a.createdAt)}, {timeAgo(a.createdAt)}</span>
          {a.measurement && <span>Показание: {fmtValue(a.measurement.type, a.measurement.value)} ({a.measurement.source === 'device' ? 'устройство' : 'вручную'})</span>}
          {a.acknowledgedAt && <span>Принят {fmtDateTime(a.acknowledgedAt)} ({a.acknowledgedByName}), реакция {fmtNum(a.reactionMinutes)} мин</span>}
        </div>
        {a.resolutionNote && <div className="small" style={{ marginTop: 4 }}>Комментарий: {a.resolutionNote}</div>}
        {closing && (
          <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await post(`/alerts/${a.id}/resolve`, { note }); onChange() }) }}>
            <input aria-label="Комментарий" placeholder="Что сделано (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 220px' }} autoFocus />
            <button className="small" disabled={busy}>Закрыть алерт</button>
            <button type="button" className="ghost small" onClick={() => setClosing(false)}>Отмена</button>
          </form>
        )}
        <ErrorBox error={error} />
      </div>
      {onChange && a.status !== 'resolved' && !closing && (
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {a.status === 'open' && <button type="button" className="small" disabled={busy} onClick={() => run(async () => { await post(`/alerts/${a.id}/ack`); onChange() })}>Принять</button>}
          <button type="button" className="secondary small" onClick={() => setClosing(true)}>Закрыть…</button>
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
                  <li key={c.patientId} style={{ padding: 0, border: 0 }}>
                    <button type="button" className="convo" aria-current={active === c.patientId} onClick={() => setActive(c.patientId)}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="title">{c.patientName}</span>
                        <span className="preview">{c.lastMessage?.body ?? 'нет сообщений'}</span>
                      </span>
                      {c.unread > 0 && <span className="badge primary" aria-label={`непрочитанных: ${c.unread}`}>{c.unread}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty>Нет прикреплённых пациентов</Empty>}
          </Loadable>
        </Card>
        <Card title={list.data?.find((c) => c.patientId === active)?.patientName ?? 'Выберите пациента'}>
          {active ? <ChatThread key={active} patientId={active} /> : <Empty>Выберите диалог в списке</Empty>}
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
      <PageHeader title="Заявки пациентов" sub="Пациенты, которые выбрали вас лечащим врачом" />
      <Card>
        <Field label="Комментарий к решению (необязательно)"><input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <div style={{ marginTop: 12 }}>
          <Loadable state={list}>
            {(items) => items.length ? (
              <ul className="list">
                {items.map((r) => (
                  <li key={r.id}>
                    <div style={{ flex: 1 }}>
                      <div className="title">{r.patientName}</div>
                      <div className="meta-line"><span>{r.conditions.map((c) => CONDITIONS[c]).join(', ') || 'нозология не указана'}</span><span>{fmtDateTime(r.createdAt)}</span></div>
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
            ) : <Empty>Новых заявок нет</Empty>}
          </Loadable>
        </div>
      </Card>
    </>
  )
}
