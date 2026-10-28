import { Link } from 'react-router-dom'
import { useApi } from '../../hooks.js'
import { CONDITIONS, timeAgo } from '../../format.js'
import { Card, Empty, Loadable } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'

/** Relative cabinet: linked patients with their current status (read-only). */
export function RelativeHome() {
  const state = useApi('/relative/patients', { intervalMs: 30_000 })
  return (
    <>
      <PageHeader title="Подопечные" />
      <Card>
        <Loadable state={state}>
          {(items) => items.length ? (
            <ul className="list">
              {items.map((p) => (
                <li key={p.id}>
                  {p.consent ? (
                    <Link to={`/relative/patients/${p.id}`} className="list-link">
                      <div className={`prio-bar ${p.openCritical ? 'critical' : 'normal'}`} />
                      <div style={{ flex: 1 }}>
                        <div className="row"><span className="title">{p.fullName}</span>{p.openCritical > 0 && <span className="badge critical">критический показатель</span>}</div>
                        <div className="small muted">{p.conditions.map((c) => CONDITIONS[c]).join(', ')}{p.doctorName ? ` · врач ${p.doctorName}` : ''}</div>
                      </div>
                      <span className="small muted">{timeAgo(p.lastMeasurementAt)}</span>
                    </Link>
                  ) : (
                    <div>
                      <div className="title">{p.fullName}</div>
                      <div className="small muted">Пациент отозвал согласие на передачу сведений о здоровье — данные недоступны.</div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <Empty>Нет подключённых пациентов</Empty>}
        </Loadable>
      </Card>
      <p className="disclaimer">Вы видите показатели в режиме просмотра. Экстренные уведомления приходят по SMS на ваш номер. Решения о лечении принимает лечащий врач.</p>
    </>
  )
}
