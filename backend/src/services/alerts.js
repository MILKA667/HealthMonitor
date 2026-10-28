/**
 * Alert module (KAN-38..42): alert creation, doctor feed, acknowledgement, escalation when the
 * doctor does not react, emergency notifications to relatives.
 *
 * Escalation policy for critical alerts (config.escalationMinutes = E, default 15 — the SLA):
 *   t = 0    push + SMS to the attending doctor; push to the patient; SMS/push to emergency relatives
 *   t = E    level 1: SMS again to the doctor + push/SMS to on-duty administrators
 *   t = 2E   level 2: relatives are told the doctor has not responded yet; administrators notified again
 * Warning alerts notify the doctor by push only and are not escalated.
 */
import { notify } from './notify.js'
import { METRICS } from './thresholds.js'
import { userName } from './users.js'

const fmt = (v) => String(v).replace('.', ',')

function describe(finding) {
  const m = METRICS[finding.metric]
  const dir = finding.bound.endsWith('Low') ? 'ниже' : 'выше'
  const level = finding.severity === 'critical' ? 'критического' : 'допустимого'
  return `${m.label} ${fmt(finding.value)} ${m.unit} — ${dir} ${level} порога ${fmt(finding.limit)}`
}

function patientDoctor(ctx, patientId) {
  return ctx.db.prepare('SELECT doctor_id FROM patient_profiles WHERE user_id = ?').get(patientId)?.doctor_id ?? null
}

function emergencyRelatives(ctx, patientId) {
  return ctx.db
    .prepare('SELECT * FROM relatives WHERE patient_id = ? AND notify_emergency = 1')
    .all(patientId)
    .map((r) => ({ userId: r.user_id, phone: ctx.cipher.decrypt(r.phone_enc), name: ctx.cipher.decrypt(r.name_enc) }))
}

function admins(ctx) {
  return ctx.db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.id)
}

