import { Link } from 'react-router-dom'
import { useApi } from '../../hooks.js'
import { CONDITIONS, timeAgo } from '../../format.js'
import { Card, Empty, Icon, Loadable, Mark, ReadOnlyTag } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'

/** Relative cabinet: linked patients with their current status (read-only). */
export function RelativeHome() {
  const state = useApi('/relative/patients', { intervalMs: 30_000 })
  return (
    <>
      <PageHeader title="Подопечные" sub="Состояние близких, которые дали вам доступ">
        <ReadOnlyTag />
      </PageHeader>
      <Card>
        <Loadable state={state}>
          {(items) => items.length ? (
            <ul className="list">
              {items.map((p) => (
                <li key={p.id}>
                  {p.consent ? (
                    <Link to={`/relative/patients/${p.id}`} className="list-link">
                      <span style={{ paddingTop: 4, width: 14 }}><Mark severity={p.openCritical ? 'critical' : 'normal'} size={14} /></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="title">{p.fullName}</span>
                          {p.openCritical > 0 && <span className="badge critical">критический показатель</span>}
                        </div>
                        <div className="meta-line">
                          <span>{p.conditions.map((c) => CONDITIONS[c]).join(', ')}</span>
                          {p.doctorName && <span>Лечащий врач: {p.doctorName}</span>}
                        </div>
                      </div>
                      <span className="small muted nowrap">{timeAgo(p.lastMeasurementAt)}</span>
                    </Link>
                  ) : (
                    <>
                      <span style={{ paddingTop: 3, color: 'var(--muted)' }}><Icon name="lock" size={15} /></span>
                      <div>
                        <div className="title">{p.fullName}</div>
                        <div className="small muted">Пациент отозвал согласие на передачу сведений о здоровье, поэтому данные недоступны.</div>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : <Empty>Подключённых пациентов нет</Empty>}
        </Loadable>
      </Card>
      <p className="disclaimer">Вы видите показатели без возможности изменить их. Экстренные уведомления приходят по SMS на ваш номер. Решения о лечении принимает лечащий врач.</p>
    </>
  )
}
