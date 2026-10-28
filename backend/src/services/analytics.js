/** Patient reports (KAN-32) and platform metrics for the charter success criteria. */
import { listMeasurements, summarize } from './measurements.js'
import { decodeAlert, reactionStats } from './alerts.js'
import { getPatientProfile, userName } from './users.js'
import { effectiveThresholds, METRICS } from './thresholds.js'

const DAY = 86400_000

export function patientReport(ctx, patientId, { from, to }) {
  const toDate = to ? new Date(to) : ctx.now()
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * DAY)
  const items = listMeasurements(ctx, patientId, { from: fromDate.toISOString(), to: toDate.toISOString(), limit: 5000 })
  const alerts = ctx.db
    .prepare('SELECT * FROM alerts WHERE patient_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at')
    .all(patientId, fromDate.toISOString(), toDate.toISOString())
    .map((a) => decodeAlert(ctx, a))
  const days = new Set(items.map((m) => m.measuredAt.slice(0, 10)))
  const periodDays = Math.max(1, Math.ceil((toDate - fromDate) / DAY))
  const profile = getPatientProfile(ctx, patientId)
  const thresholds = effectiveThresholds(ctx, patientId)
  return {
    patient: { id: patientId, fullName: userName(ctx, patientId), conditions: profile.conditions, doctorName: profile.doctorName },
    period: { from: fromDate.toISOString(), to: toDate.toISOString(), days: periodDays },
    measurementsCount: items.length,
    daysWithMeasurements: days.size,
    adherencePct: Math.min(100, Math.round((days.size / periodDays) * 100)),
    bySource: { manual: items.filter((m) => m.source === 'manual').length, device: items.filter((m) => m.source === 'device').length },
    metrics: summarize(items, thresholds),
    metricInfo: METRICS,
    thresholds,
    alerts: {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      items: alerts,
    },
    generatedAt: ctx.now().toISOString(),
  }
}

/** True when the patient never went more than 2 days without a measurement over the window (criterion: ≥60%). */
function isRegular(dates, windowStart, now) {
  if (!dates.length) return false
  const points = [windowStart, ...dates.map((d) => new Date(d).getTime()), now].sort((a, b) => a - b)
  for (let i = 1; i < points.length; i++) if (points[i] - points[i - 1] > 2 * DAY) return false
  return true
}

export function platformMetrics(ctx, { windowDays = 14 } = {}) {
  const now = ctx.now().getTime()
  const windowStart = now - windowDays * DAY
  const count = (sql, ...a) => ctx.db.prepare(sql).get(...a).c
  const patients = ctx.db.prepare("SELECT id, login_count, created_at FROM users WHERE role = 'patient' AND status = 'active'").all()
  const doctors = ctx.db.prepare("SELECT id, login_count FROM users WHERE role = 'doctor' AND status = 'active'").all()
  const activeSince = new Date(windowStart).toISOString()
  const active = patients.filter((p) => count('SELECT COUNT(*) AS c FROM measurements WHERE patient_id = ? AND measured_at >= ?', p.id, activeSince) > 0)
  const regular = active.filter((p) => {
    const dates = ctx.db.prepare('SELECT measured_at FROM measurements WHERE patient_id = ? AND measured_at >= ?').all(p.id, activeSince).map((r) => r.measured_at)
    // Patients who joined during the window are judged from their registration date.
    return isRegular(dates, Math.max(windowStart, new Date(p.created_at).getTime()), now)
  })
  const devices = ctx.db.prepare('SELECT kind, COUNT(*) AS c FROM devices WHERE active = 1 GROUP BY kind').all()
  const deviceReadings = ctx.db.prepare("SELECT d.kind, COUNT(*) AS c FROM measurements m JOIN devices d ON d.id = m.device_id WHERE m.source = 'device' GROUP BY d.kind").all()
  const reaction = reactionStats(ctx, { from: activeSince })
  const reactionAll = reactionStats(ctx)
  const adherencePct = active.length ? Math.round((regular.length / active.length) * 100) : null
  return {
    generatedAt: ctx.now().toISOString(),
    windowDays,
    users: {
      patients: patients.length,
      patientsLoggedIn: patients.filter((p) => p.login_count > 0).length,
      doctors: doctors.length,
      doctorsLoggedIn: doctors.filter((d) => d.login_count > 0).length,
      relatives: count("SELECT COUNT(*) AS c FROM users WHERE role = 'relative' AND status = 'active'"),
      pendingModeration: count("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'"),
    },
    adherence: { activePatients: active.length, regularPatients: regular.length, pct: adherencePct, targetPct: 60 },
    alerts: {
      open: count("SELECT COUNT(*) AS c FROM alerts WHERE status = 'open'"),
      openCritical: count("SELECT COUNT(*) AS c FROM alerts WHERE status = 'open' AND severity = 'critical'"),
      reactionWindow: reaction,
      reactionAllTime: reactionAll,
    },
    devices: {
      linked: Object.fromEntries(devices.map((d) => [d.kind, d.c])),
      readings: Object.fromEntries(deviceReadings.map((d) => [d.kind, d.c])),
    },
    successCriteria: [
      { id: 'users', title: 'Не менее 20 пациентов и 5 врачей, каждый вошёл в систему', met: patients.filter((p) => p.login_count > 0).length >= 20 && doctors.filter((d) => d.login_count > 0).length >= 5 },
      { id: 'devices', title: 'Интеграция минимум с 2 видами устройств (глюкометр, тонометр)', met: deviceReadings.some((d) => d.kind === 'glucometer') && deviceReadings.some((d) => d.kind === 'tonometer') },
      { id: 'reaction', title: 'Среднее время реакции на критический алерт ≤ 15 мин', met: reactionAll.avgMinutes !== null && reactionAll.avgMinutes <= 15 },
      { id: 'adherence', title: 'Не менее 60% активных пациентов вводят показатели не реже 1 раза в 2 дня', met: adherencePct !== null && adherencePct >= 60 },
    ],
  }
}
