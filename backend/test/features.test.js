import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startTestServer } from './helpers.js'
import { runJobs } from '../src/services/scheduler.js'
import { restoreBackup } from '../src/services/backup.js'

let t
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-backup-test-'))
before(async () => { t = await startTestServer({ backupDir }) })
after(async () => {
  await t.close()
  fs.rmSync(backupDir, { recursive: true, force: true })
})

test('glucometer integration: pairing, ingest mg/dL, dedupe, validation, alerts', async () => {
  const doc = await t.createDoctor()
  const p = await t.patientOf(doc)
  const adapters = (await t.api('GET', '/api/devices/adapters')).body
  assert.ok(adapters.some((a) => a.id === 'glucometer-v1') && adapters.some((a) => a.id === 'tonometer-v1'))
  const pair = await t.api('POST', '/api/devices', { token: p.token, body: { adapter: 'glucometer-v1', model: 'GL-100', serial: 'GL100-0001' } })
  assert.equal(pair.status, 201)
  assert.equal(pair.body.device.kind, 'glucometer')
  const key = pair.body.apiKey
  assert.match(key, /^hmd_/)
  assert.ok(!JSON.stringify(t.ctx.db.prepare('SELECT * FROM devices').all()).includes(key), 'key stored hashed')
  assert.equal((await t.api('POST', '/api/devices', { token: p.token, body: { adapter: 'glucometer-v1', model: 'GL-100', serial: 'GL100-0001' } })).status, 409)

  const now = t.ctx.now().getTime()
  const payload = {
    serial: 'GL100-0001',
    readings: [
      { timestamp: new Date(now - 7200_000).toISOString(), glucose: 99, unit: 'mg/dL', mealFlag: 'F' },
      { timestamp: new Date(now - 3600_000).toISOString(), glucose: 7.2, unit: 'mmol/L' },
      { timestamp: new Date(now - 1800_000).toISOString(), glucose: 300, unit: 'mg/dL' },
      { timestamp: new Date(now - 600_000).toISOString(), glucose: 5000, unit: 'mg/dL' },
    ],
  }
  assert.equal((await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: payload })).status, 401)
  assert.equal((await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: payload, headers: { 'x-device-key': 'hmd_wrong' } })).status, 401)
  assert.equal((await t.api('POST', '/api/integrations/tonometer-v1/readings', { body: payload, headers: { 'x-device-key': key } })).status, 401, 'key bound to adapter')
  assert.equal((await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: { ...payload, serial: 'OTHER' }, headers: { 'x-device-key': key } })).status, 403)
  const res = await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: payload, headers: { 'x-device-key': key } })
  assert.equal(res.status, 200)
  assert.equal(res.body.accepted, 3)
  assert.equal(res.body.rejected.length, 1)
  assert.equal(res.body.rejected[0].index, 3)
  assert.equal(res.body.alerts, 1, '300 mg/dL = 16.7 mmol/L is critical')
  const again = await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: payload, headers: { 'x-device-key': key } })
  assert.equal(again.body.duplicates, 3)
  assert.equal(again.body.accepted, 0)
  const hist = await t.api('GET', `/api/patients/${p.user.id}/measurements?type=glucose`, { token: p.token })
  assert.deepEqual(hist.body.items.map((m) => m.value.glucose).sort((a, b) => a - b), [5.5, 7.2, 16.7])
  assert.ok(hist.body.items.every((m) => m.source === 'device'))
  assert.equal(hist.body.items.find((m) => m.value.glucose === 5.5).value.context, 'fasting')
  const devices = await t.api('GET', '/api/devices', { token: p.token })
  assert.ok(devices.body[0].lastSyncAt)

  assert.equal((await t.api('DELETE', `/api/devices/${pair.body.device.id}`, { token: p.token })).status, 204)
  assert.equal((await t.api('POST', '/api/integrations/glucometer-v1/readings', { body: payload, headers: { 'x-device-key': key } })).status, 401, 'unlinked device key is revoked')
})

