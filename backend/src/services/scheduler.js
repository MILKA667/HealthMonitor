/**
 * Background jobs run every minute: alert escalation (KAN-39), reminders, adherence nudges
 * (no measurement for 2 days), retry of failed notifications, optional nightly backup.
 * Every job is idempotent so several API instances may run it (scales horizontally).
 */
import { escalateOverdue } from './alerts.js'
import { notify, retryFailed } from './notify.js'
import { createBackup } from './backup.js'

const WEEKDAY = { Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6', Sun: '7' }

export function localClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: WEEKDAY[parts.weekday] }
}

export function sendDueReminders(ctx) {
  const { date, time, weekday } = localClock(ctx.now(), ctx.config.timezone)
  const due = ctx.db
    .prepare("SELECT r.* FROM reminders r JOIN users u ON u.id = r.patient_id WHERE r.active = 1 AND u.status = 'active' AND r.time_of_day <= ? AND (r.last_sent_on IS NULL OR r.last_sent_on < ?)")
    .all(time, date)
    .filter((r) => r.days.includes(weekday))
  for (const r of due) {
    notify(ctx, {
      userId: r.patient_id,
      title: r.kind === 'medication' ? 'Напоминание о приёме лекарства' : 'Напоминание об измерении',
      body: `${r.title} (${r.time_of_day})`,
      kind: 'reminder',
    })
    ctx.db.prepare('UPDATE reminders SET last_sent_on = ? WHERE id = ?').run(date, r.id)
  }
  return due.length
}

/** Nudges patients who have not entered any measurement for 2 days (risk: low engagement). At most once a day. */
export function sendAdherenceNudges(ctx) {
  const now = ctx.now()
  const { date, time } = localClock(now, ctx.config.timezone)
  if (time < '10:00') return 0
  const cutoff = new Date(now.getTime() - 2 * 86400_000).toISOString()
  const dayStart = new Date(now.getTime() - 20 * 3600_000).toISOString()
  const rows = ctx.db
    .prepare(
      `SELECT u.id FROM users u WHERE u.role = 'patient' AND u.status = 'active' AND u.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM measurements m WHERE m.patient_id = u.id AND m.measured_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.kind = 'adherence' AND n.created_at >= ?)`,
    )
    .all(cutoff, cutoff, dayStart)
  for (const { id } of rows) {
    notify(ctx, { userId: id, title: 'Давно не было измерений', body: `Внесите показатели — лечащий врач видит динамику только по данным измерений (${date}).`, kind: 'adherence' })
  }
  return rows.length
}

function nightlyBackup(ctx) {
  if (!ctx.config.dailyBackup) return false
  const { date, time } = localClock(ctx.now(), ctx.config.timezone)
  if (time < '03:00') return false
  const last = ctx.db.prepare('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1').get()
  if (last && localClock(new Date(last.created_at), ctx.config.timezone).date === date) return false
  createBackup(ctx)
  return true
}

export async function runJobs(ctx) {
  const result = {
    escalated: escalateOverdue(ctx),
    reminders: sendDueReminders(ctx),
    nudges: sendAdherenceNudges(ctx),
    backup: nightlyBackup(ctx),
  }
  await retryFailed(ctx)
  return result
}

export function startScheduler(ctx) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await runJobs(ctx)
    } catch (err) {
      console.error('[scheduler]', err)
    } finally {
      running = false
    }
  }, ctx.config.schedulerIntervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
