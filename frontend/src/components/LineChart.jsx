import { useId } from 'react'
import { fmtDate, fmtDateTime, fmtNum } from '../format.js'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']

/**
 * Time-series chart (KAN-26). `series`: [{ key, label, points: [{ t, v }] }]. `thresholds` draws the
 * warning corridor of the first series and its critical limits.
 */
export function LineChart({ series, thresholds, height = 240, unit = '' }) {
  const paperId = `paper-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const all = series.flatMap((s) => s.points)
  if (all.length === 0) return <div className="empty">Нет измерений за период</div>
  const W = 720
  const H = height
  const pad = { l: 44, r: 12, t: 12, b: 28 }
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
        {/* ECG chart paper: 1 small square = 12 units, 1 large square = 5 small squares. */}
        <defs>
          <pattern id={paperId} width="60" height="60" patternUnits="userSpaceOnUse" x={pad.l} y={pad.t}>
            {[12, 24, 36, 48].map((o) => (
              <g key={o}>
                <line className="paper-minor" x1={o} x2={o} y1="0" y2="60" />
                <line className="paper-minor" x1="0" x2="60" y1={o} y2={o} />
              </g>
            ))}
            <line className="paper-major" x1="0" x2="0" y1="0" y2="60" />
            <line className="paper-major" x1="0" x2="60" y1="0" y2="0" />
          </pattern>
        </defs>
        <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} fill={`url(#${paperId})`} />
        {thresholds && (thresholds.warnLow != null || thresholds.warnHigh != null) && (
          <g>
            <rect className="band-warn" x={pad.l} width={W - pad.l - pad.r} y={y(Math.min(hi, v1))} height={Math.max(0, y(Math.max(lo, v0)) - y(Math.min(hi, v1)))} />
            {[thresholds.warnLow, thresholds.warnHigh].filter((v) => v != null && v > v0 && v < v1).map((v) => (
              <line key={`w${v}`} className="band-edge" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            ))}
          </g>
        )}
        {ticks.map((v) => (
          <g key={v}>
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
              <path d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((p, j) => (
                <circle key={`${p.t}-${j}`} cx={x(p.t)} cy={y(p.v)} r={p.severity && p.severity !== 'normal' ? 4.5 : 2.8} fill={p.severity === 'critical' ? 'var(--critical)' : p.severity === 'warning' ? 'var(--warning-fill)' : COLORS[i % COLORS.length]} stroke="var(--surface)" strokeWidth={p.severity && p.severity !== 'normal' ? 1.5 : 0}>
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
        {thresholds && <span><i className="band" />целевой диапазон</span>}
        {thresholds && (thresholds.critLow != null || thresholds.critHigh != null) && <span><i style={{ background: 'none', borderTop: '2px dashed var(--critical)', height: 0 }} />критическая граница</span>}
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
