/** Audit trail of user actions (KAN-46) and medical data access journal (KAN-48, 152-FZ). */

export function audit(ctx, actor, action, { entity = null, entityId = null, details = null, ip = null } = {}) {
  ctx.db
    .prepare('INSERT INTO audit_log (user_id, role, action, entity, entity_id, ip, details, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      actor?.id ?? null,
      actor?.role ?? null,
      action,
      entity,
      entityId === null ? null : String(entityId),
      ip,
      details ? JSON.stringify(details) : null,
      ctx.now().toISOString(),
    )
}

export function logDataAccess(ctx, actor, patientId, resource, ip = null) {
  ctx.db
    .prepare('INSERT INTO data_access_log (user_id, role, patient_id, resource, ip, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor.id, actor.role, patientId, resource, ip, ctx.now().toISOString())
}
