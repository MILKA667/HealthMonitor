/** Doctor alert feed with acknowledgement (KAN-38), doctor dashboard & prioritization (KAN-28, KAN-29), moderation of patient requests. */
import { Router } from 'express'
import { conflict, forbidden, notFound } from '../errors.js'
import { intParam, validate } from '../validate.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit, logDataAccess } from '../services/audit.js'
import { decodeAlert, reactionStats } from '../services/alerts.js'
import { hasHealthConsent } from '../services/consents.js'
import { notify } from '../services/notify.js'
import { getPatientProfile, userName } from '../services/users.js'
import { decodeMeasurement } from '../services/measurements.js'

const SEVERITY_RANK = { critical: 3, warning: 2, stale: 1, normal: 0 }

/** Alert ids visible to the caller. */
function alertScope(ctx, user) {
  if (user.role === 'doctor') return { sql: 'patient_id IN (SELECT user_id FROM patient_profiles WHERE doctor_id = ?)', args: [user.id] }
  if (user.role === 'patient') return { sql: 'patient_id = ?', args: [user.id] }
  if (user.role === 'relative') return { sql: 'patient_id IN (SELECT patient_id FROM relatives WHERE user_id = ?)', args: [user.id] }
  return null
}

export function alertsRouter(ctx) {
  const r = Router()
  r.use(requireAuth)

  r.get('/', (req, res) => {
    const scope = alertScope(ctx, req.user)
    if (!scope) throw forbidden()
    const q = validate(req.query, {
      status: { type: 'string', enum: ['open', 'acknowledged', 'resolved', 'active'] },
      severity: { type: 'string', enum: ['warning', 'critical'] },
      patientId: { type: 'number', integer: true },
      limit: { type: 'number', integer: true, min: 1, max: 500, default: 100 },
    })
    const where = [scope.sql]
    const args = [...scope.args]
    if (q.status === 'active') where.push("status IN ('open','acknowledged')")
    else if (q.status) { where.push('status = ?'); args.push(q.status) }
    if (q.severity) { where.push('severity = ?'); args.push(q.severity) }
    if (q.patientId) { where.push('patient_id = ?'); args.push(q.patientId) }
    const rows = ctx.db
      .prepare(
        `SELECT * FROM alerts WHERE ${where.join(' AND ')}
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
                  CASE severity WHEN 'critical' THEN 0 ELSE 1 END, created_at ASC LIMIT ?`,
      )
      .all(...args, q.limit)
      .filter((a) => req.user.role === 'patient' || hasHealthConsent(ctx, a.patient_id))
    const items = rows.map((a) => {
      const alert = decodeAlert(ctx, a)
      if (a.measurement_id) {
        const m = ctx.db.prepare('SELECT * FROM measurements WHERE id = ?').get(a.measurement_id)
        if (m) alert.measurement = decodeMeasurement(ctx, m)
      }
      return alert
    })
    res.json({ items, openCount: items.filter((a) => a.status === 'open').length })
  })

  function doctorAlert(req) {
    const a = ctx.db.prepare('SELECT a.*, p.doctor_id FROM alerts a JOIN patient_profiles p ON p.user_id = a.patient_id WHERE a.id = ?').get(intParam(req.params.id))
    if (!a) throw notFound('Алерт не найден')
    if (a.doctor_id !== req.user.id) throw forbidden('Алерт относится к пациенту другого врача')
    return a
  }

  r.post('/:id/ack', requireRole('doctor'), (req, res) => {
    const a = doctorAlert(req)
    if (a.status !== 'open') throw conflict('Алерт уже обработан')
    const now = ctx.now().toISOString()
    ctx.db.prepare("UPDATE alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ? WHERE id = ?").run(now, req.user.id, a.id)
    logDataAccess(ctx, req.user, a.patient_id, 'alert:ack', req.ip)
    audit(ctx, req.user, 'alert.acknowledged', { entity: 'alert', entityId: a.id, ip: req.ip })
    if (a.severity === 'critical') {
      notify(ctx, { userId: a.patient_id, title: 'Врач ознакомился с показателем', body: `${userName(ctx, req.user.id)} получил уведомление и свяжется с вами при необходимости.`, kind: 'alert_ack', alertId: a.id })
    }
    res.json(decodeAlert(ctx, ctx.db.prepare('SELECT * FROM alerts WHERE id = ?').get(a.id)))
  })

  r.post('/:id/resolve', requireRole('doctor'), (req, res) => {
    const a = doctorAlert(req)
    const { note } = validate(req.body, { note: { type: 'string', maxLength: 2000 } })
    if (a.status === 'resolved') throw conflict('Алерт уже закрыт')
    const now = ctx.now().toISOString()
    ctx.db
      .prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?, resolution_note = ?, acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?) WHERE id = ?")
      .run(now, note ?? null, now, req.user.id, a.id)
    audit(ctx, req.user, 'alert.resolved', { entity: 'alert', entityId: a.id, ip: req.ip })
    res.json(decodeAlert(ctx, ctx.db.prepare('SELECT * FROM alerts WHERE id = ?').get(a.id)))
  })

  return r
}

