/**
 * Patient cabinet: profile & conditions (KAN-24), relatives (KAN-27), manual measurements (KAN-25),
 * history & dynamics (KAN-26), patient card (KAN-30), individual thresholds (KAN-31).
 */
import { Router } from 'express'
import { randomToken, sha256 } from '../crypto.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { intParam, PHONE, validate } from '../validate.js'
import { accessPatient, requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { CONDITIONS, getPatientProfile, publicUser, getUserRow, userName } from '../services/users.js'
import { listMeasurements, recordMeasurement, summarize, TYPES } from '../services/measurements.js'
import { checkThresholdOrder, effectiveThresholds, METRICS } from '../services/thresholds.js'
import { requireHealthConsent } from '../services/consents.js'
import { decodeAlert } from '../services/alerts.js'
import { notify } from '../services/notify.js'

function decodeRelative(ctx, r) {
  return {
    id: r.id,
    name: ctx.cipher.decrypt(r.name_enc),
    phone: ctx.cipher.decrypt(r.phone_enc),
    relation: r.relation,
    notifyEmergency: Boolean(r.notify_emergency),
    linkedAccount: Boolean(r.user_id),
    invitePending: Boolean(r.invite_code_hash),
  }
}

/** Adherence: share of the last 14 days covered by measurements with no gap longer than 2 days. */
export function lastMeasurementAt(ctx, patientId) {
  return ctx.db.prepare('SELECT MAX(measured_at) AS at FROM measurements WHERE patient_id = ?').get(patientId).at
}

export function patientsRouter(ctx) {
  const r = Router()
  r.use(requireAuth)

  const RELATIVE = {
    name: { type: 'string', required: true, minLength: 2, maxLength: 200 },
    phone: { ...PHONE, required: true },
    relation: { type: 'string', maxLength: 50 },
    notifyEmergency: { type: 'boolean', default: true },
  }

  // ---- own profile ----
  r.get('/me/profile', requireRole('patient'), (req, res) => {
    res.json({ user: publicUser(ctx, getUserRow(ctx, req.user.id)), profile: getPatientProfile(ctx, req.user.id) })
  })

  r.put('/me/profile', requireRole('patient'), (req, res) => {
    const input = validate(req.body, {
      fullName: { type: 'string', minLength: 2, maxLength: 200 },
      phone: PHONE,
      conditions: { type: 'array', items: { enum: CONDITIONS } },
      birthDate: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: 'формат ГГГГ-ММ-ДД' },
      notes: { type: 'string', maxLength: 2000 },
      peakFlowBest: { type: 'number', integer: true, min: 50, max: 900 },
    })
    if (input.fullName) ctx.db.prepare('UPDATE users SET full_name_enc = ? WHERE id = ?').run(ctx.cipher.encrypt(input.fullName), req.user.id)
    if (input.phone) ctx.db.prepare('UPDATE users SET phone_enc = ? WHERE id = ?').run(ctx.cipher.encrypt(input.phone), req.user.id)
    if (input.conditions) ctx.db.prepare('UPDATE patient_profiles SET conditions = ? WHERE user_id = ?').run(JSON.stringify([...new Set(input.conditions)]), req.user.id)
    if (input.birthDate) ctx.db.prepare('UPDATE patient_profiles SET birth_date_enc = ? WHERE user_id = ?').run(ctx.cipher.encrypt(input.birthDate), req.user.id)
    if (input.notes !== undefined) ctx.db.prepare('UPDATE patient_profiles SET notes_enc = ? WHERE user_id = ?').run(ctx.cipher.encrypt(input.notes), req.user.id)
    if (input.peakFlowBest) ctx.db.prepare('UPDATE patient_profiles SET peak_flow_best = ? WHERE user_id = ?').run(input.peakFlowBest, req.user.id)
    audit(ctx, req.user, 'patient.profile_updated', { entity: 'patient', entityId: req.user.id, details: { fields: Object.keys(input) }, ip: req.ip })
    res.json({ user: publicUser(ctx, getUserRow(ctx, req.user.id)), profile: getPatientProfile(ctx, req.user.id) })
  })

  // ---- choosing the attending doctor (moderated by the doctor or an administrator) ----
  r.get('/me/doctor-requests', requireRole('patient'), (req, res) => {
    const rows = ctx.db.prepare("SELECT * FROM requests WHERE user_id = ? AND type = 'doctor_assignment' ORDER BY id DESC").all(req.user.id)
    res.json(rows.map((x) => ({ id: x.id, doctorId: x.target_id, doctorName: userName(ctx, x.target_id), status: x.status, comment: x.comment, createdAt: x.created_at })))
  })

  r.post('/me/doctor-requests', requireRole('patient'), (req, res) => {
    const { doctorId } = validate(req.body, { doctorId: { type: 'number', integer: true, required: true } })
    const doctor = ctx.db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor' AND status = 'active'").get(doctorId)
    if (!doctor) throw notFound('Врач не найден')
    if (ctx.db.prepare("SELECT 1 FROM requests WHERE user_id = ? AND type = 'doctor_assignment' AND status = 'pending'").get(req.user.id)) {
      throw conflict('Уже есть заявка на рассмотрении')
    }
    const { lastInsertRowid } = ctx.db
      .prepare("INSERT INTO requests (type, user_id, target_id, created_at) VALUES ('doctor_assignment', ?, ?, ?)")
      .run(req.user.id, doctorId, ctx.now().toISOString())
    notify(ctx, { userId: doctorId, title: 'Новая заявка пациента', body: `${userName(ctx, req.user.id)} просит взять его под наблюдение`, kind: 'request' })
    audit(ctx, req.user, 'patient.doctor_requested', { entity: 'request', entityId: lastInsertRowid, details: { doctorId }, ip: req.ip })
    res.status(201).json({ id: Number(lastInsertRowid), status: 'pending' })
  })

  // ---- relatives' contacts ----
  r.get('/me/relatives', requireRole('patient'), (req, res) => {
    res.json(ctx.db.prepare('SELECT * FROM relatives WHERE patient_id = ? ORDER BY id').all(req.user.id).map((x) => decodeRelative(ctx, x)))
  })

  r.post('/me/relatives', requireRole('patient'), (req, res) => {
    const input = validate(req.body, RELATIVE)
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM relatives WHERE patient_id = ?').get(req.user.id).c
    if (count >= 10) throw badRequest('Не более 10 контактов родственников')
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO relatives (patient_id, name_enc, phone_enc, relation, notify_emergency, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, ctx.cipher.encrypt(input.name), ctx.cipher.encrypt(input.phone), input.relation ?? null, input.notifyEmergency ? 1 : 0, ctx.now().toISOString())
    audit(ctx, req.user, 'patient.relative_added', { entity: 'relative', entityId: lastInsertRowid, ip: req.ip })
    res.status(201).json(decodeRelative(ctx, ctx.db.prepare('SELECT * FROM relatives WHERE id = ?').get(lastInsertRowid)))
  })

  function ownRelative(req) {
    const row = ctx.db.prepare('SELECT * FROM relatives WHERE id = ? AND patient_id = ?').get(intParam(req.params.id), req.user.id)
    if (!row) throw notFound('Контакт не найден')
    return row
  }

  r.put('/me/relatives/:id', requireRole('patient'), (req, res) => {
    const row = ownRelative(req)
    const input = validate(req.body, { ...RELATIVE, name: { ...RELATIVE.name, required: false }, phone: { ...RELATIVE.phone, required: false }, notifyEmergency: { type: 'boolean' } })
    ctx.db
      .prepare('UPDATE relatives SET name_enc = ?, phone_enc = ?, relation = ?, notify_emergency = ? WHERE id = ?')
      .run(
        input.name ? ctx.cipher.encrypt(input.name) : row.name_enc,
        input.phone ? ctx.cipher.encrypt(input.phone) : row.phone_enc,
        input.relation ?? row.relation,
        input.notifyEmergency === undefined ? row.notify_emergency : input.notifyEmergency ? 1 : 0,
        row.id,
      )
    audit(ctx, req.user, 'patient.relative_updated', { entity: 'relative', entityId: row.id, ip: req.ip })
    res.json(decodeRelative(ctx, ctx.db.prepare('SELECT * FROM relatives WHERE id = ?').get(row.id)))
  })

  r.delete('/me/relatives/:id', requireRole('patient'), (req, res) => {
    const row = ownRelative(req)
    ctx.db.prepare('DELETE FROM relatives WHERE id = ?').run(row.id)
    audit(ctx, req.user, 'patient.relative_removed', { entity: 'relative', entityId: row.id, ip: req.ip })
    res.status(204).end()
  })

  /** One-time invite code that lets the relative create an account linked to the patient (read-only access). */
  r.post('/me/relatives/:id/invite', requireRole('patient'), (req, res) => {
    const row = ownRelative(req)
    if (row.user_id) throw conflict('Родственник уже подключён')
    const code = randomToken(9)
    ctx.db.prepare('UPDATE relatives SET invite_code_hash = ? WHERE id = ?').run(sha256(code), row.id)
    notify(ctx, {
      phone: ctx.cipher.decrypt(row.phone_enc),
      channels: ['sms'],
      title: 'HealthMonitor',
      body: `${userName(ctx, req.user.id)} приглашает вас в HealthMonitor. Код приглашения: ${code}`,
      kind: 'invite',
    })
    audit(ctx, req.user, 'patient.relative_invited', { entity: 'relative', entityId: row.id, ip: req.ip })
    res.json({ inviteCode: code })
  })

  // ---- measurements ----
  r.post('/:id/measurements', (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'measurements:write', ['self'])
    requireHealthConsent(ctx, patientId)
    const input = validate(req.body, {
      type: { type: 'string', required: true, enum: TYPES },
      value: { required: true },
      measuredAt: { type: 'date' },
    })
    if (typeof input.value !== 'object' || Array.isArray(input.value)) throw badRequest('value должно быть объектом')
    const m = recordMeasurement(ctx, { patientId, type: input.type, raw: input.value, measuredAt: input.measuredAt })
    audit(ctx, req.user, 'measurement.created', { entity: 'measurement', entityId: m.id, details: { type: m.type, source: 'manual' }, ip: req.ip })
    res.status(201).json(m)
  })

  r.get('/:id/measurements', (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'measurements:read')
    const q = validate(req.query, {
      type: { type: 'string', enum: TYPES },
      from: { type: 'date' },
      to: { type: 'date' },
      limit: { type: 'number', integer: true, min: 1, max: 5000 },
    })
    const items = listMeasurements(ctx, patientId, q)
    res.json({ items, summary: summarize(items, effectiveThresholds(ctx, patientId)) })
  })

  r.delete('/:id/measurements/:mid', (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'measurements:delete', ['self'])
    const m = ctx.db.prepare("SELECT * FROM measurements WHERE id = ? AND patient_id = ? AND source = 'manual'").get(intParam(req.params.mid, 'mid'), patientId)
    if (!m) throw notFound('Показание не найдено')
    if (ctx.db.prepare('SELECT 1 FROM alerts WHERE measurement_id = ?').get(m.id)) throw conflict('По показанию создан алерт — удаление недоступно')
    ctx.db.prepare('DELETE FROM measurements WHERE id = ?').run(m.id)
    audit(ctx, req.user, 'measurement.deleted', { entity: 'measurement', entityId: m.id, ip: req.ip })
    res.status(204).end()
  })

  // ---- patient card (doctor/relative view, KAN-30) ----
  r.get('/:id', (req, res) => {
    const patientId = intParam(req.params.id)
    const relation = accessPatient(ctx, req, patientId, 'card')
    const user = publicUser(ctx, getUserRow(ctx, patientId))
    const profile = getPatientProfile(ctx, patientId)
    const since = new Date(ctx.now().getTime() - 30 * 86400_000).toISOString()
    const recent = listMeasurements(ctx, patientId, { from: since })
    const alerts = ctx.db.prepare('SELECT * FROM alerts WHERE patient_id = ? ORDER BY created_at DESC LIMIT 20').all(patientId).map((a) => decodeAlert(ctx, a))
    const card = {
      patient: { id: user.id, fullName: user.fullName, phone: relation === 'relative' ? undefined : user.phone, email: relation === 'doctor' ? user.email : undefined },
      profile: relation === 'relative' ? { conditions: profile.conditions, doctorName: profile.doctorName } : profile,
      summary30d: summarize(recent, effectiveThresholds(ctx, patientId)),
      lastMeasurementAt: lastMeasurementAt(ctx, patientId),
      alerts,
    }
    if (relation === 'doctor') {
      card.relatives = ctx.db.prepare('SELECT * FROM relatives WHERE patient_id = ?').all(patientId).map((x) => decodeRelative(ctx, x))
      card.thresholds = effectiveThresholds(ctx, patientId)
    }
    res.json(card)
  })

  // ---- thresholds (KAN-31) ----
  r.get('/:id/thresholds', (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'thresholds:read', ['self', 'doctor'])
    res.json({ metrics: METRICS, thresholds: effectiveThresholds(ctx, patientId) })
  })

  r.put('/:id/thresholds/:metric', (req, res) => {
    const patientId = intParam(req.params.id)
    if (req.user.role !== 'doctor') throw forbidden('Пороговые значения задаёт лечащий врач')
    accessPatient(ctx, req, patientId, 'thresholds:write', ['doctor'])
    const metric = req.params.metric
    if (!METRICS[metric]) throw badRequest('Неизвестный показатель')
    const num = { type: 'number', min: 0, max: 1000 }
    const t = validate(req.body, { critLow: num, warnLow: num, warnHigh: num, critHigh: num })
    if (!checkThresholdOrder(t)) throw badRequest('Пороги должны идти по возрастанию: critLow ≤ warnLow ≤ warnHigh ≤ critHigh')
    ctx.db
      .prepare(
        `INSERT INTO thresholds (patient_id, metric, crit_low, warn_low, warn_high, crit_high, set_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (patient_id, metric) DO UPDATE SET crit_low = excluded.crit_low, warn_low = excluded.warn_low,
           warn_high = excluded.warn_high, crit_high = excluded.crit_high, set_by = excluded.set_by, updated_at = excluded.updated_at`,
      )
      .run(patientId, metric, t.critLow ?? null, t.warnLow ?? null, t.warnHigh ?? null, t.critHigh ?? null, req.user.id, ctx.now().toISOString())
    audit(ctx, req.user, 'thresholds.updated', { entity: 'patient', entityId: patientId, details: { metric, ...t }, ip: req.ip })
    res.json(effectiveThresholds(ctx, patientId)[metric])
  })

  r.delete('/:id/thresholds/:metric', (req, res) => {
    const patientId = intParam(req.params.id)
    if (req.user.role !== 'doctor') throw forbidden('Пороговые значения задаёт лечащий врач')
    accessPatient(ctx, req, patientId, 'thresholds:write', ['doctor'])
    ctx.db.prepare('DELETE FROM thresholds WHERE patient_id = ? AND metric = ?').run(patientId, req.params.metric)
    audit(ctx, req.user, 'thresholds.reset', { entity: 'patient', entityId: patientId, details: { metric: req.params.metric }, ip: req.ip })
    res.json(effectiveThresholds(ctx, patientId)[req.params.metric] ?? null)
  })

  return r
}
