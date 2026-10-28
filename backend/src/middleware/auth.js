/** Authentication and role-based access control (KAN-44). */
import { verifyJwt } from '../crypto.js'
import { forbidden, notFound, unauthorized } from '../errors.js'
import { requireHealthConsent } from '../services/consents.js'
import { logDataAccess } from '../services/audit.js'

/** Permission matrix. Administrators manage the platform but have no access to medical data. */
export const PERMISSIONS = {
  patient: ['own:profile', 'own:measurements:write', 'own:medical:read', 'own:devices', 'own:relatives', 'own:reminders', 'chat', 'own:consents'],
  doctor: ['patients:assigned:read', 'thresholds:write', 'alerts:handle', 'reports', 'chat', 'requests:assignment', 'own:consents'],
  relative: ['patients:linked:read', 'own:consents'],
  admin: ['users:manage', 'roles:manage', 'audit:read', 'requests:moderate', 'backups', 'metrics:read', 'consents:publish', 'own:consents'],
}

export function hasPermission(role, perm) {
  return PERMISSIONS[role]?.includes(perm) ?? false
}

export function authenticate(ctx) {
  return (req, _res, next) => {
    const header = req.get('authorization') || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return next()
    const claims = verifyJwt(token, ctx.config.jwtSecret, ctx.now())
    if (!claims) return next()
    const row = ctx.db.prepare('SELECT id, role, status, token_version FROM users WHERE id = ?').get(claims.sub)
    if (!row || row.status !== 'active' || row.token_version !== claims.tv) return next()
    req.user = { id: row.id, role: row.role }
    next()
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized())
  next()
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    if (!roles.includes(req.user.role)) return next(forbidden())
    next()
  }
}

export function requirePermission(perm) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    if (!hasPermission(req.user.role, perm)) return next(forbidden())
    next()
  }
}

/**
 * Resolves the caller's relation to a patient: 'self', 'doctor' (attending) or 'relative' (linked).
 * Returns null when there is no relation.
 */
export function relationToPatient(ctx, user, patientId) {
  const patient = ctx.db.prepare("SELECT u.id, p.doctor_id FROM users u JOIN patient_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'patient'").get(patientId)
  if (!patient) return { patient: null, relation: null }
  if (user.role === 'patient' && user.id === patientId) return { patient, relation: 'self' }
  if (user.role === 'doctor' && patient.doctor_id === user.id) return { patient, relation: 'doctor' }
  if (user.role === 'relative') {
    const link = ctx.db.prepare('SELECT 1 FROM relatives WHERE patient_id = ? AND user_id = ?').get(patientId, user.id)
    if (link) return { patient, relation: 'relative' }
  }
  return { patient, relation: null }
}

/**
 * Guards access to a patient's medical data: checks the relation, the patient's health-data consent
 * (for third parties) and writes the access journal entry (KAN-48).
 */
export function accessPatient(ctx, req, patientId, resource, allowed = ['self', 'doctor', 'relative']) {
  const { patient, relation } = relationToPatient(ctx, req.user, patientId)
  if (!patient) throw notFound('Пациент не найден')
  if (!relation || !allowed.includes(relation)) throw forbidden('Нет доступа к данным пациента')
  if (relation !== 'self') requireHealthConsent(ctx, patientId)
  logDataAccess(ctx, req.user, patientId, resource, req.ip)
  return relation
}
