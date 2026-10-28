import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { blindIndex, createCipher, hashPassword, signJwt, verifyJwt, verifyPassword } from '../src/crypto.js'
import { loadConfig } from '../src/config.js'

test('password hashing uses salted scrypt and verifies', () => {
  const h1 = hashPassword('secret-pass')
  const h2 = hashPassword('secret-pass')
  assert.notEqual(h1, h2)
  assert.ok(verifyPassword('secret-pass', h1))
  assert.ok(!verifyPassword('wrong', h1))
})

test('AES-GCM field encryption round-trips and detects tampering', () => {
  const c = createCipher(crypto.randomBytes(32))
  const token = c.encrypt('Иванов Иван')
  assert.ok(!token.includes('Иванов'))
  assert.equal(c.decrypt(token), 'Иванов Иван')
  assert.notEqual(c.encrypt('x'), c.encrypt('x'), 'random IV per value')
  const parts = token.split('.')
  parts[3] = Buffer.from('tampered').toString('base64url')
  assert.throws(() => c.decrypt(parts.join('.')))
  assert.deepEqual(c.decryptJson(c.encryptJson({ a: 1 })), { a: 1 })
  assert.equal(c.encrypt(null), null)
})

test('encrypted blobs fail with a different key', () => {
  const blob = createCipher(crypto.randomBytes(32)).encryptBuffer(Buffer.from('db'))
  assert.throws(() => createCipher(crypto.randomBytes(32)).decryptBuffer(blob))
})

test('blind index is deterministic and case-insensitive', () => {
  const k = crypto.randomBytes(32)
  assert.equal(blindIndex(k, 'A@B.ru '), blindIndex(k, 'a@b.ru'))
  assert.notEqual(blindIndex(k, 'a@b.ru'), blindIndex(crypto.randomBytes(32), 'a@b.ru'))
})

test('JWT signs, verifies, expires and rejects forgery', () => {
  const secret = crypto.randomBytes(32)
  const now = new Date('2026-01-01T00:00:00Z')
  const t = signJwt({ sub: 1 }, secret, 60, now)
  assert.equal(verifyJwt(t, secret, now).sub, 1)
  assert.equal(verifyJwt(t, secret, new Date(now.getTime() + 61_000)), null)
  assert.equal(verifyJwt(t, crypto.randomBytes(32), now), null)
  const [h, , s] = t.split('.')
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 2, exp: 9e9 })).toString('base64url')}.${s}`
  assert.equal(verifyJwt(forged, secret, now), null)
})

test('production config requires secrets and RU data region (152-FZ)', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /HM_ENC_KEY/)
  const keys = { HM_ENC_KEY: crypto.randomBytes(32).toString('hex'), HM_INDEX_KEY: crypto.randomBytes(32).toString('hex'), HM_JWT_SECRET: crypto.randomBytes(32).toString('base64') }
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ...keys, DATA_REGION: 'eu' }), /Russian Federation/)
  assert.equal(loadConfig({ NODE_ENV: 'production', ...keys }).dataRegion, 'ru')
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ...keys, HM_ENC_KEY: 'short' }), /32 bytes/)
})
