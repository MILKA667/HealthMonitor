import { blindIndex, hashPassword } from '../crypto.js'
import { conflict, notFound } from '../errors.js'

export const ROLES = ['patient', 'doctor', 'relative', 'admin']
export const CONDITIONS = ['diabetes_t2', 'hypertension', 'asthma']

export function emailIndex(ctx, email) {
  return blindIndex(ctx.config.indexKey, email)
}

export function createUser(ctx, { role, email, phone = null, fullName, password, status = 'active' }) {
  if (ctx.db.prepare('SELECT 1 FROM users WHERE email_idx = ?').get(emailIndex(ctx, email))) {
    throw conflict('Пользователь с таким e-mail уже зарегистрирован', 'EMAIL_TAKEN')
  }
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO users (role, email_idx, email_enc, phone_enc, full_name_enc, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      role,
      emailIndex(ctx, email),
      ctx.cipher.encrypt(email.trim().toLowerCase()),
      ctx.cipher.encrypt(phone),
      ctx.cipher.encrypt(fullName),
      hashPassword(password),
      status,
      ctx.now().toISOString(),
    )
  const id = Number(lastInsertRowid)
  if (role === 'patient') ctx.db.prepare('INSERT INTO patient_profiles (user_id) VALUES (?)').run(id)
  if (role === 'doctor') ctx.db.prepare('INSERT INTO doctor_profiles (user_id) VALUES (?)').run(id)
  return id
}

export function findUserByEmail(ctx, email) {
  return ctx.db.prepare('SELECT * FROM users WHERE email_idx = ?').get(emailIndex(ctx, email))
}

export function getUserRow(ctx, id) {
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

export function requireUser(ctx, id) {
  const row = getUserRow(ctx, id)
  if (!row) throw notFound('Пользователь не найден')
  return row
}

export function publicUser(ctx, row) {
  if (!row) return null
  return {
    id: row.id,
    role: row.role,
    email: ctx.cipher.decrypt(row.email_enc),
    phone: ctx.cipher.decrypt(row.phone_enc),
    fullName: ctx.cipher.decrypt(row.full_name_enc),
    status: row.status,
    twofaEnabled: Boolean(row.twofa_enabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

export function userName(ctx, id) {
  const row = ctx.db.prepare('SELECT full_name_enc FROM users WHERE id = ?').get(id)
  return row ? ctx.cipher.decrypt(row.full_name_enc) : null
}

export function userPhone(ctx, id) {
  const row = ctx.db.prepare('SELECT phone_enc FROM users WHERE id = ?').get(id)
  return row ? ctx.cipher.decrypt(row.phone_enc) : null
}

export function getPatientProfile(ctx, patientId) {
  const p = ctx.db.prepare('SELECT * FROM patient_profiles WHERE user_id = ?').get(patientId)
  if (!p) return null
  return {
    conditions: JSON.parse(p.conditions),
    doctorId: p.doctor_id,
    doctorName: p.doctor_id ? userName(ctx, p.doctor_id) : null,
    birthDate: ctx.cipher.decrypt(p.birth_date_enc),
    notes: ctx.cipher.decrypt(p.notes_enc),
    peakFlowBest: p.peak_flow_best,
  }
}
