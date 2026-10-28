/**
 * Integration layer (KAN-33): every vendor protocol is an adapter that converts a vendor payload
 * into canonical readings { type, raw, measuredAt }. Validation and unit normalization (KAN-37) then
 * happen in services/measurements.js, identically for manual input and devices.
 *
 * Adding a new device model = adding an adapter here; nothing else changes.
 */
import { badRequest } from '../errors.js'

const asArray = (v, field) => {
  if (!Array.isArray(v)) throw badRequest(`Ожидается массив ${field}`)
  if (v.length > 500) throw badRequest('Не более 500 показаний за один запрос')
  return v
}

export const ADAPTERS = {
  /** Glucometer with a JSON export (e.g. via a vendor USB/BLE bridge): glucose in mg/dL or mmol/L. */
  'glucometer-v1': {
    kind: 'glucometer',
    title: 'Глюкометр (JSON-протокол v1)',
    models: ['GL-100', 'GL-200 BLE'],
    serialOf: (p) => p?.serial,
    parse(p) {
      return asArray(p?.readings, 'readings').map((r) => ({
        type: 'glucose',
        measuredAt: r.timestamp,
        raw: { glucose: r.glucose, unit: r.unit ?? 'mmol/L', context: { F: 'fasting', B: 'before_meal', A: 'after_meal' }[r.mealFlag] },
      }))
    },
  },
  /** Automatic blood-pressure monitor uploading through the vendor cloud webhook. */
  'tonometer-v1': {
    kind: 'tonometer',
    title: 'Тонометр (облачный webhook v1)',
    models: ['BP-300', 'BP-500 BLE'],
    serialOf: (p) => p?.deviceSerial,
    parse(p) {
      return asArray(p?.measurements, 'measurements').map((m) => ({
        type: 'blood_pressure',
        measuredAt: m.dateTime,
        raw: { systolic: m.sys, diastolic: m.dia, pulse: m.pulse },
      }))
    },
  },
  /** Readings synced from the phone health store (Google Health Connect data points). */
  'health-connect': {
    kind: null,
    title: 'Google Health Connect',
    models: ['Health Connect'],
    serialOf: (p) => p?.sourceDevice,
    parse(p) {
      return asArray(p?.dataPoints, 'dataPoints').map((d) => {
        if (d.dataType === 'BloodGlucose') {
          return { type: 'glucose', measuredAt: d.time, raw: { glucose: d.value?.mmolPerL ?? d.value?.mgPerDl, unit: d.value?.mmolPerL !== undefined ? 'mmol/L' : 'mg/dL' } }
        }
        if (d.dataType === 'BloodPressure') {
          return { type: 'blood_pressure', measuredAt: d.time, raw: { systolic: d.value?.systolicMmHg, diastolic: d.value?.diastolicMmHg, pulse: d.value?.pulseBpm } }
        }
        return { error: `Неподдерживаемый тип данных ${d.dataType}` }
      })
    },
  },
}

export const KIND_TYPES = { glucometer: 'glucose', tonometer: 'blood_pressure' }

export function adapterList() {
  return Object.entries(ADAPTERS).map(([id, a]) => ({ id, kind: a.kind, title: a.title, models: a.models }))
}
