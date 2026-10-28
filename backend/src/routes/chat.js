/** Text chat between the patient and the attending doctor (MVP; video is out of scope). */
import { Router } from 'express'
import { forbidden } from '../errors.js'
import { intParam, validate } from '../validate.js'
import { accessPatient, requireAuth } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { notify } from '../services/notify.js'
import { getPatientProfile, userName } from '../services/users.js'

export function chatRouter(ctx) {
  const r = Router()
  r.use(requireAuth)

  /** Conversations of the caller: the patient has one (with the doctor); the doctor one per patient. */
  r.get('/', (req, res) => {
    let patientIds
    if (req.user.role === 'patient') patientIds = [req.user.id]
    else if (req.user.role === 'doctor') patientIds = ctx.db.prepare('SELECT user_id FROM patient_profiles WHERE doctor_id = ?').all(req.user.id).map((x) => x.user_id)
    else throw forbidden('Чат доступен пациенту и лечащему врачу')
    const items = patientIds.map((pid) => {
      const last = ctx.db.prepare('SELECT * FROM messages WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(pid)
      const unread = ctx.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE patient_id = ? AND sender_id <> ? AND read_at IS NULL').get(pid, req.user.id).c
      const profile = getPatientProfile(ctx, pid)
      return {
        patientId: pid,
        patientName: userName(ctx, pid),
        doctorId: profile.doctorId,
        doctorName: profile.doctorName,
        lastMessage: last ? { body: ctx.cipher.decrypt(last.body_enc), createdAt: last.created_at, senderId: last.sender_id } : null,
        unread,
      }
    })
    items.sort((a, b) => String(b.lastMessage?.createdAt ?? '').localeCompare(String(a.lastMessage?.createdAt ?? '')))
    res.json(items)
  })

  r.get('/:patientId', (req, res) => {
    const patientId = intParam(req.params.patientId, 'patientId')
    accessPatient(ctx, req, patientId, 'chat:read', ['self', 'doctor'])
    const q = validate(req.query, { after: { type: 'number', integer: true, min: 0, default: 0 } })
    const rows = ctx.db.prepare('SELECT * FROM messages WHERE patient_id = ? AND id > ? ORDER BY id LIMIT 500').all(patientId, q.after)
    ctx.db.prepare('UPDATE messages SET read_at = ? WHERE patient_id = ? AND sender_id <> ? AND read_at IS NULL').run(ctx.now().toISOString(), patientId, req.user.id)
    res.json(rows.map((m) => ({ id: m.id, senderId: m.sender_id, senderName: userName(ctx, m.sender_id), mine: m.sender_id === req.user.id, body: ctx.cipher.decrypt(m.body_enc), createdAt: m.created_at, readAt: m.read_at })))
  })

  r.post('/:patientId', (req, res) => {
    const patientId = intParam(req.params.patientId, 'patientId')
    accessPatient(ctx, req, patientId, 'chat:write', ['self', 'doctor'])
    const profile = getPatientProfile(ctx, patientId)
    if (!profile.doctorId) throw forbidden('Лечащий врач ещё не назначен', 'NO_DOCTOR')
    const { body } = validate(req.body, { body: { type: 'string', required: true, maxLength: 4000 } })
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO messages (patient_id, sender_id, body_enc, created_at) VALUES (?, ?, ?, ?)')
      .run(patientId, req.user.id, ctx.cipher.encrypt(body), ctx.now().toISOString())
    const recipient = req.user.id === patientId ? profile.doctorId : patientId
    notify(ctx, { userId: recipient, title: `Новое сообщение от ${userName(ctx, req.user.id)}`, body: body.length > 120 ? `${body.slice(0, 117)}...` : body, kind: 'chat' })
    audit(ctx, req.user, 'chat.message_sent', { entity: 'message', entityId: lastInsertRowid, details: { patientId }, ip: req.ip })
    res.status(201).json({ id: Number(lastInsertRowid), senderId: req.user.id, mine: true, body, createdAt: ctx.now().toISOString() })
  })

  return r
}
