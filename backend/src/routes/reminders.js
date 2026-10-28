/** Medication and measurement reminders in the patient cabinet. Delivery is done by the scheduler. */
import { Router } from 'express'
import { notFound } from '../errors.js'
import { intParam, validate } from '../validate.js'
import { requireRole } from '../middleware/auth.js'
import { audit } from '../services/audit.js'

const SCHEMA = {
  kind: { type: 'string', required: true, enum: ['medication', 'measurement'] },
  title: { type: 'string', required: true, minLength: 2, maxLength: 200 },
  timeOfDay: { type: 'string', required: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: 'формат ЧЧ:ММ' },
  days: { type: 'string', pattern: /^[1-7]{1,7}$/, patternMessage: 'дни недели 1–7, например 135', default: '1234567' },
  active: { type: 'boolean', default: true },
}

const decode = (x) => ({ id: x.id, kind: x.kind, title: x.title, timeOfDay: x.time_of_day, days: x.days, active: Boolean(x.active), lastSentOn: x.last_sent_on })

export function remindersRouter(ctx) {
  const r = Router()
  r.use(requireRole('patient'))

  r.get('/', (req, res) => {
    res.json(ctx.db.prepare('SELECT * FROM reminders WHERE patient_id = ? ORDER BY time_of_day').all(req.user.id).map(decode))
  })

  r.post('/', (req, res) => {
    const x = validate(req.body, SCHEMA)
    const days = [...new Set(x.days)].sort().join('')
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO reminders (patient_id, kind, title, time_of_day, days, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, x.kind, x.title, x.timeOfDay, days, x.active ? 1 : 0, ctx.now().toISOString())
    audit(ctx, req.user, 'reminder.created', { entity: 'reminder', entityId: lastInsertRowid, ip: req.ip })
    res.status(201).json(decode(ctx.db.prepare('SELECT * FROM reminders WHERE id = ?').get(lastInsertRowid)))
  })

  function own(req) {
    const row = ctx.db.prepare('SELECT * FROM reminders WHERE id = ? AND patient_id = ?').get(intParam(req.params.id), req.user.id)
    if (!row) throw notFound('Напоминание не найдено')
    return row
  }

  r.put('/:id', (req, res) => {
    const row = own(req)
    const partial = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, { ...v, required: false, default: undefined }]))
    const x = validate(req.body, partial)
    ctx.db
      .prepare('UPDATE reminders SET kind = ?, title = ?, time_of_day = ?, days = ?, active = ? WHERE id = ?')
      .run(x.kind ?? row.kind, x.title ?? row.title, x.timeOfDay ?? row.time_of_day, x.days ? [...new Set(x.days)].sort().join('') : row.days, x.active === undefined ? row.active : x.active ? 1 : 0, row.id)
    audit(ctx, req.user, 'reminder.updated', { entity: 'reminder', entityId: row.id, ip: req.ip })
    res.json(decode(ctx.db.prepare('SELECT * FROM reminders WHERE id = ?').get(row.id)))
  })

  r.delete('/:id', (req, res) => {
    const row = own(req)
    ctx.db.prepare('DELETE FROM reminders WHERE id = ?').run(row.id)
    audit(ctx, req.user, 'reminder.deleted', { entity: 'reminder', entityId: row.id, ip: req.ip })
    res.status(204).end()
  })

  return r
}
