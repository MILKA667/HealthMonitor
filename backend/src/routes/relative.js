/** Relative cabinet: read-only overview of linked patients (web platform for relatives). */
import { Router } from 'express'
import { requireRole } from '../middleware/auth.js'
import { hasHealthConsent } from '../services/consents.js'
import { logDataAccess } from '../services/audit.js'
import { getPatientProfile, userName } from '../services/users.js'
import { lastMeasurementAt } from './patients.js'

export function relativeRouter(ctx) {
  const r = Router()
  r.use(requireRole('relative'))

  r.get('/patients', (req, res) => {
    const links = ctx.db.prepare('SELECT patient_id, relation FROM relatives WHERE user_id = ?').all(req.user.id)
    res.json(
      links.map(({ patient_id: id, relation }) => {
        const consent = hasHealthConsent(ctx, id)
        if (consent) logDataAccess(ctx, req.user, id, 'relative:overview', req.ip)
        const open = consent ? ctx.db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE patient_id = ? AND status = 'open' AND severity = 'critical'").get(id).c : 0
        const profile = getPatientProfile(ctx, id)
        return { id, fullName: userName(ctx, id), relation, consent, doctorName: profile.doctorName, conditions: profile.conditions, openCritical: open, lastMeasurementAt: consent ? lastMeasurementAt(ctx, id) : null }
      }),
    )
  })

  return r
}
