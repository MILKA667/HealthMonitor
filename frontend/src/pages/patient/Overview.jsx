import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth.jsx'
import { useApi } from '../../hooks.js'
import { METRICS, TYPES, fmtDateTime, fmtNum, timeAgo, typesFor } from '../../format.js'
import { Card, Empty, Loadable, SeverityBadge, Stat } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { MeasurementForm } from '../shared/MeasurementForm.jsx'
import { History } from '../shared/History.jsx'

const ALERT_STATUS = { open: 'Ожидает врача', acknowledged: 'Врач ознакомился', resolved: 'Закрыт' }

export function PatientOverview() {
  const { user, profile, consents } = useAuth()
  const [reloadKey, setReloadKey] = useState(0)
  const types = typesFor(profile?.conditions)
  const latest = useApi(`/patients/${user.id}/measurements?limit=200&k=${reloadKey}`)
  const alerts = useApi(`/alerts?status=active&k=${reloadKey}`)
  const thresholds = useApi(`/patients/${user.id}/thresholds`)
  const noConsent = consents && !consents.health_data.active

  return (
    <>
      <PageHeader title={`Здравствуйте, ${user.fullName.split(' ').slice(-2).join(' ')}`} />
      {noConsent && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          Согласие на обработку сведений о здоровье отозвано — ввод показателей и доступ врача приостановлены. <Link to="/patient/profile">Управление согласиями</Link>
        </div>
      )}
      {!profile?.doctorId && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Лечащий врач ещё не назначен. <Link to="/patient/profile">Выбрать врача</Link>
        </div>
      )}
      <div className="grid-2">
        <div className="stack">
          <Card title="Последние показатели">
            <Loadable state={latest}>
              {(data) => {
                const metrics = types.flatMap((t) => TYPES[t].metrics).filter((m) => data.summary[m])
                return metrics.length ? (
                  <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                    {metrics.map((m) => (
                      <Stat key={m} label={METRICS[m].label} value={fmtNum(data.summary[m].last)} unit={METRICS[m].unit} hint={timeAgo(data.summary[m].lastAt)} />
                    ))}
                  </div>
                ) : <Empty>Показателей пока нет — внесите первое измерение ниже</Empty>
              }}
            </Loadable>
          </Card>
          {!noConsent && (
            <Card title="Новое измерение">
              <MeasurementForm patientId={user.id} types={types} onSaved={() => setReloadKey((k) => k + 1)} />
            </Card>
          )}
          <History patientId={user.id} types={types} thresholds={thresholds.data?.thresholds} reloadKey={reloadKey} />
        </div>
        <div className="stack">
          <Card title="Лечащий врач">
            {profile?.doctorId ? (
              <div className="stack">
                <div className="title">{profile.doctorName}</div>
                <Link to="/patient/chat" className="btn secondary">Написать врачу</Link>
              </div>
            ) : <Empty>Не назначен</Empty>}
          </Card>
          <Card title="Отклонения показателей">
            <Loadable state={alerts}>
              {(data) => data.items.length ? (
                <ul className="list">
                  {data.items.map((a) => (
                    <li key={a.id}>
                      <div className={`prio-bar ${a.severity}`} />
                      <div>
                        <div className="row"><SeverityBadge severity={a.severity} /><span className="small muted">{ALERT_STATUS[a.status]}</span></div>
                        <div className="small">{a.message}</div>
                        <div className="small muted">{fmtDateTime(a.createdAt)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <Empty>Активных отклонений нет</Empty>}
            </Loadable>
          </Card>
          <p className="disclaimer">
            Платформа не ставит диагнозы и не даёт медицинских рекомендаций: решение принимает лечащий врач. При резком ухудшении самочувствия звоните 112 или 103.
          </p>
        </div>
      </div>
    </>
  )
}

export function PatientHistoryPage() {
  const { user, profile } = useAuth()
  const thresholds = useApi(`/patients/${user.id}/thresholds`)
  const types = typesFor(profile?.conditions)
  return (
    <>
      <PageHeader title="История и динамика" />
      <History patientId={user.id} types={types} thresholds={thresholds.data?.thresholds} />
    </>
  )
}