test('tonometer integration and Health Connect adapter', async () => {
  const p = await t.registerPatient({ conditions: ['hypertension'] })
  const pair = await t.api('POST', '/api/devices', { token: p.token, body: { adapter: 'tonometer-v1', model: 'BP-300', serial: 'BP300-77' } })
  const now = t.ctx.now().getTime()
  const r = await t.api('POST', '/api/integrations/tonometer-v1/readings', {
    headers: { 'x-device-key': pair.body.apiKey },
    body: { deviceSerial: 'BP300-77', measurements: [{ dateTime: new Date(now - 60_000).toISOString(), sys: 128, dia: 82, pulse: 66 }, { dateTime: new Date(now - 120_000).toISOString(), sys: 70, dia: 90 }] },
  })
  assert.equal(r.body.accepted, 1)
  assert.equal(r.body.rejected.length, 1)

  assert.equal((await t.api('POST', '/api/devices', { token: p.token, body: { adapter: 'health-connect', model: 'Health Connect', serial: 'phone-1' } })).status, 400, 'kind required for generic adapter')
  const hc = await t.api('POST', '/api/devices', { token: p.token, body: { adapter: 'health-connect', kind: 'tonometer', model: 'Health Connect', serial: 'phone-1' } })
  assert.equal(hc.status, 201)
  const r2 = await t.api('POST', '/api/integrations/health-connect/readings', {
    headers: { 'x-device-key': hc.body.apiKey },
    body: { dataPoints: [{ dataType: 'BloodPressure', time: new Date(now - 30_000).toISOString(), value: { systolicMmHg: 135, diastolicMmHg: 88, pulseBpm: 75 } }, { dataType: 'BloodGlucose', time: new Date(now).toISOString(), value: { mmolPerL: 5 } }, { dataType: 'Steps', time: new Date(now).toISOString() }] },
  })
  assert.equal(r2.body.accepted, 1)
  assert.equal(r2.body.rejected.length, 2, 'glucose on a tonometer binding and unsupported type are rejected')
})

test('chat between patient and attending doctor', async () => {
  const doc = await t.createDoctor('Доктор Чат')
  const p = await t.patientOf(doc)
  const lonely = await t.registerPatient()
  assert.equal((await t.api('POST', `/api/chat/${lonely.user.id}`, { token: lonely.token, body: { body: 'есть кто?' } })).status, 403)
  const m1 = await t.api('POST', `/api/chat/${p.user.id}`, { token: p.token, body: { body: 'Здравствуйте, сахар скачет' } })
  assert.equal(m1.status, 201)
  const m2 = await t.api('POST', `/api/chat/${p.user.id}`, { token: doc.token, body: { body: 'Пришлите замеры за неделю' } })
  assert.equal(m2.status, 201)
  const convs = await t.api('GET', '/api/chat', { token: doc.token })
  assert.equal(convs.body.find((c) => c.patientId === p.user.id).unread, 1)
  const thread = await t.api('GET', `/api/chat/${p.user.id}`, { token: doc.token })
  assert.deepEqual(thread.body.map((m) => m.body), ['Здравствуйте, сахар скачет', 'Пришлите замеры за неделю'])
  assert.equal(thread.body[1].mine, true)
  const after = await t.api('GET', `/api/chat/${p.user.id}?after=${m1.body.id}`, { token: p.token })
  assert.equal(after.body.length, 1)
  assert.ok(t.outbox({ user_id: doc.user.id, kind: 'chat' }).length === 1)
  const stranger = await t.createDoctor()
  assert.equal((await t.api('GET', `/api/chat/${p.user.id}`, { token: stranger.token })).status, 403)
  assert.ok(!JSON.stringify(t.ctx.db.prepare('SELECT * FROM messages').all()).includes('сахар'), 'messages encrypted')
})