export function raiseAlertsForMeasurement(ctx, measurement, findings) {
  const severity = findings.some((f) => f.severity === 'critical') ? 'critical' : 'warning'
  const message = findings.map(describe).join('; ')
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO alerts (patient_id, measurement_id, severity, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(measurement.patientId, measurement.id, severity, message, ctx.now().toISOString())
  const alert = { id: Number(lastInsertRowid), patientId: measurement.patientId, severity, message }
  dispatchNewAlert(ctx, alert)
  return [alert]
}

export function createAlert(ctx, { patientId, severity, message, kind }) {
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO alerts (patient_id, severity, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(patientId, severity, kind, message, ctx.now().toISOString())
  const alert = { id: Number(lastInsertRowid), patientId, severity, message }
  dispatchNewAlert(ctx, alert)
  return alert
}

function dispatchNewAlert(ctx, alert) {
  const patientName = userName(ctx, alert.patientId)
  const doctorId = patientDoctor(ctx, alert.patientId)
  const critical = alert.severity === 'critical'
  const title = critical ? `Критический показатель: ${patientName}` : `Отклонение показателя: ${patientName}`
  if (doctorId) {
    notify(ctx, { userId: doctorId, channels: critical ? ['push', 'sms'] : ['push'], title, body: alert.message, kind: 'alert', alertId: alert.id })
  } else {
    for (const id of admins(ctx)) {
      notify(ctx, { userId: id, channels: ['push'], title: `${title} (лечащий врач не назначен)`, body: alert.message, kind: 'alert', alertId: alert.id })
    }
  }
  if (!critical) return
  notify(ctx, {
    userId: alert.patientId,
    channels: ['push'],
    title: 'Показатель вне критического порога',
    body: `${alert.message}. Информация передана лечащему врачу.`,
    kind: 'alert',
    alertId: alert.id,
  })
  notifyRelatives(ctx, alert, patientName, `Экстренное уведомление HealthMonitor: у ${patientName} зафиксирован критический показатель. Лечащий врач уведомлён.`)
}

function notifyRelatives(ctx, alert, patientName, body) {
  for (const r of emergencyRelatives(ctx, alert.patientId)) {
    notify(ctx, { userId: r.userId, phone: r.phone, channels: r.userId ? ['sms', 'push'] : ['sms'], title: `HealthMonitor: ${patientName}`, body, kind: 'emergency', alertId: alert.id })
  }
}

/** Runs escalation for unacknowledged critical alerts. Idempotent; called by the scheduler. */
export function escalateOverdue(ctx) {
  const now = ctx.now()
  const stepMs = ctx.config.escalationMinutes * 60_000
  const open = ctx.db.prepare("SELECT * FROM alerts WHERE status = 'open' AND severity = 'critical' AND escalation_level < 2").all()
  let escalated = 0
  for (const a of open) {
    const ageMs = now.getTime() - new Date(a.created_at).getTime()
    const target = Math.min(2, Math.floor(ageMs / stepMs))
    if (target <= a.escalation_level) continue
    const patientName = userName(ctx, a.patient_id)
    const doctorId = patientDoctor(ctx, a.patient_id)
    const minutes = Math.round(ageMs / 60_000)
    for (let level = a.escalation_level + 1; level <= target; level++) {
      const body = `Нет реакции врача ${minutes} мин. ${a.message}`
      if (level === 1 && doctorId) {
        notify(ctx, { userId: doctorId, channels: ['sms', 'push'], title: `ЭСКАЛАЦИЯ: ${patientName}`, body, kind: 'escalation', alertId: a.id })
      }
      for (const id of admins(ctx)) {
        notify(ctx, { userId: id, channels: ['push', 'sms'], title: `ЭСКАЛАЦИЯ (уровень ${level}): ${patientName}`, body, kind: 'escalation', alertId: a.id })
      }
      if (level === 2) {
        notifyRelatives(ctx, { patientId: a.patient_id, id: a.id }, patientName, `HealthMonitor: критический показатель у ${patientName} пока не подтверждён врачом. Дежурный администратор уведомлён.`)
      }
    }
    ctx.db.prepare('UPDATE alerts SET escalation_level = ?, escalated_at = ? WHERE id = ?').run(target, now.toISOString(), a.id)
    escalated++
  }
  return escalated
}

export function decodeAlert(ctx, row) {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: userName(ctx, row.patient_id),
    measurementId: row.measurement_id,
    severity: row.severity,
    kind: row.kind,
    message: row.message,
    status: row.status,
    escalationLevel: row.escalation_level,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedByName: row.acknowledged_by ? userName(ctx, row.acknowledged_by) : null,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    reactionMinutes: row.acknowledged_at ? Math.round((new Date(row.acknowledged_at) - new Date(row.created_at)) / 6000) / 10 : null,
  }
}

/** Average doctor reaction time to critical alerts in minutes (success criterion: ≤ 15 min). */
export function reactionStats(ctx, { doctorId = null, from = null } = {}) {
  const where = ["a.severity = 'critical'", 'a.acknowledged_at IS NOT NULL']
  const args = []
  if (doctorId) { where.push('a.acknowledged_by = ?'); args.push(doctorId) }
  if (from) { where.push('a.created_at >= ?'); args.push(from) }
  const rows = ctx.db.prepare(`SELECT a.created_at, a.acknowledged_at FROM alerts a WHERE ${where.join(' AND ')}`).all(...args)
  const mins = rows.map((r) => (new Date(r.acknowledged_at) - new Date(r.created_at)) / 60_000)
  const avg = mins.length ? Math.round((mins.reduce((s, v) => s + v, 0) / mins.length) * 10) / 10 : null
  const withinSla = mins.filter((m) => m <= ctx.config.escalationMinutes).length
  return { acknowledged: mins.length, avgMinutes: avg, withinSlaPct: mins.length ? Math.round((withinSla / mins.length) * 100) : null, slaMinutes: ctx.config.escalationMinutes }
}
