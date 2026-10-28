/** In-app push notification feed (KAN-40) and the public list of doctors patients can choose from. */
import { Router } from 'express'
import { intParam, validate } from '../validate.js'
import { notFound } from '../errors.js'
import { requireAuth } from '../middleware/auth.js'
import { userName } from '../services/users.js'

export function miscRouter(ctx) {
  const r = Router()

  r.get('/notifications', requireAuth, (req, res) => {
    const q = validate(req.query, { unread: { type: 'string', enum: ['1', '0'] }, limit: { type: 'number', integer: true, min: 1, max: 200, default: 50 } })
    const rows = ctx.db
      .prepare(`SELECT * FROM notifications WHERE user_id = ? AND channel = 'push' ${q.unread === '1' ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`)
      .all(req.user.id, q.limit)
    const unread = ctx.db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND channel = 'push' AND read_at IS NULL").get(req.user.id).c
    res.json({
      items: rows.map((n) => ({ id: n.id, title: n.title, body: n.body, kind: n.kind, alertId: n.alert_id, createdAt: n.created_at, readAt: n.read_at })),
      unread,
    })
  })

  r.post('/notifications/:id/read', requireAuth, (req, res) => {
    const info = ctx.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(ctx.now().toISOString(), intParam(req.params.id), req.user.id)
    if (!info.changes) throw notFound()
    res.json({ ok: true })
  })

  r.post('/notifications/read-all', requireAuth, (req, res) => {
    ctx.db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND channel = 'push' AND read_at IS NULL").run(ctx.now().toISOString(), req.user.id)
    res.json({ ok: true })
  })

  r.get('/doctors', requireAuth, (_req, res) => {
    const rows = ctx.db.prepare("SELECT u.id, d.specialty FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.role = 'doctor' AND u.status = 'active' ORDER BY u.id").all()
    res.json(rows.map((d) => ({ id: d.id, fullName: userName(ctx, d.id), specialty: d.specialty })))
  })

  return r
}