test('reminders are delivered once per day on selected weekdays', async () => {
  t.setNow('2026-10-05T05:00:00.000Z') // Monday 08:00 Moscow
  const p = await t.registerPatient()
  const r1 = await t.api('POST', '/api/reminders', { token: p.token, body: { kind: 'medication', title: 'Метформин 500 мг', timeOfDay: '08:00' } })
  assert.equal(r1.status, 201)
  await t.api('POST', '/api/reminders', { token: p.token, body: { kind: 'measurement', title: 'Измерить давление', timeOfDay: '07:30', days: '67' } })
  assert.equal((await t.api('POST', '/api/reminders', { token: p.token, body: { kind: 'medication', title: 'x', timeOfDay: '25:00' } })).status, 400)
  await runJobs(t.ctx)
  let sent = t.outbox({ user_id: p.user.id, kind: 'reminder' })
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /Метформин/)
  await runJobs(t.ctx)
  assert.equal(t.outbox({ user_id: p.user.id, kind: 'reminder' }).length, 1)
  t.setNow('2026-10-10T05:00:00.000Z') // Saturday
  const relog = await t.login(p.user.email, 'password123')
  await runJobs(t.ctx)
  sent = t.outbox({ user_id: p.user.id, kind: 'reminder' })
  assert.equal(sent.length, 3)
  const feed = await t.api('GET', '/api/notifications?unread=1', { token: relog.token })
  assert.ok(feed.body.unread >= 3)
  await t.api('POST', '/api/notifications/read-all', { token: relog.token })
  assert.equal((await t.api('GET', '/api/notifications', { token: relog.token })).body.unread, 0)
  const upd = await t.api('PUT', `/api/reminders/${r1.body.id}`, { token: relog.token, body: { active: false } })
  assert.equal(upd.body.active, false)
  assert.equal((await t.api('DELETE', `/api/reminders/${r1.body.id}`, { token: relog.token })).status, 204)
})

test('adherence nudge after 2 days without measurements', async () => {
  t.setNow('2026-10-12T09:00:00.000Z')
  const p = await t.registerPatient()
  t.setNow('2026-10-14T10:00:00.000Z')
  await runJobs(t.ctx)
  assert.equal(t.outbox({ user_id: p.user.id, kind: 'adherence' }).length, 1)
  await runJobs(t.ctx)
  assert.equal(t.outbox({ user_id: p.user.id, kind: 'adherence' }).length, 1)
})

test('reports: JSON analytics and PDF export with Cyrillic', async () => {
  t.setNow('2026-10-20T09:00:00.000Z')
  const doc = await t.createDoctor()
  const p = await t.patientOf(doc, { fullName: 'Отчётов Пётр', conditions: ['diabetes_t2', 'hypertension'] })
  for (let i = 0; i < 10; i++) {
    const at = new Date(t.ctx.now().getTime() - (10 - i) * 86400_000).toISOString()
    await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'glucose', value: { glucose: 5 + i * 0.8 }, measuredAt: at } })
    await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'blood_pressure', value: { systolic: 120 + i * 5, diastolic: 80 }, measuredAt: at } })
  }
  const rep = await t.api('GET', `/api/reports/patients/${p.user.id}`, { token: doc.token })
  assert.equal(rep.status, 200)
  assert.equal(rep.body.measurementsCount, 20)
  assert.equal(rep.body.daysWithMeasurements, 10)
  assert.equal(rep.body.metrics.glucose.count, 10)
  assert.ok(rep.body.alerts.total > 0)
  const res = await t.api('GET', `/api/reports/patients/${p.user.id}/pdf`, { token: doc.token, raw: true })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  const pdf = Buffer.from(await res.arrayBuffer())
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length > 5000)
  assert.ok(pdf.includes('Roboto'), 'Cyrillic-capable font embedded')
  const stranger = await t.createDoctor()
  assert.equal((await t.api('GET', `/api/reports/patients/${p.user.id}/pdf`, { token: stranger.token })).status, 403)
  assert.equal((await t.api('GET', `/api/reports/patients/${p.user.id}`, { token: p.token })).status, 200, 'patient can see own report')
})

test('consent revocation blocks third-party access and new data; re-consent restores it', async () => {
  const doc = await t.createDoctor()
  const p = await t.patientOf(doc)
  await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'glucose', value: { glucose: 6 } } })
  const mine = await t.api('GET', '/api/consents/me', { token: p.token })
  const health = mine.body.consents.find((c) => c.type === 'health_data' && !c.revokedAt)
  const rev = await t.api('POST', `/api/consents/${health.id}/revoke`, { token: p.token })
  assert.equal(rev.body.status.health_data.active, false)
  const denied = await t.api('GET', `/api/patients/${p.user.id}/measurements`, { token: doc.token })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'CONSENT_REQUIRED')
  assert.equal((await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'glucose', value: { glucose: 6 } } })).status, 403)
  assert.equal((await t.api('GET', `/api/patients/${p.user.id}/measurements`, { token: p.token })).status, 200, 'patient keeps access to own data')
  const dash = await t.api('GET', '/api/doctor/dashboard', { token: doc.token })
  assert.equal(dash.body.patients.find((x) => x.id === p.user.id).consent, false)
  assert.ok(t.outbox({ user_id: doc.user.id, kind: 'consent' }).length === 1)
  const docId = mine.body.documents.find((d) => d.type === 'health_data').id
  await t.api('POST', '/api/consents', { token: p.token, body: { documentId: docId } })
  assert.equal((await t.api('GET', `/api/patients/${p.user.id}/measurements`, { token: doc.token })).status, 200)
})

