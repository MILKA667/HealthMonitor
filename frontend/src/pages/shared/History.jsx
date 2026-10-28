import { useState } from 'react'
import { useApi } from '../../hooks.js'
import { METRICS, TYPES, fmtDateTime, fmtNum, fmtValue } from '../../format.js'
import { Card, Loadable, Segmented, SeverityBadge, Stat } from '../../components/ui.jsx'
import { LineChart, toSeries } from '../../components/LineChart.jsx'

const PERIODS = [['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней']]

/** History and dynamics of measurements with charts (KAN-26), used by patient, doctor and relative. */
export function History({ patientId, types, thresholds, reloadKey = 0 }) {
  const [days, setDays] = useState('30')
  const [type, setType] = useState(types[0])
  const [openedAt] = useState(() => Date.now())
  const from = new Date(openedAt - Number(days) * 86400_000).toISOString()
  const state = useApi(`/patients/${patientId}/measurements?type=${type}&from=${encodeURIComponent(from)}&k=${reloadKey}`)
  const metrics = TYPES[type].metrics
  return (
    <Card
      title="Динамика показателей"
      actions={
        <>
          {types.length > 1 && <Segmented label="Показатель" value={type} onChange={setType} options={types.map((t) => [t, TYPES[t].label])} />}
          <Segmented label="Период" value={days} onChange={setDays} options={PERIODS} />
        </>
      }
    >
      <Loadable state={state}>
        {(data) => (
          <div className="stack">
            <LineChart series={toSeries(data.items, metrics, METRICS)} thresholds={thresholds?.[metrics[0]]} unit={METRICS[metrics[0]].unit} />
            {metrics.some((m) => data.summary[m]) && (
              <div className="summary-row">
                {metrics.filter((m) => data.summary[m]).map((m) => {
                  const st = data.summary[m]
                  return (
                    <Stat key={m} label={`${METRICS[m].short}, среднее`} value={fmtNum(st.avg)} unit={METRICS[m].unit} hint={`от ${fmtNum(st.min)} до ${fmtNum(st.max)}, ${st.count} изм., в целевом диапазоне ${st.inRangePct}%`} />
                  )
                })}
              </div>
            )}
            {data.items.length > 0 && (
              <details>
                <summary>Все измерения за период ({data.items.length})</summary>
                <div className="table-wrap">
                  <table className="responsive">
                    <thead><tr><th>Дата</th><th>Значение</th><th>Источник</th><th>Статус</th></tr></thead>
                    <tbody>
                      {data.items.map((m) => (
                        <tr key={m.id}>
                          <td data-label="Дата" className="nowrap">{fmtDateTime(m.measuredAt)}</td>
                          <td data-label="Значение" className="tnum">{fmtValue(m.type, m.value)}</td>
                          <td data-label="Источник">{m.source === 'device' ? 'Устройство' : 'Вручную'}</td>
                          <td data-label="Статус"><SeverityBadge severity={m.severity} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )}
      </Loadable>
    </Card>
  )
}