export function doctorRouter(ctx) {
  const r = Router()
  r.use(requireRole('doctor'))

  /** All assigned patients ordered by criticality (KAN-28, KAN-29). */
  r.get('/dashboard', (req, res) => {
    const patients = ctx.db.prepare("SELECT p.user_id AS id FROM patient_profiles p JOIN users u ON u.id = p.user_id WHERE p.doctor_id = ? AND u.status = 'active'").all(req.user.id)
    const staleMs = 2 * 86400_000
    const now = ctx.now().getTime()
    const items = patients.map(({ id }) => {
      const consent = hasHealthConsent(ctx, id)
      const base = { id, fullName: userName(ctx, id), conditions: getPatientProfile(ctx, id).conditions, consent }
      if (!consent) return { ...base, priority: 'normal', rank: -1, openCritical: 0, openWarning: 0, lastMeasurementAt: null, latest: [] }
      const counts = ctx.db
        .prepare("SELECT severity, COUNT(*) AS c, MIN(created_at) AS oldest FROM alerts WHERE patient_id = ? AND status = 'open' GROUP BY severity")
        .all(id)
      const crit = counts.find((c) => c.severity === 'critical')
      const warn = counts.find((c) => c.severity === 'warning')
      const latest = ctx.db
        .prepare('SELECT m.* FROM measurements m WHERE m.patient_id = ? AND m.measured_at = (SELECT MAX(measured_at) FROM measurements x WHERE x.patient_id = m.patient_id AND x.type = m.type)')
        .all(id)
        .map((m) => decodeMeasurement(ctx, m))
      const lastAt = latest.reduce((acc, m) => (!acc || m.measuredAt > acc ? m.measuredAt : acc), null)
      const stale = !lastAt || now - new Date(lastAt).getTime() > staleMs
      const priority = crit ? 'critical' : warn ? 'warning' : stale ? 'stale' : 'normal'
      return {
        ...base,
        priority,
        rank: SEVERITY_RANK[priority],
        openCritical: crit?.c ?? 0,
        openWarning: warn?.c ?? 0,
        oldestOpenAlertAt: crit?.oldest ?? warn?.oldest ?? null,
        lastMeasurementAt: lastAt,
        latest,
      }
    })
    items.sort((a, b) => b.rank - a.rank || String(a.oldestOpenAlertAt ?? '9').localeCompare(String(b.oldestOpenAlertAt ?? '9')) || a.fullName.localeCompare(b.fullName, 'ru'))
    for (const p of items) logDataAccess(ctx, req.user, p.id, 'dashboard', req.ip)
    res.json({
      patients: items,
      totals: {
        patients: items.length,
        critical: items.filter((p) => p.priority === 'critical').length,
        warning: items.filter((p) => p.priority === 'warning').length,
        stale: items.filter((p) => p.priority === 'stale').length,
      },
      reaction: reactionStats(ctx, { doctorId: req.user.id }),
    })
  })

  r.get('/requests', (req, res) => {
    const rows = ctx.db.prepare("SELECT * FROM requests WHERE type = 'doctor_assignment' AND target_id = ? ORDER BY status = 'pending' DESC, id DESC").all(req.user.id)
    res.json(rows.map((x) => ({ id: x.id, patientId: x.user_id, patientName: userName(ctx, x.user_id), conditions: getPatientProfile(ctx, x.user_id)?.conditions ?? [], status: x.status, createdAt: x.created_at, comment: x.comment })))
  })

  r.post('/requests/:id/:decision', (req, res) => {
    const decision = req.params.decision
    if (!['approve', 'reject'].includes(decision)) throw notFound()
    const row = ctx.db.prepare("SELECT * FROM requests WHERE id = ? AND type = 'doctor_assignment' AND target_id = ?").get(intParam(req.params.id), req.user.id)
    if (!row) throw notFound('Заявка не найдена')
    const { comment } = validate(req.body, { comment: { type: 'string', maxLength: 500 } })
    res.json(decideAssignment(ctx, req, row, decision, comment))
  })

  return r
}

/** Shared by the doctor and the administrator moderation endpoints (KAN-45). */
export function decideAssignment(ctx, req, row, decision, comment = null) {
  if (row.status !== 'pending') throw conflict('Заявка уже рассмотрена')
  const status = decision === 'approve' ? 'approved' : 'rejected'
  const now = ctx.now().toISOString()
  ctx.db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, comment = ? WHERE id = ?').run(status, req.user.id, now, comment, row.id)
  if (status === 'approved') ctx.db.prepare('UPDATE patient_profiles SET doctor_id = ? WHERE user_id = ?').run(row.target_id, row.user_id)
  notify(ctx, {
    userId: row.user_id,
    title: status === 'approved' ? 'Врач назначен' : 'Заявка отклонена',
    body: status === 'approved' ? `${userName(ctx, row.target_id)} теперь ваш лечащий врач на платформе` : `Заявка к врачу ${userName(ctx, row.target_id)} отклонена${comment ? `: ${comment}` : ''}`,
    kind: 'request',
  })
  audit(ctx, req.user, `request.${status}`, { entity: 'request', entityId: row.id, details: { type: row.type }, ip: req.ip })
  return { id: row.id, status }
}
