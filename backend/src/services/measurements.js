/** Measurement validation, normalization (KAN-37), storage and evaluation against thresholds. */
import { badRequest } from '../errors.js'
import { classify, effectiveThresholds, METRICS } from './thresholds.js'
import { raiseAlertsForMeasurement } from './alerts.js'

export const TYPES = ['glucose', 'blood_pressure', 'peak_flow']
const MGDL_PER_MMOL = 18.016

const round1 = (v) => Math.round(v * 10) / 10

/** Physiologically plausible input ranges; anything outside is treated as an input/device error. */
const RANGES = {
  glucose: [0.5, 40],
  systolic: [50, 300],
  diastolic: [30, 200],
  pulse: [20, 250],
  peak_flow: [50, 900],
}

function num(v, field, errors) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    errors[field] = 'должно быть числом'
    return null
  }
  return n
}

function inRange(metric, v, errors) {
  const [lo, hi] = RANGES[metric]
  if (v < lo || v > hi) errors[metric] = `вне допустимого диапазона ${lo}–${hi} ${METRICS[metric].unit}`
}

/**
 * Normalizes a raw reading into canonical units:
 * glucose → mmol/L (accepts mg/dL), blood pressure → mmHg (+ optional pulse), peak flow → L/min.
 */
export function normalizeMeasurement(type, raw = {}) {
  const errors = {}
  let value
  if (type === 'glucose') {
    const unit = raw.unit ?? 'mmol/L'
    let g = num(raw.glucose ?? raw.value, 'glucose', errors)
    if (g !== null) {
      if (unit === 'mg/dL') g = g / MGDL_PER_MMOL
      else if (unit !== 'mmol/L') errors.unit = 'допустимо: mmol/L, mg/dL'
      g = round1(g)
      inRange('glucose', g, errors)
    }
    value = { glucose: g }
    if (raw.context && ['fasting', 'before_meal', 'after_meal', 'bedtime', 'other'].includes(raw.context)) value.context = raw.context
  } else if (type === 'blood_pressure') {
    const s = num(raw.systolic, 'systolic', errors)
    const d = num(raw.diastolic, 'diastolic', errors)
    if (s !== null) inRange('systolic', s, errors)
    if (d !== null) inRange('diastolic', d, errors)
    if (s !== null && d !== null && s <= d) errors.diastolic = 'диастолическое должно быть меньше систолического'
    value = { systolic: Math.round(s), diastolic: Math.round(d) }
    if (raw.pulse !== undefined && raw.pulse !== null && raw.pulse !== '') {
      const p = num(raw.pulse, 'pulse', errors)
      if (p !== null) inRange('pulse', p, errors)
      value.pulse = Math.round(p)
    }
  } else if (type === 'peak_flow') {
    const p = num(raw.peak_flow ?? raw.value, 'peak_flow', errors)
    if (p !== null) inRange('peak_flow', p, errors)
    value = { peak_flow: Math.round(p) }
  } else {
    throw badRequest('Неизвестный тип показателя', { type: `допустимо: ${TYPES.join(', ')}` })
  }
  if (Object.keys(errors).length) throw badRequest('Показание не прошло валидацию', errors)
  return value
}

export function evaluate(ctx, patientId, value) {
  const thresholds = effectiveThresholds(ctx, patientId)
  const findings = []
  for (const [metric, v] of Object.entries(value)) {
    if (!METRICS[metric] || typeof v !== 'number') continue
    const c = classify(v, thresholds[metric])
    if (c.severity !== 'normal') findings.push({ metric, value: v, ...c })
  }
  const severity = findings.some((f) => f.severity === 'critical') ? 'critical' : findings.length ? 'warning' : 'normal'
  return { severity, findings }
}

/**
 * Stores a measurement and raises alerts. Returns null for a duplicate device reading.
 */
export function recordMeasurement(ctx, { patientId, type, raw, measuredAt, source = 'manual', deviceId = null }) {
  const value = normalizeMeasurement(type, raw)
  const at = measuredAt ? new Date(measuredAt) : ctx.now()
  if (Number.isNaN(at.getTime())) throw badRequest('Неверная дата измерения')
  if (at.getTime() > ctx.now().getTime() + 5 * 60_000) throw badRequest('Дата измерения в будущем')
  const { severity, findings } = evaluate(ctx, patientId, value)
  if (deviceId) {
    const dup = ctx.db
      .prepare('SELECT id FROM measurements WHERE device_id = ? AND type = ? AND measured_at = ?')
      .get(deviceId, type, at.toISOString())
    if (dup) return null
  }
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO measurements (patient_id, type, value_enc, measured_at, source, device_id, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(patientId, type, ctx.cipher.encryptJson(value), at.toISOString(), source, deviceId, severity, ctx.now().toISOString())
  const measurement = { id: Number(lastInsertRowid), patientId, type, value, measuredAt: at.toISOString(), source, deviceId, severity }
  measurement.alerts = findings.length ? raiseAlertsForMeasurement(ctx, measurement, findings) : []
  return measurement
}

export function decodeMeasurement(ctx, row) {
  return {
    id: row.id,
    type: row.type,
    value: ctx.cipher.decryptJson(row.value_enc),
    measuredAt: row.measured_at,
    source: row.source,
    deviceId: row.device_id,
    severity: row.severity,
  }
}

export function listMeasurements(ctx, patientId, { type, from, to, limit = 500 } = {}) {
  const where = ['patient_id = ?']
  const args = [patientId]
  if (type) { where.push('type = ?'); args.push(type) }
  if (from) { where.push('measured_at >= ?'); args.push(from) }
  if (to) { where.push('measured_at <= ?'); args.push(to) }
  return ctx.db
    .prepare(`SELECT * FROM measurements WHERE ${where.join(' AND ')} ORDER BY measured_at DESC LIMIT ?`)
    .all(...args, Math.min(limit, 5000))
    .map((r) => decodeMeasurement(ctx, r))
}

/**
 * Per-metric statistics used by charts, the patient card and reports. "In range" is judged per
 * metric against the given (current) thresholds, so a high systolic value does not mark pulse.
 */
export function summarize(measurements, thresholds = null) {
  const metrics = {}
  for (const m of measurements) {
    for (const [metric, v] of Object.entries(m.value)) {
      if (typeof v !== 'number') continue
      const s = (metrics[metric] ??= { count: 0, min: Infinity, max: -Infinity, sum: 0, outOfRange: 0, last: null, lastAt: null })
      s.count++
      s.min = Math.min(s.min, v)
      s.max = Math.max(s.max, v)
      s.sum += v
      const outOfRange = thresholds?.[metric] ? classify(v, thresholds[metric]).severity !== 'normal' : m.severity !== 'normal'
      if (outOfRange) s.outOfRange++
      if (!s.lastAt || m.measuredAt > s.lastAt) { s.last = v; s.lastAt = m.measuredAt }
    }
  }
  for (const s of Object.values(metrics)) {
    s.avg = round1(s.sum / s.count)
    s.inRangePct = Math.round(((s.count - s.outOfRange) / s.count) * 100)
    delete s.sum
  }
  return metrics
}
