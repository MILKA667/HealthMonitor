import { badRequest } from './errors.js'

/** Minimal declarative validator: schema is { field: { type, required, min, max, enum, pattern, maxLength } }. */
export function validate(body, schema) {
  const input = body && typeof body === 'object' ? body : {}
  const out = {}
  const errors = {}
  for (const [key, rule] of Object.entries(schema)) {
    let v = input[key]
    if (v === undefined || v === null || v === '') {
      if (rule.required) errors[key] = 'обязательное поле'
      else if (rule.default !== undefined) out[key] = rule.default
      continue
    }
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string') { errors[key] = 'должно быть строкой'; continue }
        v = v.trim()
        if (rule.minLength && v.length < rule.minLength) { errors[key] = `минимум ${rule.minLength} символов`; continue }
        if (v.length > (rule.maxLength ?? 1000)) { errors[key] = `максимум ${rule.maxLength ?? 1000} символов`; continue }
        if (rule.pattern && !rule.pattern.test(v)) { errors[key] = rule.patternMessage || 'неверный формат'; continue }
        break
      case 'number':
        v = typeof v === 'string' ? Number(v.replace(',', '.')) : v
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors[key] = 'должно быть числом'; continue }
        if (rule.integer && !Number.isInteger(v)) { errors[key] = 'должно быть целым'; continue }
        if (rule.min !== undefined && v < rule.min) { errors[key] = `не меньше ${rule.min}`; continue }
        if (rule.max !== undefined && v > rule.max) { errors[key] = `не больше ${rule.max}`; continue }
        break
      case 'boolean':
        if (typeof v !== 'boolean') { errors[key] = 'должно быть true/false'; continue }
        break
      case 'date':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) { errors[key] = 'неверная дата'; continue }
        v = new Date(v).toISOString()
        break
      case 'array':
        if (!Array.isArray(v)) { errors[key] = 'должно быть массивом'; continue }
        if (rule.items?.enum && v.some((x) => !rule.items.enum.includes(x))) { errors[key] = `допустимо: ${rule.items.enum.join(', ')}`; continue }
        if (rule.maxItems && v.length > rule.maxItems) { errors[key] = `максимум ${rule.maxItems}`; continue }
        break
      default:
        break
    }
    if (rule.enum && !rule.enum.includes(v)) { errors[key] = `допустимо: ${rule.enum.join(', ')}`; continue }
    out[key] = v
  }
  if (Object.keys(errors).length) throw badRequest('Ошибка валидации', errors)
  return out
}

export const EMAIL = { type: 'string', required: true, maxLength: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMessage: 'неверный e-mail' }
export const PHONE = { type: 'string', maxLength: 20, pattern: /^\+7\d{10}$/, patternMessage: 'формат +7XXXXXXXXXX' }
export const PASSWORD = { type: 'string', required: true, minLength: 8, maxLength: 128 }

export function intParam(value, name = 'id') {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Неверный параметр ${name}`)
  return n
}