test('new consent document version requires re-acceptance', async () => {
  const admin = await t.createAdmin()
  const p = await t.registerPatient()
  t.advance(1000)
  const pub = await t.api('POST', '/api/admin/consent-documents', { token: admin.token, body: { type: 'user_agreement', version: '1.1', title: 'Пользовательское соглашение', body: 'Новая редакция' } })
  assert.equal(pub.status, 201)
  const me = await t.api('GET', '/api/auth/me', { token: p.token })
  assert.equal(me.body.consents.user_agreement.active, true)
  assert.equal(me.body.consents.user_agreement.latestAccepted, false)
  await t.api('POST', '/api/consents', { token: p.token, body: { documentId: pub.body.id } })
  assert.equal((await t.api('GET', '/api/auth/me', { token: p.token })).body.consents.user_agreement.latestAccepted, true)
  assert.equal((await t.api('POST', '/api/admin/consent-documents', { token: p.token, body: { type: 'user_agreement', version: '9.9', title: 'x', body: 'x' } })).status, 403)
})

test('relative sees linked patient read-only, without contacts', async () => {
  const doc = await t.createDoctor()
  const p = await t.patientOf(doc)
  const rel = await t.api('POST', '/api/patients/me/relatives', { token: p.token, body: { name: 'Дочь', phone: '+79001230000' } })
  const { body: inv } = await t.api('POST', `/api/patients/me/relatives/${rel.body.id}/invite`, { token: p.token })
  const r = await t.api('POST', '/api/auth/register', { body: { role: 'relative', email: `daughter${p.user.id}@test.ru`, password: 'relativepass', fullName: 'Дочь Пациента', phone: '+79001230000', consents: await t.consentIds('relative'), inviteCode: inv.inviteCode } })
  const tok = r.body.token
  await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'glucose', value: { glucose: 25 } } })
  assert.ok(t.outbox({ user_id: r.body.user.id, kind: 'emergency', channel: 'push' }).length === 1, 'linked relative gets push too')
  const card = await t.api('GET', `/api/patients/${p.user.id}`, { token: tok })
  assert.equal(card.status, 200)
  assert.equal(card.body.patient.phone, undefined)
  assert.equal(card.body.relatives, undefined)
  assert.equal((await t.api('GET', `/api/patients/${p.user.id}/measurements`, { token: tok })).status, 200)
  assert.equal((await t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: tok, body: { type: 'glucose', value: { glucose: 5 } } })).status, 403)
  const alerts = await t.api('GET', '/api/alerts', { token: tok })
  assert.equal(alerts.body.items.length, 1)
  assert.equal((await t.api('POST', `/api/alerts/${alerts.body.items[0].id}/ack`, { token: tok })).status, 403)
  assert.equal((await t.api('GET', '/api/relative/patients', { token: tok })).body[0].openCritical, 1)
})

test('RBAC matrix: admin has no medical data access; non-admins have no admin access', async () => {
  const admin = await t.createAdmin()
  const doc = await t.createDoctor()
  const p = await t.patientOf(doc)
  assert.equal((await t.api('GET', `/api/patients/${p.user.id}/measurements`, { token: admin.token })).status, 403)
  assert.equal((await t.api('GET', `/api/chat/${p.user.id}`, { token: admin.token })).status, 403)
  for (const tok of [p.token, doc.token]) {
    assert.equal((await t.api('GET', '/api/admin/users', { token: tok })).status, 403)
    assert.equal((await t.api('GET', '/api/admin/audit', { token: tok })).status, 403)
  }
  assert.equal((await t.api('GET', '/api/doctor/dashboard', { token: p.token })).status, 403)
  assert.equal((await t.api('POST', '/api/reminders', { token: doc.token, body: {} })).status, 403)
  const roles = await t.api('GET', '/api/admin/roles', { token: admin.token })
  assert.ok(roles.body.admin.includes('users:manage'))
  assert.ok(!roles.body.admin.some((p) => p.includes('medical')))
})

