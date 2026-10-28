/**
 * Administration panel API: users (KAN-43), roles and rights (KAN-44), moderation of requests (KAN-45),
 * audit (KAN-46), medical data access journal (KAN-48), consent versions (KAN-49), backups (KAN-50), metrics.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { badRequest, conflict, notFound } from '../errors.js'
import { EMAIL, intParam, PASSWORD, PHONE, validate } from '../validate.js'
import { PERMISSIONS, requireRole } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { ROLES, createUser, emailIndex, getPatientProfile, publicUser, requireUser, userName } from '../services/users.js'
import { notify } from '../services/notify.js'
import { platformMetrics } from '../services/analytics.js'
import { createBackup, verifyBackup } from '../services/backup.js'
import { publishDocument } from '../services/consents.js'
import { decideAssignment } from './alerts.js'
import { transaction } from '../db.js'

export function adminRouter(ctx) {
  const r = Router()
  r.use(requireRole('admin'))

  r.get('/roles', (_req, res) => res.json(PERMISSIONS))

  r.get('/users', (req, res) => {
    const q = validate(req.query, {
      role: { type: 'string', enum: ROLES },
      status: { type: 'string', enum: ['active', 'pending', 'blocked', 'rejected'] },
      email: { type: 'string', maxLength: 254 },
      q: { type: 'string', maxLength: 100 },
      offset: { type: 'number', integer: true, min: 0, default: 0 },
      limit: { type: 'number', integer: true, min: 1, max: 200, default: 50 },
    })
    const where = ['1 = 1']
    const args = []
    if (q.role) { where.push('role = ?'); args.push(q.role) }
    if (q.status) { where.push('status = ?'); args.push(q.status) }
    if (q.email) { where.push('email_idx = ?'); args.push(emailIndex(ctx, q.email)) }
    const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where.join(' AND ')}`).get(...args).c
    let rows = ctx.db.prepare(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset)
    const doctorOf = ctx.db.prepare('SELECT doctor_id FROM patient_profiles WHERE user_id = ?')
    let users = rows.map((u) => ({ ...publicUser(ctx, u), loginCount: u.login_count, ...(u.role === 'patient' ? { doctorId: doctorOf.get(u.id)?.doctor_id ?? null } : {}) }))
    // Names are encrypted at rest, so the free-text filter is applied after decryption on the page.
    if (q.q) users = users.filter((u) => u.fullName.toLowerCase().includes(q.q.toLowerCase()))
    res.json({ items: users, total })
  })

  r.post('/users', (req, res) => {
    const input = validate(req.body, {
      role: { type: 'string', required: true, enum: ['doctor', 'admin'] },
      email: EMAIL,
      password: PASSWORD,
      fullName: { type: 'string', required: true, minLength: 2, maxLength: 200 },
      phone: PHONE,
      specialty: { type: 'string', maxLength: 200 },
    })
    const id = transaction(ctx.db, () => {
      const id = createUser(ctx, input)
      if (input.role === 'doctor' && input.specialty) ctx.db.prepare('UPDATE doctor_profiles SET specialty = ? WHERE user_id = ?').run(input.specialty, id)
      return id
    })
    audit(ctx, req.user, 'admin.user_created', { entity: 'user', entityId: id, details: { role: input.role }, ip: req.ip })
    res.status(201).json(publicUser(ctx, requireUser(ctx, id)))
  })

  r.get('/users/:id', (req, res) => {
    const u = requireUser(ctx, intParam(req.params.id))
    const out = { ...publicUser(ctx, u), loginCount: u.login_count }
    if (u.role === 'patient') {
      const p = getPatientProfile(ctx, u.id)
      out.patient = { conditions: p.conditions, doctorId: p.doctorId, doctorName: p.doctorName }
    }
    res.json(out)
  })

  r.patch('/users/:id', (req, res) => {
    const target = requireUser(ctx, intParam(req.params.id))
    const input = validate(req.body, {
      role: { type: 'string', enum: ROLES },
      status: { type: 'string', enum: ['active', 'blocked'] },
      doctorId: { type: 'number', integer: true, min: 0 },
    })
    const changingAdmin = target.role === 'admin' && ((input.role && input.role !== 'admin') || input.status === 'blocked')
    if (changingAdmin) {
      if (target.id === req.user.id) throw badRequest('Нельзя заблокировать или понизить собственную учётную запись')
      const admins = ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'").get().c
      if (admins <= 1) throw conflict('Нельзя удалить последнего администратора')
    }
    transaction(ctx.db, () => {
      if (input.role && input.role !== target.role) {
        if (input.role === 'patient') ctx.db.prepare('INSERT OR IGNORE INTO patient_profiles (user_id) VALUES (?)').run(target.id)
        if (input.role === 'doctor') ctx.db.prepare('INSERT OR IGNORE INTO doctor_profiles (user_id) VALUES (?)').run(target.id)
        if (target.role === 'doctor') ctx.db.prepare('UPDATE patient_profiles SET doctor_id = NULL WHERE doctor_id = ?').run(target.id)
        ctx.db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(input.role, target.id)
      }
      if (input.status && input.status !== target.status) {
        ctx.db.prepare('UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?').run(input.status, target.id)
      }
      if (input.doctorId !== undefined) {
        if (target.role !== 'patient' && input.role !== 'patient') throw badRequest('Лечащий врач назначается только пациенту')
        if (input.doctorId && !ctx.db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'doctor' AND status = 'active'").get(input.doctorId)) throw notFound('Врач не найден')
        ctx.db.prepare('UPDATE patient_profiles SET doctor_id = ? WHERE user_id = ?').run(input.doctorId || null, target.id)
      }
    })
    audit(ctx, req.user, 'admin.user_updated', { entity: 'user', entityId: target.id, details: input, ip: req.ip })
    res.json(publicUser(ctx, requireUser(ctx, target.id)))
  })

  // ---- moderation (KAN-45) ----
  r.get('/requests', (req, res) => {
    const q = validate(req.query, { status: { type: 'string', enum: ['pending', 'approved', 'rejected'], default: 'pending' } })
    const rows = ctx.db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY id DESC LIMIT 200').all(q.status)
    res.json(
      rows.map((x) => {
        const u = publicUser(ctx, requireUser(ctx, x.user_id))
        const extra = {}
        if (x.type === 'doctor_registration') {
          const d = ctx.db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(x.user_id)
          extra.specialty = d?.specialty
          extra.licenseNumber = ctx.cipher.decrypt(d?.license_enc ?? null)
        }
        return { id: x.id, type: x.type, status: x.status, user: { id: u.id, fullName: u.fullName, email: u.email, role: u.role }, targetId: x.target_id, targetName: x.target_id ? userName(ctx, x.target_id) : null, comment: x.comment, createdAt: x.created_at, reviewedAt: x.reviewed_at, ...extra }
      }),
    )
  })

  r.post('/requests/:id/:decision', (req, res) => {
    const decision = req.params.decision
    if (!['approve', 'reject'].includes(decision)) throw notFound()
    const row = ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(intParam(req.params.id))
    if (!row) throw notFound('Заявка не найдена')
    const { comment } = validate(req.body, { comment: { type: 'string', maxLength: 500 } })
    if (row.type === 'doctor_assignment') return res.json(decideAssignment(ctx, req, row, decision, comment))
    if (row.status !== 'pending') throw conflict('Заявка уже рассмотрена')
    const status = decision === 'approve' ? 'approved' : 'rejected'
    transaction(ctx.db, () => {
      ctx.db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, comment = ? WHERE id = ?').run(status, req.user.id, ctx.now().toISOString(), comment ?? null, row.id)
      ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status === 'approved' ? 'active' : 'rejected', row.user_id)
    })
    notify(ctx, {
      userId: row.user_id,
      channels: ['sms'],
      title: 'HealthMonitor',
      body: status === 'approved' ? 'Ваша учётная запись врача подтверждена. Можно входить в систему.' : `Заявка на регистрацию врача отклонена${comment ? `: ${comment}` : ''}.`,
      kind: 'moderation',
    })
    audit(ctx, req.user, `request.${status}`, { entity: 'request', entityId: row.id, details: { type: row.type, userId: row.user_id }, ip: req.ip })
    res.json({ id: row.id, status })
  })

  // ---- audit & access journal ----
  r.get('/audit', (req, res) => {
    const q = validate(req.query, {
      userId: { type: 'number', integer: true },
      action: { type: 'string', maxLength: 100 },
      from: { type: 'date' },
      to: { type: 'date' },
      offset: { type: 'number', integer: true, min: 0, default: 0 },
      limit: { type: 'number', integer: true, min: 1, max: 500, default: 100 },
    })
    const where = ['1 = 1']
    const args = []
    if (q.userId) { where.push('user_id = ?'); args.push(q.userId) }
    if (q.action) { where.push('action LIKE ?'); args.push(`${q.action}%`) }
    if (q.from) { where.push('at >= ?'); args.push(q.from) }
    if (q.to) { where.push('at <= ?'); args.push(q.to) }
    const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${where.join(' AND ')}`).get(...args).c
    const rows = ctx.db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset)
    res.json({ total, items: rows.map((a) => ({ id: a.id, userId: a.user_id, userName: a.user_id ? userName(ctx, a.user_id) : null, role: a.role, action: a.action, entity: a.entity, entityId: a.entity_id, ip: a.ip, details: a.details ? JSON.parse(a.details) : null, at: a.at })) })
  })

  r.get('/access-log', (req, res) => {
    const q = validate(req.query, {
      patientId: { type: 'number', integer: true },
      userId: { type: 'number', integer: true },
      offset: { type: 'number', integer: true, min: 0, default: 0 },
      limit: { type: 'number', integer: true, min: 1, max: 500, default: 100 },
    })
    const where = ['1 = 1']
    const args = []
    if (q.patientId) { where.push('patient_id = ?'); args.push(q.patientId) }
    if (q.userId) { where.push('user_id = ?'); args.push(q.userId) }
    const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM data_access_log WHERE ${where.join(' AND ')}`).get(...args).c
    const rows = ctx.db.prepare(`SELECT * FROM data_access_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset)
    res.json({ total, items: rows.map((a) => ({ id: a.id, userId: a.user_id, userName: userName(ctx, a.user_id), role: a.role, patientId: a.patient_id, patientName: userName(ctx, a.patient_id), resource: a.resource, ip: a.ip, at: a.at })) })
  })

  r.get('/metrics', (req, res) => {
    const q = validate(req.query, { windowDays: { type: 'number', integer: true, min: 1, max: 90, default: 14 } })
    res.json(platformMetrics(ctx, q))
  })

  r.get('/notifications', (req, res) => {
    const q = validate(req.query, { status: { type: 'string', enum: ['queued', 'sent', 'failed'] }, limit: { type: 'number', integer: true, min: 1, max: 500, default: 100 } })
    const rows = ctx.db.prepare(`SELECT * FROM notifications ${q.status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(q.status ? [q.status, q.limit] : [q.limit]))
    // Message bodies may contain one-time codes and health data, so only delivery metadata is shown.
    res.json(rows.map((n) => ({ id: n.id, userId: n.user_id, channel: n.channel, kind: n.kind, title: n.title, status: n.status, error: n.error, createdAt: n.created_at, sentAt: n.sent_at })))
  })

  // ---- consents ----
  r.post('/consent-documents', (req, res) => {
    const input = validate(req.body, {
      type: { type: 'string', required: true, enum: ['personal_data', 'health_data', 'user_agreement'] },
      version: { type: 'string', required: true, maxLength: 20, pattern: /^\d+\.\d+$/ },
      title: { type: 'string', required: true, maxLength: 300 },
      body: { type: 'string', required: true, maxLength: 20000 },
    })
    const id = publishDocument(ctx, input)
    audit(ctx, req.user, 'consent.document_published', { entity: 'consent_document', entityId: id, details: { type: input.type, version: input.version }, ip: req.ip })
    res.status(201).json({ id })
  })

  // ---- backups (KAN-50) ----
  r.get('/backups', (_req, res) => {
    const rows = ctx.db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 100').all()
    res.json(rows.map((b) => ({ id: b.id, file: b.file, size: b.size, sha256: b.sha256, createdAt: b.created_at, createdBy: b.created_by, exists: fs.existsSync(path.join(path.resolve(ctx.config.backupDir), b.file)) })))
  })

  r.post('/backups', (req, res) => {
    const b = createBackup(ctx, { userId: req.user.id })
    audit(ctx, req.user, 'backup.created', { entity: 'backup', details: { file: b.name, size: b.size }, ip: req.ip })
    res.status(201).json({ file: b.name, size: b.size, sha256: b.sha256, verification: verifyBackup(ctx.cipher, b.file) })
  })

  return r
}
