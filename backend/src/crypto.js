import crypto from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$')
  if (scheme !== 'scrypt') return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT)
  return crypto.timingSafeEqual(expected, actual)
}

/** AES-256-GCM field encryption. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function createCipher(key) {
  return {
    encrypt(value) {
      if (value === null || value === undefined) return null
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()])
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
    },
    decrypt(token) {
      if (token === null || token === undefined) return null
      const [v, iv, tag, data] = String(token).split('.')
      if (v !== 'v1') throw new Error('Unknown ciphertext version')
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      d.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
    },
    encryptJson(obj) {
      return this.encrypt(JSON.stringify(obj))
    },
    decryptJson(token) {
      const s = this.decrypt(token)
      return s === null ? null : JSON.parse(s)
    },
    encryptBuffer(buf) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(buf), c.final()])
      return Buffer.concat([Buffer.from('HMB1'), iv, c.getAuthTag(), data])
    },
    decryptBuffer(buf) {
      if (buf.subarray(0, 4).toString() !== 'HMB1') throw new Error('Not a HealthMonitor encrypted blob')
      const iv = buf.subarray(4, 16)
      const tag = buf.subarray(16, 32)
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(buf.subarray(32)), d.final()])
    },
  }
}

/** Deterministic keyed hash for looking up encrypted values (e.g. e-mail) without decrypting. */
export function blindIndex(key, value) {
  return crypto.createHmac('sha256', key).update(String(value).trim().toLowerCase()).digest('hex')
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function randomDigits(n = 6) {
  let s = ''
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10)
  return s
}

export function signJwt(payload, secret, ttlSec, now = new Date()) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat = Math.floor(now.getTime() / 1000)
  const body = { ...payload, iat, exp: iat + ttlSec }
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${enc(header)}.${enc(body)}`
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')
  return `${unsigned}.${sig}`
}

export function verifyJwt(token, secret, now = new Date()) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  const [h, b, sig] = parts
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    if (header.alg !== 'HS256') return null
    const body = JSON.parse(Buffer.from(b, 'base64url').toString())
    if (typeof body.exp !== 'number' || body.exp <= Math.floor(now.getTime() / 1000)) return null
    return body
  } catch {
    return null
  }
}
