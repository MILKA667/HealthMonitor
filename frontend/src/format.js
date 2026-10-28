export const CONDITIONS = {
  diabetes_t2: 'Сахарный диабет 2 типа',
  hypertension: 'Артериальная гипертония',
  asthma: 'Бронхиальная астма',
}

export const ROLE_LABELS = { patient: 'Пациент', doctor: 'Врач', relative: 'Родственник', admin: 'Администратор' }
export const STATUS_LABELS = { active: 'Активен', pending: 'На модерации', blocked: 'Заблокирован', rejected: 'Отклонён' }
export const ALERT_STATUS = { open: 'Новый', acknowledged: 'Принят', resolved: 'Закрыт' }
export const SEVERITY = { critical: 'Критический', warning: 'Отклонение', normal: 'Норма', stale: 'Нет данных' }

export const TYPES = {
  glucose: { label: 'Глюкоза', metrics: ['glucose'] },
  blood_pressure: { label: 'Давление', metrics: ['systolic', 'diastolic', 'pulse'] },
  peak_flow: { label: 'ПСВ', metrics: ['peak_flow'] },
}

export const METRICS = {
  glucose: { label: 'Глюкоза', unit: 'ммоль/л', short: 'Глюкоза' },
  systolic: { label: 'Систолическое АД', unit: 'мм рт. ст.', short: 'САД' },
  diastolic: { label: 'Диастолическое АД', unit: 'мм рт. ст.', short: 'ДАД' },
  pulse: { label: 'Пульс', unit: 'уд/мин', short: 'Пульс' },
  peak_flow: { label: 'Пиковая скорость выдоха', unit: 'л/мин', short: 'ПСВ' },
}

/** Which measurement types are relevant for a set of conditions. */
export function typesFor(conditions = []) {
  const t = new Set()
  if (conditions.includes('diabetes_t2')) t.add('glucose')
  if (conditions.includes('hypertension')) t.add('blood_pressure')
  if (conditions.includes('asthma')) t.add('peak_flow')
  return t.size ? [...t] : Object.keys(TYPES)
}

const TZ = 'Europe/Moscow'
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { timeZone: TZ }) : '—')
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '')
export const fmtNum = (v) => (v === null || v === undefined ? '—' : String(v).replace('.', ','))

export function fmtValue(type, value) {
  if (!value) return '—'
  if (type === 'glucose') return `${fmtNum(value.glucose)} ммоль/л`
  if (type === 'blood_pressure') return `${value.systolic}/${value.diastolic} мм рт. ст.${value.pulse ? ` · пульс ${value.pulse}` : ''}`
  if (type === 'peak_flow') return `${value.peak_flow} л/мин`
  return JSON.stringify(value)
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'нет данных'
  const min = Math.round((now - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.round(h / 24)} дн назад`
}
