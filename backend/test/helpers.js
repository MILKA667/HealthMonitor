import { loadConfig } from '../src/config.js'
import { createApp, createContext } from '../src/app.js'
import { createUser } from '../src/services/users.js'
import { deliverQueued } from '../src/services/notify.js'

/** Spins up an isolated API (in-memory DB, controllable clock) on a random port. */
export async function startTestServer(overrides = {}, env = {}) {
  let now = new Date('2026-10-01T09:00:00.000Z')
  const config = loadConfig({ NODE_ENV: 'test', ...env }, { dbFile: ':memory:', now: () => new Date(now), ...overrides })
  const ctx = createContext({ config })
  const app = createApp(ctx)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  async function api(method, path, { body, token, headers = {}, raw = false } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (raw) return res
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { status: res.status, body: data, headers: res.headers }
  }

  async function consentIds(role = 'patient') {
    const docs = (await api('GET', '/api/consents/documents')).body
    return docs.filter((d) => role === 'patient' || d.type !== 'health_data').map((d) => d.id)
  }

  let seq = 0
  async function registerPatient(extra = {}) {
    seq++
    const res = await api('POST', '/api/auth/register', {
      body: { role: 'patient', email: `patient${seq}@test.ru`, password: 'password123', fullName: `Пациент ${seq}`, phone: `+7900000${String(seq).padStart(4, '0')}`, consents: await consentIds(), conditions: ['diabetes_t2'], ...extra },
    })
    if (res.status !== 201) throw new Error(`register patient failed: ${JSON.stringify(res.body)}`)
    return { token: res.body.token, user: res.body.user }
  }

  function createAdmin() {
    seq++
    const email = `admin${seq}@test.ru`
    createUser(ctx, { role: 'admin', email, password: 'adminpass123', fullName: `Админ ${seq}`, phone: '+79990000000' })
    return login(email, 'adminpass123')
  }

  async function login(email, password) {
    const res = await api('POST', '/api/auth/login', { body: { email, password } })
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`)
    return { token: res.body.token, user: res.body.user }
  }

  /** Active doctor (created directly, as if approved by moderation). */
  async function createDoctor(name) {
    seq++
    const email = `doctor${seq}@test.ru`
    createUser(ctx, { role: 'doctor', email, password: 'doctorpass123', fullName: name ?? `Врач ${seq}`, phone: `+7911000${String(seq).padStart(4, '0')}` })
    return login(email, 'doctorpass123')
  }

  /** Patient already assigned to the given doctor. */
  async function patientOf(doctor, extra) {
    const p = await registerPatient(extra)
    ctx.db.prepare('UPDATE patient_profiles SET doctor_id = ? WHERE user_id = ?').run(doctor.user.id, p.user.id)
    return p
  }

  return {
    ctx,
    api,
    base,
    consentIds,
    registerPatient,
    createAdmin,
    createDoctor,
    patientOf,
    login,
    advance: (ms) => { now = new Date(now.getTime() + ms) },
    setNow: (d) => { now = new Date(d) },
    flush: () => deliverQueued(ctx),
    outbox: (filter = {}) => {
      const rows = ctx.db.prepare('SELECT * FROM notifications ORDER BY id').all()
      return rows
        .map((n) => ({ ...n, recipient: ctx.cipher.decrypt(n.recipient_enc) }))
        .filter((n) => Object.entries(filter).every(([k, v]) => n[k] === v))
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
