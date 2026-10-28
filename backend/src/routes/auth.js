/** Registration (KAN-21), login & password recovery (KAN-22), SMS two-factor authentication (KAN-23). */
import { Router } from 'express'
import { randomDigits, randomToken, sha256, signJwt, verifyPassword, hashPassword } from '../crypto.js'
import { badRequest, forbidden, unauthorized } from '../errors.js'
import { EMAIL, PASSWORD, PHONE, validate } from '../validate.js'
import { requireAuth } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { notify } from '../services/notify.js'
import { CONDITIONS, createUser, findUserByEmail, getUserRow, publicUser, getPatientProfile } from '../services/users.js'
import { consentStatus, currentDocuments, grantConsent, REQUIRED_FOR_OTHERS, REQUIRED_FOR_PATIENT } from '../services/consents.js'
import { transaction } from '../db.js'
import { rateLimit } from '../middleware/rateLimit.js'

const MAX_OTP_ATTEMPTS = 5

export function issueToken(ctx, row) {
  return signJwt({ sub: row.id, role: row.role, tv: row.token_version }, ctx.config.jwtSecret, ctx.config.tokenTtlSec, ctx.now())
}

function createOtp(ctx, userId, purpose) {
  const code = randomDigits(6)
  const challenge = randomToken(18)
  const expires = new Date(ctx.now().getTime() + ctx.config.otpTtlSec * 1000).toISOString()
  ctx.db.prepare('UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(ctx.now().toISOString(), userId, purpose)
  ctx.db
    .prepare('INSERT INTO otp_codes (user_id, purpose, challenge, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, purpose, challenge, sha256(`${challenge}:${code}`), expires)
  const text = purpose === 'login' ? `Код входа в HealthMonitor: ${code}. Никому не сообщайте его.` : `Код восстановления пароля HealthMonitor: ${code}.`
  notify(ctx, { userId, channels: ['sms'], title: 'HealthMonitor', body: text, kind: `otp_${purpose}` })
  return { challenge, code }
}

function consumeOtp(ctx, { challenge, code, purpose, userId = null }) {
  const row = ctx.db.prepare('SELECT * FROM otp_codes WHERE challenge = ? AND purpose = ?').get(challenge, purpose)
  if (!row || row.used_at || (userId && row.user_id !== userId)) throw unauthorized('Код недействителен')
  if (new Date(row.expires_at) < ctx.now()) throw unauthorized('Срок действия кода истёк')
  if (row.attempts >= MAX_OTP_ATTEMPTS) throw unauthorized('Превышено число попыток, запросите новый код')
  if (sha256(`${challenge}:${code}`) !== row.code_hash) {
    ctx.db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id)
    throw unauthorized('Неверный код')
  }
  ctx.db.prepare('UPDATE otp_codes SET used_at = ? WHERE id = ?').run(ctx.now().toISOString(), row.id)
  return row.user_id
}

function completeLogin(ctx, req, row) {
  ctx.db.prepare('UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?').run(ctx.now().toISOString(), row.id)
  audit(ctx, row, 'auth.login', { entity: 'user', entityId: row.id, ip: req.ip })
  return { token: issueToken(ctx, row), user: publicUser(ctx, getUserRow(ctx, row.id)) }
}

export function authRouter(ctx) {
  const r = Router()
  const limiter = rateLimit({ windowMs: 60_000, max: ctx.config.env === 'test' ? 1000 : 20, now: ctx.now })

  r.post('/register', limiter, (req, res) => {
    const input = validate(req.body, {
      role: { type: 'string', required: true, enum: ['patient', 'doctor', 'relative'] },
      email: EMAIL,
      password: PASSWORD,
      fullName: { type: 'string', required: true, minLength: 2, maxLength: 200 },
      phone: { ...PHONE, required: true },
      consents: { type: 'array', default: [] },
      conditions: { type: 'array', items: { enum: CONDITIONS }, default: [] },
      specialty: { type: 'string', maxLength: 200 },
      licenseNumber: { type: 'string', maxLength: 100 },
      inviteCode: { type: 'string', maxLength: 64 },
    })
    const docs = currentDocuments(ctx)
    const required = input.role === 'patient' ? REQUIRED_FOR_PATIENT : REQUIRED_FOR_OTHERS
    const given = new Set(input.consents.map(Number))
    const missing = docs.filter((d) => required.includes(d.type) && !given.has(d.id)).map((d) => d.type)
    if (missing.length) throw badRequest('Необходимо принять обязательные согласия', { consents: missing })

    let relativeLink = null
    if (input.role === 'relative') {
      if (!input.inviteCode) throw badRequest('Для регистрации родственника нужен код приглашения', { inviteCode: 'обязательное поле' })
      relativeLink = ctx.db.prepare('SELECT * FROM relatives WHERE invite_code_hash = ? AND user_id IS NULL').get(sha256(input.inviteCode))
      if (!relativeLink) throw badRequest('Код приглашения недействителен', { inviteCode: 'недействителен' })
    }
    if (input.role === 'doctor' && !input.licenseNumber) throw badRequest('Укажите номер лицензии/сертификата', { licenseNumber: 'обязательное поле' })

    const result = transaction(ctx.db, () => {
      const status = input.role === 'doctor' ? 'pending' : 'active'
      const id = createUser(ctx, { ...input, status })
      for (const d of docs) if (given.has(d.id)) grantConsent(ctx, id, d.id, req.ip)
      if (input.role === 'patient' && input.conditions.length) {
        ctx.db.prepare('UPDATE patient_profiles SET conditions = ? WHERE user_id = ?').run(JSON.stringify([...new Set(input.conditions)]), id)
      }
      if (input.role === 'doctor') {
        ctx.db.prepare('UPDATE doctor_profiles SET specialty = ?, license_enc = ? WHERE user_id = ?').run(input.specialty ?? null, ctx.cipher.encrypt(input.licenseNumber), id)
        ctx.db.prepare("INSERT INTO requests (type, user_id, created_at) VALUES ('doctor_registration', ?, ?)").run(id, ctx.now().toISOString())
      }
      if (relativeLink) ctx.db.prepare('UPDATE relatives SET user_id = ?, invite_code_hash = NULL WHERE id = ?').run(id, relativeLink.id)
      audit(ctx, { id, role: input.role }, 'auth.register', { entity: 'user', entityId: id, ip: req.ip })
      return { id, status }
    })
    const row = getUserRow(ctx, result.id)
    if (result.status !== 'active') {
      return res.status(201).json({ user: publicUser(ctx, row), pendingModeration: true })
    }
    res.status(201).json(completeLogin(ctx, req, row))
  })

  r.post('/login', limiter, (req, res) => {
    const input = validate(req.body, { email: EMAIL, password: { type: 'string', required: true, maxLength: 128 } })
    const row = findUserByEmail(ctx, input.email)
    if (!row || !verifyPassword(input.password, row.password_hash)) {
      audit(ctx, row ? { id: row.id, role: row.role } : null, 'auth.login_failed', { ip: req.ip })
      throw unauthorized('Неверный e-mail или пароль')
    }
    if (row.status === 'pending') throw forbidden('Учётная запись ожидает модерации', 'PENDING_MODERATION')
    if (row.status !== 'active') throw forbidden('Учётная запись заблокирована', 'ACCOUNT_BLOCKED')
    if (row.twofa_enabled) {
      const { challenge, code } = createOtp(ctx, row.id, 'login')
      audit(ctx, row, 'auth.2fa_challenge', { ip: req.ip })
      return res.json({ twofaRequired: true, challenge, ...(ctx.config.exposeDevCodes ? { devCode: code } : {}) })
    }
    res.json(completeLogin(ctx, req, row))
  })

  r.post('/2fa/verify', limiter, (req, res) => {
    const input = validate(req.body, { challenge: { type: 'string', required: true, maxLength: 64 }, code: { type: 'string', required: true, pattern: /^\d{6}$/ } })
    const userId = consumeOtp(ctx, { ...input, purpose: 'login' })
    const row = getUserRow(ctx, userId)
    if (row.status !== 'active') throw forbidden('Учётная запись заблокирована', 'ACCOUNT_BLOCKED')
    res.json(completeLogin(ctx, req, row))
  })

  r.post('/password/forgot', limiter, (req, res) => {
    const input = validate(req.body, { email: EMAIL })
    const row = findUserByEmail(ctx, input.email)
    // Same response whether or not the account exists, to avoid user enumeration.
    let challenge = randomToken(18)
    let devCode
    if (row && row.status !== 'blocked') {
      const otp = createOtp(ctx, row.id, 'reset')
      challenge = otp.challenge
      devCode = otp.code
      audit(ctx, row, 'auth.password_reset_requested', { ip: req.ip })
    }
    res.json({ challenge, message: 'Если учётная запись существует, на привязанный телефон отправлен код', ...(ctx.config.exposeDevCodes && devCode ? { devCode } : {}) })
  })

  r.post('/password/reset', limiter, (req, res) => {
    const input = validate(req.body, { challenge: { type: 'string', required: true, maxLength: 64 }, code: { type: 'string', required: true, pattern: /^\d{6}$/ }, newPassword: PASSWORD })
    const userId = consumeOtp(ctx, { challenge: input.challenge, code: input.code, purpose: 'reset' })
    ctx.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(input.newPassword), userId)
    audit(ctx, getUserRow(ctx, userId), 'auth.password_reset', { ip: req.ip })
    res.json({ ok: true })
  })

  r.get('/me', requireAuth, (req, res) => {
    const row = getUserRow(ctx, req.user.id)
    const extra = {}
    if (row.role === 'patient') extra.profile = getPatientProfile(ctx, row.id)
    res.json({ user: publicUser(ctx, row), consents: consentStatus(ctx, row.id), ...extra })
  })

  r.post('/2fa', requireAuth, (req, res) => {
    const input = validate(req.body, { enabled: { type: 'boolean', required: true } })
    if (input.enabled && !publicUser(ctx, getUserRow(ctx, req.user.id)).phone) throw badRequest('Для 2FA нужен номер телефона')
    ctx.db.prepare('UPDATE users SET twofa_enabled = ? WHERE id = ?').run(input.enabled ? 1 : 0, req.user.id)
    audit(ctx, req.user, input.enabled ? 'auth.2fa_enabled' : 'auth.2fa_disabled', { ip: req.ip })
    res.json({ twofaEnabled: input.enabled })
  })

  r.post('/password/change', requireAuth, (req, res) => {
    const input = validate(req.body, { currentPassword: { type: 'string', required: true, maxLength: 128 }, newPassword: PASSWORD })
    const row = getUserRow(ctx, req.user.id)
    if (!verifyPassword(input.currentPassword, row.password_hash)) throw unauthorized('Неверный текущий пароль')
    ctx.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(input.newPassword), row.id)
    audit(ctx, req.user, 'auth.password_changed', { ip: req.ip })
    res.json({ token: issueToken(ctx, getUserRow(ctx, row.id)) })
  })

  r.post('/logout', requireAuth, (req, res) => {
    ctx.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id)
    audit(ctx, req.user, 'auth.logout', { ip: req.ip })
    res.json({ ok: true })
  })

  return r
}
