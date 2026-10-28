/**
 * Consent management (KAN-49). Per 152-FZ (as amended, in force from 01.09.2025) consent to the
 * processing of personal data — and separately of special-category health data — is a standalone
 * document, not a clause of the user agreement. Documents are versioned; consent can be revoked.
 */
import { badRequest, forbidden, notFound } from '../errors.js'

export const CONSENT_TYPES = ['personal_data', 'health_data', 'user_agreement']
export const REQUIRED_FOR_PATIENT = ['personal_data', 'health_data', 'user_agreement']
export const REQUIRED_FOR_OTHERS = ['personal_data', 'user_agreement']

const INITIAL_DOCUMENTS = [
  {
    type: 'personal_data',
    title: 'Согласие на обработку персональных данных',
    body:
      'Я даю согласие оператору платформы HealthMonitor на обработку моих персональных данных (ФИО, e-mail, номер телефона, дата рождения) ' +
      'с целью предоставления услуг удалённого мониторинга. Обработка осуществляется на серверах, расположенных на территории Российской Федерации. ' +
      'Согласие действует до его отзыва; отозвать согласие можно в личном кабинете в любой момент.',
  },
  {
    type: 'health_data',
    title: 'Согласие на обработку специальной категории персональных данных (сведения о состоянии здоровья)',
    body:
      'Я даю согласие на обработку сведений о состоянии моего здоровья (диагнозы, показатели глюкозы, артериального давления, пиковой скорости выдоха, ' +
      'данные медицинских устройств, переписка с лечащим врачом) лечащим врачом, назначенным через платформу HealthMonitor, в целях медицинского наблюдения. ' +
      'Я согласен(на) на передачу экстренных уведомлений указанным мной родственникам. Согласие оформляется отдельно от пользовательского соглашения и может быть отозвано; ' +
      'после отзыва доступ врача и родственников к медицинским данным прекращается.',
  },
  {
    type: 'user_agreement',
    title: 'Пользовательское соглашение',
    body:
      'Платформа HealthMonitor является инструментом дистанционного наблюдения и не заменяет врачебную диагностику. Платформа не формирует медицинских ' +
      'рекомендаций пациенту: клиническое решение принимает лечащий врач. Уведомления об отклонениях показателей носят информационный характер; при ухудшении ' +
      'самочувствия необходимо обращаться в экстренные службы (112, 103).',
  },
]

export function ensureConsentDocuments(ctx) {
  const insert = ctx.db.prepare('INSERT OR IGNORE INTO consent_documents (type, version, title, body, published_at) VALUES (?, ?, ?, ?, ?)')
  for (const d of INITIAL_DOCUMENTS) insert.run(d.type, '1.0', d.title, d.body, ctx.now().toISOString())
}

export function currentDocuments(ctx) {
  return ctx.db
    .prepare(
      `SELECT d.* FROM consent_documents d
       WHERE d.published_at = (SELECT MAX(published_at) FROM consent_documents x WHERE x.type = d.type)
       ORDER BY d.type`,
    )
    .all()
    .map((d) => ({ id: d.id, type: d.type, version: d.version, title: d.title, body: d.body, publishedAt: d.published_at }))
}

export function publishDocument(ctx, { type, version, title, body }) {
  if (!CONSENT_TYPES.includes(type)) throw badRequest('Неизвестный тип документа')
  const exists = ctx.db.prepare('SELECT 1 FROM consent_documents WHERE type = ? AND version = ?').get(type, version)
  if (exists) throw badRequest('Такая версия уже опубликована')
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO consent_documents (type, version, title, body, published_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, version, title, body, ctx.now().toISOString())
  return Number(lastInsertRowid)
}

export function grantConsent(ctx, userId, documentId, ip = null) {
  const doc = ctx.db.prepare('SELECT * FROM consent_documents WHERE id = ?').get(documentId)
  if (!doc) throw notFound('Документ согласия не найден')
  const active = ctx.db.prepare('SELECT id FROM consents WHERE user_id = ? AND document_id = ? AND revoked_at IS NULL').get(userId, documentId)
  if (active) return active.id
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO consents (user_id, document_id, granted_at, ip) VALUES (?, ?, ?, ?)')
    .run(userId, documentId, ctx.now().toISOString(), ip)
  return Number(lastInsertRowid)
}

export function revokeConsent(ctx, userId, consentId) {
  const c = ctx.db.prepare('SELECT * FROM consents WHERE id = ? AND user_id = ?').get(consentId, userId)
  if (!c) throw notFound('Согласие не найдено')
  if (c.revoked_at) return c
  ctx.db.prepare('UPDATE consents SET revoked_at = ? WHERE id = ?').run(ctx.now().toISOString(), consentId)
  return ctx.db.prepare('SELECT * FROM consents WHERE id = ?').get(consentId)
}

export function userConsents(ctx, userId) {
  return ctx.db
    .prepare(
      `SELECT c.*, d.type, d.version, d.title FROM consents c JOIN consent_documents d ON d.id = c.document_id
       WHERE c.user_id = ? ORDER BY c.granted_at DESC`,
    )
    .all(userId)
    .map((c) => ({ id: c.id, documentId: c.document_id, type: c.type, version: c.version, title: c.title, grantedAt: c.granted_at, revokedAt: c.revoked_at }))
}

/** Consent status per type: active (any version, not revoked) and whether the latest version is accepted. */
export function consentStatus(ctx, userId) {
  const current = Object.fromEntries(currentDocuments(ctx).map((d) => [d.type, d]))
  const mine = userConsents(ctx, userId).filter((c) => !c.revokedAt)
  const status = {}
  for (const type of CONSENT_TYPES) {
    const active = mine.filter((c) => c.type === type)
    status[type] = {
      active: active.length > 0,
      latestAccepted: active.some((c) => c.documentId === current[type]?.id),
      currentDocumentId: current[type]?.id ?? null,
    }
  }
  return status
}

export function hasHealthConsent(ctx, patientId) {
  return Boolean(
    ctx.db
      .prepare(
        `SELECT 1 FROM consents c JOIN consent_documents d ON d.id = c.document_id
         WHERE c.user_id = ? AND d.type = 'health_data' AND c.revoked_at IS NULL`,
      )
      .get(patientId),
  )
}

export function requireHealthConsent(ctx, patientId) {
  if (!hasHealthConsent(ctx, patientId)) {
    throw forbidden('Пациент не дал (или отозвал) согласие на обработку сведений о состоянии здоровья', 'CONSENT_REQUIRED')
  }
}
