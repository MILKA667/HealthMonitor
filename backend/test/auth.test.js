import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'

let t
before(async () => { t = await startTestServer() })
after(() => t.close())

test('health endpoint and security headers', async () => {
  const res = await t.api('GET', '/api/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
  assert.equal(res.body.dataRegion, 'ru')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('x-powered-by'), null)
})

test('patient registration requires separate personal-data, health-data consents and the agreement', async () => {
  const docs = (await t.api('GET', '/api/consents/documents')).body
  assert.deepEqual(docs.map((d) => d.type).sort(), ['health_data', 'personal_data', 'user_agreement'])
  const base = { role: 'patient', email: 'noconsent@test.ru', password: 'password123', fullName: 'Без Согласия', phone: '+79001112233' }
  const withoutHealth = docs.filter((d) => d.type !== 'health_data').map((d) => d.id)
  const res = await t.api('POST', '/api/auth/register', { body: { ...base, consents: withoutHealth } })
  assert.equal(res.status, 400)
  assert.deepEqual(res.body.error.details.consents, ['health_data'])
  const ok = await t.api('POST', '/api/auth/register', { body: { ...base, consents: docs.map((d) => d.id) } })
  assert.equal(ok.status, 201)
  assert.ok(ok.body.token)
  const me = await t.api('GET', '/api/auth/me', { token: ok.body.token })
  assert.equal(me.body.user.email, 'noconsent@test.ru')
  assert.equal(me.body.consents.health_data.active, true)
})

test('validation errors and duplicate e-mail', async () => {
  const bad = await t.api('POST', '/api/auth/register', { body: { role: 'patient', email: 'x', password: '1', fullName: 'A', phone: '123' } })
  assert.equal(bad.status, 400)
  assert.ok(bad.body.error.details.email && bad.body.error.details.password && bad.body.error.details.phone)
  const p = await t.registerPatient()
  const dup = await t.api('POST', '/api/auth/register', { body: { role: 'patient', email: p.user.email.toUpperCase(), password: 'password123', fullName: 'Дубль', phone: '+79001112299', consents: await t.consentIds() } })
  assert.equal(dup.status, 409)
})

test('personal data is encrypted at rest', async () => {
  const p = await t.registerPatient({ fullName: 'Секретов Секрет' })
  const row = t.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(p.user.id)
  const dump = JSON.stringify(row)
  assert.ok(!dump.includes('Секретов'))
  assert.ok(!dump.includes(p.user.email))
  assert.ok(!dump.includes(p.user.phone))
  assert.ok(row.password_hash.startsWith('scrypt$'))
})

test('login, wrong password, logout invalidates token', async () => {
  const p = await t.registerPatient()
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: p.user.email, password: 'nope-nope' } })).status, 401)
  const { token } = await t.login(p.user.email, 'password123')
  assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 200)
  assert.equal((await t.api('POST', '/api/auth/logout', { token })).status, 200)
  assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 401)
  const failed = t.ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'auth.login_failed' AND user_id = ?").get(p.user.id).c
  assert.equal(failed, 1)
})

test('two-factor authentication via SMS code', async () => {
  const p = await t.registerPatient()
  assert.equal((await t.api('POST', '/api/auth/2fa', { token: p.token, body: { enabled: true } })).status, 200)
  const step1 = await t.api('POST', '/api/auth/login', { body: { email: p.user.email, password: 'password123' } })
  assert.equal(step1.body.twofaRequired, true)
  assert.equal(step1.body.token, undefined)
  await t.flush()
  const sms = t.outbox({ kind: 'otp_login', user_id: p.user.id })
  assert.equal(sms.length, 1)
  assert.equal(sms[0].channel, 'sms')
  assert.equal(sms[0].recipient, p.user.phone)
  assert.equal(sms[0].status, 'sent')
  const code = sms[0].body.match(/\d{6}/)[0]
  assert.equal(code, step1.body.devCode)
  const wrong = await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: step1.body.challenge, code: code === '000000' ? '111111' : '000000' } })
  assert.equal(wrong.status, 401)
  const ok = await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: step1.body.challenge, code } })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.token)
  const reuse = await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: step1.body.challenge, code } })
  assert.equal(reuse.status, 401)
})

test('2FA code expires and is locked after too many attempts', async () => {
  const p = await t.registerPatient()
  await t.api('POST', '/api/auth/2fa', { token: p.token, body: { enabled: true } })
  const s = await t.api('POST', '/api/auth/login', { body: { email: p.user.email, password: 'password123' } })
  t.advance(6 * 60_000)
  assert.equal((await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: s.body.challenge, code: s.body.devCode } })).body.error.message, 'Срок действия кода истёк')
  const s2 = await t.api('POST', '/api/auth/login', { body: { email: p.user.email, password: 'password123' } })
  for (let i = 0; i < 5; i++) await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: s2.body.challenge, code: s2.body.devCode === '999999' ? '999998' : '999999' } })
  const locked = await t.api('POST', '/api/auth/2fa/verify', { body: { challenge: s2.body.challenge, code: s2.body.devCode } })
  assert.equal(locked.status, 401)
})