test('admin: users, roles, blocking, assignment, audit and access log', async () => {
  const admin = await t.createAdmin()
  const p = await t.registerPatient({ fullName: 'Блокируемый Пациент' })
  const created = await t.api('POST', '/api/admin/users', { token: admin.token, body: { role: 'doctor', email: 'admin-made-doc@test.ru', password: 'doctorpass9', fullName: 'Созданный Врач', specialty: 'Терапевт' } })
  assert.equal(created.status, 201)
  const list = await t.api('GET', '/api/admin/users?role=patient&q=блокируемый', { token: admin.token })
  assert.equal(list.body.items.length, 1)
  const byEmail = await t.api('GET', `/api/admin/users?email=${encodeURIComponent(p.user.email)}`, { token: admin.token })
  assert.equal(byEmail.body.items[0].id, p.user.id)
  assert.equal((await t.api('PATCH', `/api/admin/users/${p.user.id}`, { token: admin.token, body: { doctorId: created.body.id } })).status, 200)
  assert.equal((await t.api('GET', `/api/admin/users/${p.user.id}`, { token: admin.token })).body.patient.doctorId, created.body.id)
  const blocked = await t.api('PATCH', `/api/admin/users/${p.user.id}`, { token: admin.token, body: { status: 'blocked' } })
  assert.equal(blocked.body.status, 'blocked')
  assert.equal((await t.api('GET', '/api/auth/me', { token: p.token })).status, 401, 'blocked user loses session')
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: p.user.email, password: 'password123' } })).body.error.code, 'ACCOUNT_BLOCKED')
  assert.equal((await t.api('PATCH', `/api/admin/users/${admin.user.id}`, { token: admin.token, body: { status: 'blocked' } })).status, 400)
  const audit = await t.api('GET', '/api/admin/audit?action=admin.', { token: admin.token })
  assert.ok(audit.body.items.some((a) => a.action === 'admin.user_updated' && a.entityId === String(p.user.id)))
  assert.ok(audit.body.items.every((a) => a.action.startsWith('admin.')))
  const access = await t.api('GET', '/api/admin/access-log', { token: admin.token })
  assert.ok(access.body.total > 0)
  const notif = await t.api('GET', '/api/admin/notifications', { token: admin.token })
  assert.ok(notif.body.length > 0 && notif.body.every((n) => n.body === undefined), 'no message bodies (OTP/health data) in admin view')
})

test('platform metrics reflect the charter success criteria', async () => {
  const admin = await t.createAdmin()
  const m = await t.api('GET', '/api/admin/metrics', { token: admin.token })
  assert.equal(m.status, 200)
  assert.ok(m.body.users.patients > 0)
  assert.ok(m.body.devices.readings.glucometer > 0)
  assert.ok(m.body.devices.readings.tonometer > 0)
  assert.equal(m.body.successCriteria.find((c) => c.id === 'devices').met, true)
  assert.equal(typeof m.body.adherence.targetPct, 'number')
  assert.equal(m.body.alerts.reactionAllTime.slaMinutes, 15)
})

test('encrypted backup, verification and restore', async () => {
  const admin = await t.createAdmin()
  const b = await t.api('POST', '/api/admin/backups', { token: admin.token })
  assert.equal(b.status, 201)
  assert.equal(b.body.verification.ok, true)
  assert.ok(b.body.verification.counts.users > 0)
  const file = path.join(backupDir, b.body.file)
  const blob = fs.readFileSync(file)
  assert.equal(blob.subarray(0, 4).toString(), 'HMB1')
  assert.ok(!blob.includes('SQLite format'), 'backup is encrypted')
  const list = await t.api('GET', '/api/admin/backups', { token: admin.token })
  assert.equal(list.body[0].exists, true)
  const target = path.join(backupDir, 'restored.db')
  fs.writeFileSync(target, 'old')
  const r = restoreBackup(t.ctx.cipher, file, target)
  assert.ok(r.keptAs && fs.existsSync(r.keptAs), 'previous database kept')
  const db = new DatabaseSync(target)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, b.body.verification.counts.users)
  db.close()
})
