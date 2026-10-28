/**
 * Notification outbox (KAN-40 push, KAN-41 SMS). Every notification is first written to the
 * `notifications` table, then handed to the configured provider. Push notifications are delivered
 * in-app (the web client polls /api/notifications); SMS go through an SMS gateway provider.
 */
import { userPhone } from './users.js'

export const providers = {
  /** Development/test provider: the message stays in the outbox and is marked sent. */
  outbox: { async send() {} },
  /** Generic HTTPS SMS gateway (Russian operator), configured with HM_SMS_GATEWAY_URL. */
  http: {
    async send(ctx, n, recipient) {
      const res = await fetch(ctx.config.smsGatewayUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: recipient, text: `${n.title}. ${n.body}` }),
      })
      if (!res.ok) throw new Error(`SMS gateway responded ${res.status}`)
    },
  },
}

export function notify(ctx, { userId = null, channels = ['push'], title, body, kind, alertId = null, phone = null }) {
  const ids = []
  for (const channel of channels) {
    let recipient = null
    if (channel === 'sms') {
      recipient = phone ?? (userId ? userPhone(ctx, userId) : null)
      if (!recipient) continue
    } else if (!userId) {
      continue
    }
    const { lastInsertRowid } = ctx.db
      .prepare(
        `INSERT INTO notifications (user_id, channel, recipient_enc, title, body, kind, alert_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, channel, ctx.cipher.encrypt(recipient), title, body, kind, alertId, ctx.now().toISOString())
    ids.push(Number(lastInsertRowid))
  }
  if (ids.length) deliverQueued(ctx).catch(() => {})
  return ids
}

let delivering = Promise.resolve()

/** Sends queued notifications through providers. Serialized so concurrent calls do not double-send. */
export function deliverQueued(ctx) {
  delivering = delivering.then(async () => {
    const queued = ctx.db.prepare("SELECT * FROM notifications WHERE status = 'queued' ORDER BY id LIMIT 200").all()
    for (const n of queued) {
      const providerName = n.channel === 'sms' ? ctx.config.smsProvider : ctx.config.pushProvider
      const provider = providers[providerName] ?? providers.outbox
      try {
        await provider.send(ctx, n, ctx.cipher.decrypt(n.recipient_enc))
        ctx.db.prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?").run(ctx.now().toISOString(), n.id)
      } catch (err) {
        ctx.db.prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?").run(String(err.message), n.id)
      }
    }
  })
  return delivering
}

export function retryFailed(ctx) {
  ctx.db.prepare("UPDATE notifications SET status = 'queued', error = NULL WHERE status = 'failed'").run()
  return deliverQueued(ctx)
}