test('password recovery by SMS code; old sessions are revoked', async () => {
  const p = await t.registerPatient()
  const unknown = await t.api('POST', '/api/auth/password/forgot', { body: { email: 'nobody@test.ru' } })
  assert.equal(unknown.status, 200, 'no user enumeration')
  const f = await t.api('POST', '/api/auth/password/forgot', { body: { email: p.user.email } })
  assert.equal(f.status, 200)
  const r = await t.api('POST', '/api/auth/password/reset', { body: { challenge: f.body.challenge, code: f.body.devCode, newPassword: 'brand-new-pass' } })
  assert.equal(r.status, 200)
  assert.equal((await t.api('GET', '/api/auth/me', { token: p.token })).status, 401)
  await t.login(p.user.email, 'brand-new-pass')
})

test('doctor registration goes to moderation; admin approves', async () => {
  const consents = await t.consentIds('doctor')
  const reg = await t.api('POST', '/api/auth/register', { body: { role: 'doctor', email: 'newdoc@test.ru', password: 'doctorpass1', fullName: 'Доктор Новый', phone: '+79005554433', consents, specialty: 'Эндокринолог', licenseNumber: 'LIC-123' } })
  assert.equal(reg.status, 201)
  assert.equal(reg.body.pendingModeration, true)
  const blocked = await t.api('POST', '/api/auth/login', { body: { email: 'newdoc@test.ru', password: 'doctorpass1' } })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error.code, 'PENDING_MODERATION')
  const admin = await t.createAdmin()
  const reqs = await t.api('GET', '/api/admin/requests', { token: admin.token })
  const mine = reqs.body.find((x) => x.user.email === 'newdoc@test.ru')
  assert.equal(mine.type, 'doctor_registration')
  assert.equal(mine.licenseNumber, 'LIC-123')
  assert.equal((await t.api('POST', `/api/admin/requests/${mine.id}/approve`, { token: admin.token, body: {} })).status, 200)
  await t.login('newdoc@test.ru', 'doctorpass1')
})

test('relative registers only with a valid invite code from the patient', async () => {
  const p = await t.registerPatient()
  const rel = await t.api('POST', '/api/patients/me/relatives', { token: p.token, body: { name: 'Мама', phone: '+79007770000', relation: 'мать' } })
  assert.equal(rel.status, 201)
  const invite = await t.api('POST', `/api/patients/me/relatives/${rel.body.id}/invite`, { token: p.token })
  assert.ok(invite.body.inviteCode)
  const consents = await t.consentIds('relative')
  const body = { role: 'relative', email: 'mama@test.ru', password: 'relativepass', fullName: 'Мама Пациента', phone: '+79007770000', consents }
  assert.equal((await t.api('POST', '/api/auth/register', { body: { ...body, inviteCode: 'bad-code' } })).status, 400)
  const ok = await t.api('POST', '/api/auth/register', { body: { ...body, inviteCode: invite.body.inviteCode } })
  assert.equal(ok.status, 201)
  const list = await t.api('GET', '/api/relative/patients', { token: ok.body.token })
  assert.equal(list.body.length, 1)
  assert.equal(list.body[0].id, p.user.id)
  const reuse = await t.api('POST', '/api/auth/register', { body: { ...body, email: 'mama2@test.ru', inviteCode: invite.body.inviteCode } })
  assert.equal(reuse.status, 400)
})

test('unknown API route returns JSON 404; bad JSON returns 400', async () => {
  assert.equal((await t.api('GET', '/api/nope')).status, 404)
  const res = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })
  assert.equal(res.status, 400)
})

test('serves the built web client with SPA fallback and a strict CSP', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { startTestServer } = await import('./helpers.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-static-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
  const s = await startTestServer({ staticDir: dir })
  try {
    const page = await fetch(`${s.base}/doctor/patients/5`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /id="root"/)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    const api = await s.api('GET', '/api/nope')
    assert.equal(api.status, 404)
    assert.match(api.headers.get('content-security-policy'), /default-src 'none'/)
  } finally {
    await s.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('production: plain HTTP is rejected, HTTPS via trusted proxy is accepted, HSTS is sent', async () => {
  const { startTestServer } = await import('./helpers.js')
  const crypto = await import('node:crypto')
  const key = () => crypto.randomBytes(32).toString('hex')
  const s = await startTestServer({ trustProxy: true }, { NODE_ENV: 'production', HM_ENC_KEY: key(), HM_INDEX_KEY: key(), HM_JWT_SECRET: key() })
  try {
    assert.equal((await s.api('GET', '/api/health')).status, 200, 'health check stays reachable for the orchestrator')
    const plain = await s.api('GET', '/api/consents/documents')
    assert.equal(plain.status, 403)
    assert.equal(plain.body.error.code, 'HTTPS_REQUIRED')
    const tls = await s.api('GET', '/api/consents/documents', { headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(tls.status, 200)
    assert.match(tls.headers.get('strict-transport-security'), /max-age=31536000/)
    const forgot = await s.api('POST', '/api/auth/password/forgot', { body: { email: 'x@y.ru' }, headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(forgot.body.devCode, undefined, 'no dev codes in production')
  } finally {
    await s.close()
  }
})
