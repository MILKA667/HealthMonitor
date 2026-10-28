/**
 * Pilot data set (KAN-51): 5 doctors, 20 patients across the three conditions, relatives, devices,
 * two weeks of measurements and a few alerts. For test/pilot environments only — refuses to run in
 * production or against a non-empty database.
 *
 *   npm run seed            # uses HM_DB_FILE (default data/healthmonitor.db)
 */
import { loadConfig } from '../src/config.js'
import { createContext } from '../src/app.js'
import { createUser } from '../src/services/users.js'
import { currentDocuments, grantConsent } from '../src/services/consents.js'
import { recordMeasurement } from '../src/services/measurements.js'
import { randomToken, sha256 } from '../src/crypto.js'

const config = loadConfig()
if (config.env === 'production') {
  console.error('seed-pilot: refusing to run in production')
  process.exit(1)
}
const ctx = createContext({ config })
if (ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
  console.error('seed-pilot: database is not empty, nothing done')
  process.exit(1)
}

// The pilot password is never stored in the repository: take it from the environment or generate one.
const PASSWORD = process.env.HM_SEED_PASSWORD || randomToken(9)
const docs = currentDocuments(ctx)
const consent = (id, role) => docs.filter((d) => role === 'patient' || d.type !== 'health_data').forEach((d) => grantConsent(ctx, id, d.id))

const admin = createUser(ctx, { role: 'admin', email: 'admin@healthmonitor.local', password: PASSWORD, fullName: 'Администратор Пилота', phone: '+79000000001' })
consent(admin, 'admin')

const doctorSpecs = [
  ['Иванова Мария Сергеевна', 'Эндокринолог'],
  ['Петров Андрей Николаевич', 'Кардиолог'],
  ['Смирнова Ольга Викторовна', 'Пульмонолог'],
  ['Кузнецов Дмитрий Игоревич', 'Терапевт'],
  ['Соколова Елена Павловна', 'Эндокринолог'],
]
const doctors = doctorSpecs.map(([name, specialty], i) => {
  const id = createUser(ctx, { role: 'doctor', email: `doctor${i + 1}@healthmonitor.local`, password: PASSWORD, fullName: name, phone: `+7900100000${i + 1}` })
  ctx.db.prepare('UPDATE doctor_profiles SET specialty = ?, license_enc = ? WHERE user_id = ?').run(specialty, ctx.cipher.encrypt(`ЛИЦ-${1000 + i}`), id)
  consent(id, 'doctor')
  return { id, specialty }
})

const FIRST = ['Алексей', 'Наталья', 'Сергей', 'Ирина', 'Михаил', 'Татьяна', 'Владимир', 'Светлана', 'Николай', 'Галина']
const LAST = ['Волков', 'Морозова', 'Лебедев', 'Козлова', 'Новиков', 'Павлова', 'Фёдоров', 'Орлова', 'Егоров', 'Зайцева']
const CONDS = [['diabetes_t2'], ['hypertension'], ['asthma'], ['diabetes_t2', 'hypertension']]
const doctorFor = (conds) => (conds.includes('asthma') ? doctors[2] : conds[0] === 'hypertension' ? doctors[1] : doctors[(conds.length + 3) % 2 === 0 ? 0 : 4])

let seed = 42
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const around = (v, spread) => Math.round((v + (rnd() - 0.5) * 2 * spread) * 10) / 10

