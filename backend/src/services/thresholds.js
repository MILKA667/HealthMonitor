/**
 * Alert thresholds (KAN-31). Defaults only decide when the doctor is alerted; the doctor sets
 * individual values per patient. The platform never turns them into advice to the patient.
 */
export const METRICS = {
  glucose: { label: 'Глюкоза', unit: 'ммоль/л', type: 'glucose' },
  systolic: { label: 'Систолическое АД', unit: 'мм рт. ст.', type: 'blood_pressure' },
  diastolic: { label: 'Диастолическое АД', unit: 'мм рт. ст.', type: 'blood_pressure' },
  pulse: { label: 'Пульс', unit: 'уд/мин', type: 'blood_pressure' },
  peak_flow: { label: 'ПСВ', unit: 'л/мин', type: 'peak_flow' },
}

const DEFAULTS = {
  glucose: { critLow: 3.0, warnLow: 3.9, warnHigh: 10.0, critHigh: 15.0 },
  systolic: { critLow: 80, warnLow: 90, warnHigh: 140, critHigh: 180 },
  diastolic: { critLow: 50, warnLow: 60, warnHigh: 90, critHigh: 110 },
  pulse: { critLow: 40, warnLow: 50, warnHigh: 100, critHigh: 130 },
}

/** Peak flow zones relative to the personal best: yellow below 80%, red below 50%. */
function peakFlowDefaults(best) {
  const b = best || 400
  return { critLow: Math.round(b * 0.5), warnLow: Math.round(b * 0.8), warnHigh: null, critHigh: null }
}

export function effectiveThresholds(ctx, patientId) {
  const profile = ctx.db.prepare('SELECT peak_flow_best FROM patient_profiles WHERE user_id = ?').get(patientId)
  const result = {}
  for (const metric of Object.keys(METRICS)) {
    const base = metric === 'peak_flow' ? peakFlowDefaults(profile?.peak_flow_best) : DEFAULTS[metric]
    result[metric] = { ...base, custom: false }
  }
  for (const row of ctx.db.prepare('SELECT * FROM thresholds WHERE patient_id = ?').all(patientId)) {
    result[row.metric] = {
      critLow: row.crit_low,
      warnLow: row.warn_low,
      warnHigh: row.warn_high,
      critHigh: row.crit_high,
      custom: true,
      setBy: row.set_by,
      updatedAt: row.updated_at,
    }
  }
  return result
}

/** Returns 'normal' | 'warning' | 'critical' and the bound that was crossed. */
export function classify(value, t) {
  if (t.critLow != null && value < t.critLow) return { severity: 'critical', bound: 'critLow', limit: t.critLow }
  if (t.critHigh != null && value > t.critHigh) return { severity: 'critical', bound: 'critHigh', limit: t.critHigh }
  if (t.warnLow != null && value < t.warnLow) return { severity: 'warning', bound: 'warnLow', limit: t.warnLow }
  if (t.warnHigh != null && value > t.warnHigh) return { severity: 'warning', bound: 'warnHigh', limit: t.warnHigh }
  return { severity: 'normal' }
}

export function checkThresholdOrder(t) {
  const seq = [t.critLow, t.warnLow, t.warnHigh, t.critHigh].filter((v) => v !== null && v !== undefined)
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return false
  return seq.length > 0
}
