/** Device binding in the patient cabinet (KAN-36) and device data ingestion (KAN-34, KAN-35). */
import { Router } from 'express'
import { randomToken, sha256 } from '../crypto.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js'
import { intParam, validate } from '../validate.js'
import { requireRole } from '../middleware/auth.js'
import { audit } from '../services/audit.js'
import { hasHealthConsent } from '../services/consents.js'
import { recordMeasurement } from '../services/measurements.js'
import { ADAPTERS, adapterList, KIND_TYPES } from '../integrations/adapters.js'
import { rateLimit } from '../middleware/rateLimit.js'

function decodeDevice(d) {
  return { id: d.id, kind: d.kind, adapter: d.adapter, adapterTitle: ADAPTERS[d.adapter]?.title, model: d.model, serial: d.serial, active: Boolean(d.active), linkedAt: d.linked_at, lastSyncAt: d.last_sync_at }
}

export function devicesRouter(ctx) {
  const r = Router()

  r.get('/adapters', (_req, res) => res.json(adapterList()))

  r.get('/', requireRole('patient'), (req, res) => {
    res.json(ctx.db.prepare('SELECT * FROM devices WHERE patient_id = ? ORDER BY active DESC, id DESC').all(req.user.id).map(decodeDevice))
  })

  /** Pairs a device; the API key is shown once and configured in the device bridge / vendor webhook. */
  r.post('/', requireRole('patient'), (req, res) => {
    const input = validate(req.body, {
      adapter: { type: 'string', required: true, enum: Object.keys(ADAPTERS) },
      kind: { type: 'string', enum: ['glucometer', 'tonometer'] },
      model: { type: 'string', required: true, maxLength: 100 },
      serial: { type: 'string', required: true, maxLength: 100, pattern: /^[A-Za-z0-9._-]+$/, patternMessage: 'латиница, цифры, . _ -' },
    })
    const adapter = ADAPTERS[input.adapter]
    const kind = adapter.kind ?? input.kind
    if (!kind) throw badRequest('Укажите тип устройства', { kind: 'обязательное поле' })
    if (adapter.kind && input.kind && input.kind !== adapter.kind) throw badRequest('Тип устройства не соответствует протоколу')
    if (ctx.db.prepare('SELECT 1 FROM devices WHERE adapter = ? AND serial = ? AND active = 1').get(input.adapter, input.serial)) {
      throw conflict('Устройство с таким серийным номером уже привязано')
    }
    const apiKey = `hmd_${randomToken(24)}`
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO devices (patient_id, kind, adapter, model, serial, api_key_hash, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, kind, input.adapter, input.model, input.serial, sha256(apiKey), ctx.now().toISOString())
    audit(ctx, req.user, 'device.linked', { entity: 'device', entityId: lastInsertRowid, details: { adapter: input.adapter, kind }, ip: req.ip })
    res.status(201).json({ device: decodeDevice(ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(lastInsertRowid)), apiKey })
  })

  r.delete('/:id', requireRole('patient'), (req, res) => {
    const d = ctx.db.prepare('SELECT * FROM devices WHERE id = ? AND patient_id = ?').get(intParam(req.params.id), req.user.id)
    if (!d) throw notFound('Устройство не найдено')
    ctx.db.prepare('UPDATE devices SET active = 0 WHERE id = ?').run(d.id)
    audit(ctx, req.user, 'device.unlinked', { entity: 'device', entityId: d.id, ip: req.ip })
    res.status(204).end()
  })

  return r
}

export function integrationsRouter(ctx) {
  const r = Router()
  r.use(rateLimit({ windowMs: 60_000, max: 120, now: ctx.now }))

  r.post('/:adapter/readings', (req, res) => {
    const adapter = ADAPTERS[req.params.adapter]
    if (!adapter) throw notFound('Неизвестный протокол устройства')
    const key = req.get('x-device-key')
    if (!key) throw unauthorized('Нужен заголовок X-Device-Key')
    const device = ctx.db.prepare('SELECT * FROM devices WHERE api_key_hash = ? AND active = 1').get(sha256(key))
    if (!device || device.adapter !== req.params.adapter) throw unauthorized('Ключ устройства недействителен')
    const serial = adapter.serialOf(req.body)
    if (serial && serial !== device.serial) throw forbidden('Серийный номер не совпадает с привязанным устройством', 'SERIAL_MISMATCH')
    if (!hasHealthConsent(ctx, device.patient_id)) throw forbidden('Пациент отозвал согласие на обработку данных о здоровье', 'CONSENT_REQUIRED')

    const readings = adapter.parse(req.body)
    const allowedType = KIND_TYPES[device.kind]
    const results = { accepted: 0, duplicates: 0, rejected: [], alerts: 0 }
    readings.forEach((reading, index) => {
      if (reading.error) return results.rejected.push({ index, error: reading.error })
      if (reading.type !== allowedType) return results.rejected.push({ index, error: 'Тип показания не соответствует устройству' })
      try {
        const m = recordMeasurement(ctx, { patientId: device.patient_id, type: reading.type, raw: reading.raw, measuredAt: reading.measuredAt ?? undefined, source: 'device', deviceId: device.id })
        if (!m) results.duplicates++
        else {
          results.accepted++
          results.alerts += m.alerts.length
        }
      } catch (err) {
        results.rejected.push({ index, error: err.message, details: err.details })
      }
    })
    ctx.db.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ?').run(ctx.now().toISOString(), device.id)
    audit(ctx, { id: device.patient_id, role: 'device' }, 'device.sync', { entity: 'device', entityId: device.id, details: { accepted: results.accepted, duplicates: results.duplicates, rejected: results.rejected.length }, ip: req.ip })
    res.status(results.accepted || results.duplicates || !readings.length ? 200 : 422).json(results)
  })

  return r
}