const now = ctx.now().getTime()
const patients = []
for (let i = 0; i < 20; i++) {
  const conditions = CONDS[i % CONDS.length]
  const name = `${LAST[i % 10]} ${FIRST[(i * 3) % 10]}`
  const id = createUser(ctx, { role: 'patient', email: `patient${i + 1}@healthmonitor.local`, password: PASSWORD, fullName: name, phone: `+790020000${String(i + 1).padStart(2, '0')}` })
  consent(id, 'patient')
  const doctor = i < 18 ? doctorFor(conditions) : null // two patients wait for doctor assignment
  ctx.db.prepare('UPDATE patient_profiles SET conditions = ?, doctor_id = ?, peak_flow_best = ? WHERE user_id = ?').run(JSON.stringify(conditions), doctor?.id ?? null, conditions.includes('asthma') ? 450 : null, id)
  if (!doctor) ctx.db.prepare("INSERT INTO requests (type, user_id, target_id, created_at) VALUES ('doctor_assignment', ?, ?, ?)").run(id, doctors[3].id, ctx.now().toISOString())
  ctx.db.prepare('INSERT INTO relatives (patient_id, name_enc, phone_enc, relation, notify_emergency, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, ctx.cipher.encrypt(`Родственник ${name}`), ctx.cipher.encrypt(`+790030000${String(i + 1).padStart(2, '0')}`), 'супруг(а)', ctx.now().toISOString())
  ctx.db.prepare("INSERT INTO reminders (patient_id, kind, title, time_of_day, created_at) VALUES (?, 'measurement', 'Утреннее измерение', '08:00', ?)").run(id, ctx.now().toISOString())
  patients.push({ id, conditions, regular: i % 5 !== 4 })
}

// Devices: one glucometer and one tonometer bound to the first diabetic/hypertensive patients.
const devices = []
for (const [adapter, kind, model, serial, patient] of [
  ['glucometer-v1', 'glucometer', 'GL-100', 'GL100-PILOT-01', patients[0]],
  ['tonometer-v1', 'tonometer', 'BP-300', 'BP300-PILOT-01', patients[1]],
]) {
  const key = `hmd_${randomToken(24)}`
  const { lastInsertRowid } = ctx.db.prepare('INSERT INTO devices (patient_id, kind, adapter, model, serial, api_key_hash, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(patient.id, kind, adapter, model, serial, sha256(key), ctx.now().toISOString())
  devices.push({ id: Number(lastInsertRowid), adapter, serial, key, patientId: patient.id })
}

// 14 days of history. Regular patients measure daily, the others every 3–4 days.
let count = 0
for (const p of patients) {
  for (let day = 14; day >= 1; day--) {
    if (!p.regular && day % 4 !== 0) continue
    const at = new Date(now - day * 86400_000 + 8 * 3600_000).toISOString()
    const deviceFor = (type) => devices.find((d) => d.patientId === p.id && (type === 'glucose' ? d.adapter === 'glucometer-v1' : d.adapter === 'tonometer-v1'))
    const write = (type, raw) => {
      const d = deviceFor(type)
      recordMeasurement(ctx, { patientId: p.id, type, raw, measuredAt: at, source: d ? 'device' : 'manual', deviceId: d?.id ?? null })
      count++
    }
    if (p.conditions.includes('diabetes_t2')) write('glucose', { glucose: around(7.2, 2.5) })
    if (p.conditions.includes('hypertension')) write('blood_pressure', { systolic: Math.round(around(138, 14)), diastolic: Math.round(around(86, 7)), pulse: Math.round(around(74, 8)) })
    if (p.conditions.includes('asthma')) write('peak_flow', { peak_flow: Math.round(around(390, 50)) })
  }
}

// Acknowledge most historic alerts so reaction-time metrics are populated.
const alerts = ctx.db.prepare("SELECT id, created_at, patient_id FROM alerts WHERE status = 'open'").all()
alerts.slice(0, Math.floor(alerts.length * 0.8)).forEach((a, i) => {
  const doctor = ctx.db.prepare('SELECT doctor_id FROM patient_profiles WHERE user_id = ?').get(a.patient_id).doctor_id
  if (!doctor) return
  const ack = new Date(new Date(a.created_at).getTime() + (3 + (i % 10)) * 60_000).toISOString()
  ctx.db.prepare("UPDATE alerts SET status = 'resolved', acknowledged_at = ?, acknowledged_by = ?, resolved_at = ? WHERE id = ?").run(ack, doctor, ack, a.id)
})
ctx.db.prepare("UPDATE notifications SET status = 'sent', sent_at = created_at WHERE status = 'queued'").run()

console.log(`Pilot data created: 1 admin, ${doctors.length} doctors, ${patients.length} patients, ${count} measurements, ${alerts.length} alerts.`)
console.log(process.env.HM_SEED_PASSWORD ? 'Password for all pilot accounts: value of HM_SEED_PASSWORD' : `Generated password for all pilot accounts (shown once): ${PASSWORD}`)
console.log('  admin@healthmonitor.local, doctor1..5@healthmonitor.local, patient1..20@healthmonitor.local')
console.log('Device keys for scripts/simulate-devices.js:')
for (const d of devices) console.log(`  ${d.adapter} serial=${d.serial} key=${d.key}`)
ctx.db.close()
