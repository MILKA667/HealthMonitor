import { fmtDate, fmtDateTime, fmtNum } from '../format.js'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']

/**
 * Time-series chart (KAN-26). `series`: [{ key, label, points: [{ t, v }] }]. `thresholds` draws the
 * warning corridor of the first series and its critical limits.
 */
export function LineChart({ series, thresholds, height = 220, unit = '' }) {
  const all = series.flatMap((s) => s.points)
  if (all.length === 0) return <div className="empty">Нет измерений за период</div>
  const W = 720
  const H = height
  const pad = { l: 44, r: 16, t: 12, b: 26 }
  const ts = all.map((p) => p.t)
  const limits = thresholds ? [thresholds.critLow, thresholds.warnLow, thresholds.warnHigh, thresholds.critHigh].filter((v) => v != null) : []
  const vs = all.map((p) => p.v).concat(limits)
  let [t0, t1] = [Math.min(...ts), Math.max(...ts)]
  if (t0 === t1) { t0 -= 3600_000; t1 += 3600_000 }
  let [v0, v1] = [Math.min(...vs), Math.max(...vs)]
  const span = v1 - v0 || Math.abs(v1) || 1
  v0 -= span * 0.08
  v1 += span * 0.08
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - v0) / (v1 - v0)) * (H - pad.t - pad.b)
  const ticks = Array.from({ length: 5 }, (_, i) => v0 + ((v1 - v0) * i) / 4)
  const xTicks = Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * i) / 3)

  const lo = thresholds?.warnLow ?? v0
  const hi = thresholds?.warnHigh ?? v1
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`График: ${series.map((s) => s.label).join(', ')}`}>
        {thresholds && (thresholds.warnLow != null || thresholds.warnHigh != null) && (
          <rect className="band-warn" x={pad.l} width={W - pad.l - pad.r} y={y(Math.min(hi, v1))} height={Math.max(0, y(Math.max(lo, v0)) - y(Math.min(hi, v1)))} />
        )}
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={pad.l - 6} y={y(v) + 4} textAnchor="end">{fmtNum(Math.round(v * 10) / 10)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={t} className="axis-label" x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtDate(new Date(t).toISOString())}</text>
        ))}
        {[thresholds?.critLow, thresholds?.critHigh].filter((v) => v != null && v >= v0 && v <= v1).map((v) => (
          <g key={`c${v}`}>
            <line className="limit" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text className="limit-label" x={W - pad.r} y={y(v) - 3} textAnchor="end">крит. {fmtNum(v)}</text>
          </g>
        ))}
        {series.map((s, i) => {
          const pts = [...s.points].sort((a, b) => a.t - b.t)
          const d = pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" strokeLinejoin="round" />
              {pts.map((p, j) => (
                <circle key={`${p.t}-${j}`} cx={x(p.t)} cy={y(p.v)} r={p.severity && p.severity !== 'normal' ? 4.5 : 3} fill={p.severity === 'critical' ? 'var(--critical)' : p.severity === 'warning' ? 'var(--warning)' : COLORS[i % COLORS.length]}>
                  <title>{`${s.label}: ${fmtNum(p.v)} ${unit} — ${fmtDateTime(new Date(p.t).toISOString())}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      <div className="legend">
        {series.map((s, i) => (
          <span key={s.key}><i style={{ background: COLORS[i % COLORS.length] }} />{s.label}</span>
        ))}
        {thresholds && <span><i style={{ background: 'var(--ok-soft)', border: '1px solid var(--ok)' }} />целевой диапазон</span>}
      </div>
    </div>
  )
}

/** Turns API measurements into chart series for one measurement type. */
// eslint-disable-next-line react-refresh/only-export-components
export function toSeries(items, metrics, labels) {
  return metrics
    .map((metric) => ({
      key: metric,
      label: labels[metric]?.short ?? metric,
      points: items.filter((m) => typeof m.value[metric] === 'number').map((m) => ({ t: new Date(m.measuredAt).getTime(), v: m.value[metric], severity: m.severity })),
    }))
    .filter((s) => s.points.length)
}
