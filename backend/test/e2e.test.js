/**
 * End-to-end pilot scenario through the public HTTP API only (no direct DB writes), covering the
 * charter's success criteria: users who logged in, device integration for two device kinds,
 * doctor reaction to a critical alert within 15 minutes, regular measurement input.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { runJobs } from '../src/services/scheduler.js'

const t = await startTestServer({ escalationMinutes: 15 })
after(() => t.close())
const H = 3600_000

test('pilot journey: registration → moderation → monitoring → alert → reaction → report → metrics', async () => {
  const admin = await t.createAdmin()
  const consents = { patient: await t.consentIds('patient'), doctor: await t.consentIds('doctor'), relative: await t.consentIds('relative') }

  // 1. Doctor registers and is approved by the administrator.
  const reg = await t.api('POST', '/api/auth/register', { body: { role: 'doctor', email: 'endo@pilot.ru', password: 'doctorpass1', fullName: 'Эндокринологова Анна', phone: '+79010000001', specialty: 'Эндокринолог', licenseNumber: 'L-77', consents: consents.doctor } })
  assert.equal(reg.body.pendingModeration, true)
  const pending = (await t.api('GET', '/api/admin/requests', { token: admin.token })).body.find((r) => r.user.email === 'endo@pilot.ru')
  await t.api('POST', `/api/admin/requests/${pending.id}/approve`, { token: admin.token, body: {} })
  const doctor = await t.login('endo@pilot.ru', 'doctorpass1')

  // 2. Patient registers with separate consents, chooses the doctor, doctor accepts.
  const p = await t.api('POST', '/api/auth/register', { body: { role: 'patient', email: 'ivanov@pilot.ru', password: 'patientpass1', fullName: 'Иванов Сергей', phone: '+79010000002', conditions: ['diabetes_t2', 'hypertension'], consents: consents.patient } })
  assert.equal(p.status, 201)
  let patient = { token: p.body.token, user: p.body.user }
  const pid = patient.user.id
  const docList = (await t.api('GET', '/api/doctors', { token: patient.token })).body
  const request = await t.api('POST', '/api/patients/me/doctor-requests', { token: patient.token, body: { doctorId: docList.find((d) => d.fullName === 'Эндокринологова Анна').id } })
  await t.api('POST', `/api/doctor/requests/${request.body.id}/approve`, { token: doctor.token, body: {} })

  // 3. Patient enables 2FA, adds a relative, invites them.
  await t.api('POST', '/api/auth/2fa', { token: patient.token, body: { enabled: true } })
  const rel = await t.api('POST', '/api/patients/me/relatives', { token: patient.token, body: { name: 'Иванова Ольга', phone: '+79010000003', relation: 'жена' } })
  const invite = await t.api('POST', `/api/patients/me/relatives/${rel.body.id}/invite`, { token: patient.token })
  const relative = await t.api('POST', '/api/auth/register', { body: { role: 'relative', email: 'olga@pilot.ru', password: 'relativepass1', fullName: 'Иванова Ольга', phone: '+79010000003', inviteCode: invite.body.inviteCode, consents: consents.relative } })
  assert.equal(relative.status, 201)

  // 4. Login again through 2FA (SMS code from the outbox).
  const step = await t.api('POST', '/api/auth/login', { body: { email: 'ivanov@pilot.ru', password: 'patientpass1' } })
  assert.equal(step.body.twofaRequired, true)
  const sms = t.outbox({ kind: 'otp_login', user_id: pid }).at(-1)
  const verified = await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: step.body.challenge, code: sms.body.match(/\d{6}/)[0] } })
  patient = { token: verified.body.token, user: verified.body.user }

  // 5. Devices: glucometer and tonometer are paired and send data.
  const gl = await t.api('POST', '/api/devices', { token: patient.token, body: { adapter: 'glucometer-v1', model: 'GL-100', serial: 'GL-E2E-1' } })
  const bp = await t.api('POST', '/api/devices', { token: patient.token, body: { adapter: 'tonometer-v1', model: 'BP-300', serial: 'BP-E2E-1' } })
  const start = t.ctx.now().getTime()
  const glPush = await t.api('POST', '/api/integrations/glucometer-v1/readings', { headers: { 'x-device-key': gl.body.apiKey }, body: { serial: 'GL-E2E-1', readings: [0, 1, 2, 3, 4, 5].map((d) => ({ timestamp: new Date(start - d * 24 * H).toISOString(), glucose: 110 + d * 3, unit: 'mg/dL' })) } })
  assert.equal(glPush.body.accepted, 6)
  const bpPush = await t.api('POST', '/api/integrations/tonometer-v1/readings', { headers: { 'x-device-key': bp.body.apiKey }, body: { deviceSerial: 'BP-E2E-1', measurements: [0, 1, 2, 3, 4, 5].map((d) => ({ dateTime: new Date(start - d * 24 * H - H).toISOString(), sys: 125 + d, dia: 80, pulse: 70 })) } })
  assert.equal(bpPush.body.accepted, 6)

  // 6. Critical reading entered manually → doctor, patient, relative notified.
  const crit = await t.api('POST', `/api/patients/${pid}/measurements`, { token: patient.token, body: { type: 'glucose', value: { glucose: 2.6 } } })
  assert.equal(crit.body.severity, 'critical')
  const alertId = crit.body.alerts[0].id
  await t.flush()
  assert.ok(t.outbox({ alert_id: alertId, user_id: doctor.user.id, channel: 'sms' }).length === 1)
  assert.ok(t.outbox({ alert_id: alertId, kind: 'emergency', recipient: '+79010000003' }).length >= 1)

  // 7. Dashboard puts the patient on top; the relative sees the critical state.
  const dash = await t.api('GET', '/api/doctor/dashboard', { token: doctor.token })
  assert.equal(dash.body.patients[0].id, pid)
  assert.equal(dash.body.patients[0].priority, 'critical')
  const relView = await t.api('GET', '/api/relative/patients', { token: relative.body.token })
  assert.equal(relView.body[0].openCritical, 1)

  // 8. Doctor reacts within the SLA, writes to the patient, sets individual thresholds.
  t.advance(9 * 60_000)
  await runJobs(t.ctx)
  assert.equal(t.outbox({ alert_id: alertId, kind: 'escalation' }).length, 0, 'no escalation before 15 minutes')
  const ack = await t.api('POST', `/api/alerts/${alertId}/ack`, { token: doctor.token })
  assert.equal(ack.body.reactionMinutes, 9)
  t.advance(20 * 60_000)
  await runJobs(t.ctx)
  assert.equal(t.outbox({ alert_id: alertId, kind: 'escalation' }).length, 0, 'acknowledged alerts are not escalated')
  await t.api('POST', `/api/chat/${pid}`, { token: doctor.token, body: { body: 'Сергей, как самочувствие? Повторите замер через 15 минут.' } })
  const thread = await t.api('GET', `/api/chat/${pid}`, { token: patient.token })
  assert.equal(thread.body.length, 1)
  assert.equal((await t.api('PUT', `/api/patients/${pid}/thresholds/glucose`, { token: doctor.token, body: { critLow: 3.5, warnLow: 4.5, warnHigh: 9, critHigh: 14 } })).status, 200)
  await t.api('POST', `/api/alerts/${alertId}/resolve`, { token: doctor.token, body: { note: 'Связался, рекомендован очный приём' } })

  // 9. Report with charts in PDF for the doctor.
  const pdf = await t.api('GET', `/api/reports/patients/${pid}/pdf`, { token: doctor.token, raw: true })
  assert.equal(pdf.status, 200)
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF')

  // 10. Admin metrics reflect criteria; audit & access journals contain the trail.
  const m = (await t.api('GET', '/api/admin/metrics', { token: admin.token })).body
  assert.equal(m.users.doctorsLoggedIn, 1)
  assert.equal(m.users.patientsLoggedIn, 1)
  assert.equal(m.successCriteria.find((c) => c.id === 'devices').met, true)
  assert.equal(m.successCriteria.find((c) => c.id === 'reaction').met, true)
  assert.equal(m.alerts.reactionAllTime.avgMinutes, 9)
  assert.equal(m.adherence.regularPatients, 1)
  const audit = (await t.api('GET', '/api/admin/audit?limit=500', { token: admin.token })).body.items.map((a) => a.action)
  for (const action of ['auth.register', 'request.approved', 'device.linked', 'device.sync', 'measurement.created', 'alert.acknowledged', 'alert.resolved', 'thresholds.updated', 'report.exported', 'chat.message_sent', 'auth.2fa_enabled']) {
    assert.ok(audit.includes(action), `audit contains ${action}`)
  }
  const access = (await t.api('GET', `/api/admin/access-log?patientId=${pid}&limit=500`, { token: admin.token })).body.items
  assert.ok(access.some((a) => a.userId === doctor.user.id && a.resource === 'report:pdf'))
  assert.ok(access.some((a) => a.role === 'relative'))

  // 11. Backup is created and verified.
  const backup = await t.api('POST', '/api/admin/backups', { token: admin.token })
  assert.equal(backup.body.verification.ok, true)
})

test('scale smoke test: 5x pilot (100 patients, 25 doctors) dashboard and metrics stay fast', async () => {
  const doctors = []
  for (let i = 0; i < 25; i++) doctors.push(await t.createDoctor(`Нагрузочный Врач ${i}`))
  const patients = []
  for (let i = 0; i < 100; i++) patients.push(await t.patientOf(doctors[i % 25]))
  await Promise.all(patients.map((p, i) => t.api('POST', `/api/patients/${p.user.id}/measurements`, { token: p.token, body: { type: 'glucose', value: { glucose: i % 10 === 0 ? 18 : 6 } } })))
  const t0 = performance.now()
  const dash = await t.api('GET', '/api/doctor/dashboard', { token: doctors[0].token })
  const dashMs = performance.now() - t0
  assert.equal(dash.body.patients.length, 4)
  const admin = await t.createAdmin()
  const t1 = performance.now()
  const metrics = await t.api('GET', '/api/admin/metrics', { token: admin.token })
  const metricsMs = performance.now() - t1
  assert.ok(metrics.body.users.patients >= 101)
  assert.ok(dashMs < 500, `dashboard ${dashMs.toFixed(0)} ms`)
  assert.ok(metricsMs < 2000, `metrics ${metricsMs.toFixed(0)} ms`)
})
