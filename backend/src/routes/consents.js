/** Consent documents and the user's consents: grant, revoke, versions (KAN-49). */
import { Router } from 'express'
import { intParam, validate } from '../validate.js'
import { requireAuth } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { consentStatus, currentDocuments, grantConsent, revokeConsent, userConsents } from '../services/consents.js'
import { notify } from '../services/notify.js'

export function consentsRouter(ctx) {
  const r = Router()

  /** Public: shown on the registration form. */
  r.get('/documents', (_req, res) => res.json(currentDocuments(ctx)))

  r.get('/me', requireAuth, (req, res) => {
    res.json({ consents: userConsents(ctx, req.user.id), status: consentStatus(ctx, req.user.id), documents: currentDocuments(ctx) })
  })

  r.post('/', requireAuth, (req, res) => {
    const { documentId } = validate(req.body, { documentId: { type: 'number', integer: true, required: true } })
    const id = grantConsent(ctx, req.user.id, documentId, req.ip)
    audit(ctx, req.user, 'consent.granted', { entity: 'consent', entityId: id, details: { documentId }, ip: req.ip })
    res.status(201).json({ id, status: consentStatus(ctx, req.user.id) })
  })

  r.post('/:id/revoke', requireAuth, (req, res) => {
    const c = revokeConsent(ctx, req.user.id, intParam(req.params.id))
    audit(ctx, req.user, 'consent.revoked', { entity: 'consent', entityId: c.id, ip: req.ip })
    const status = consentStatus(ctx, req.user.id)
    if (req.user.role === 'patient' && !status.health_data.active) {
      const doctor = ctx.db.prepare('SELECT doctor_id FROM patient_profiles WHERE user_id = ?').get(req.user.id)?.doctor_id
      if (doctor) notify(ctx, { userId: doctor, title: 'Пациент отозвал согласие', body: 'Доступ к медицинским данным пациента прекращён до повторного согласия.', kind: 'consent' })
    }
    res.json({ revokedAt: c.revoked_at, status })
  })

  return r
}
