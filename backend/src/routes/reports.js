/** Analytics and reports for the doctor (KAN-32): JSON and PDF export. Patients may export their own report. */
import { Router } from 'express'
import { intParam, validate } from '../validate.js'
import { accessPatient, requireAuth } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { patientReport } from '../services/analytics.js'
import { listMeasurements } from '../services/measurements.js'
import { buildPatientReportDoc, renderPdf } from '../services/pdf.js'

export function reportsRouter(ctx) {
  const r = Router()
  r.use(requireAuth)

  const PERIOD = { from: { type: 'date' }, to: { type: 'date' } }

  r.get('/patients/:id', (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'report:json', ['self', 'doctor'])
    res.json(patientReport(ctx, patientId, validate(req.query, PERIOD)))
  })

  r.get('/patients/:id/pdf', async (req, res) => {
    const patientId = intParam(req.params.id)
    accessPatient(ctx, req, patientId, 'report:pdf', ['self', 'doctor'])
    const report = patientReport(ctx, patientId, validate(req.query, PERIOD))
    const measurements = listMeasurements(ctx, patientId, { from: report.period.from, to: report.period.to, limit: 5000 })
    const pdf = await renderPdf(buildPatientReportDoc(report, measurements))
    audit(ctx, req.user, 'report.exported', { entity: 'patient', entityId: patientId, details: { format: 'pdf', from: report.period.from, to: report.period.to }, ip: req.ip })
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="healthmonitor-report-${patientId}-${report.period.to.slice(0, 10)}.pdf"` })
    res.send(pdf)
  })

  return r
}
