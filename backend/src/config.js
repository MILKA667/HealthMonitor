import crypto from 'node:crypto'

const DEV_SECRET = 'healthmonitor-dev-only-secret-do-not-use-in-production'

function keyFrom(value, label) {
  if (!value) return crypto.createHash('sha256').update(`${DEV_SECRET}:${label}`).digest()
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (buf.length !== 32) throw new Error(`${label} must be 32 bytes (hex or base64)`)
  return buf
}

/**
 * Loads configuration from the environment. In production all secrets are mandatory and
 * the data region must be RU (152-FZ, part 5 of art. 18: primary processing on RF servers).
 */
export function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || 'development'
  const config = {
    env: nodeEnv,
    port: Number(env.PORT || 4000),
    dbFile: env.HM_DB_FILE || 'data/healthmonitor.db',
    backupDir: env.HM_BACKUP_DIR || 'backups',
    dataRegion: env.DATA_REGION || 'ru',
    timezone: env.HM_TIMEZONE || 'Europe/Moscow',
    corsOrigin: env.HM_CORS_ORIGIN || 'http://localhost:5173',
    trustProxy: env.HM_TRUST_PROXY === '1',
    encKey: keyFrom(env.HM_ENC_KEY, 'HM_ENC_KEY'),
    indexKey: keyFrom(env.HM_INDEX_KEY, 'HM_INDEX_KEY'),
    jwtSecret: keyFrom(env.HM_JWT_SECRET, 'HM_JWT_SECRET'),
    tokenTtlSec: Number(env.HM_TOKEN_TTL_SEC || 3600),
    otpTtlSec: 300,
    escalationMinutes: Number(env.HM_ESCALATION_MINUTES || 15),
    schedulerIntervalMs: Number(env.HM_SCHEDULER_MS || 60_000),
    smsProvider: env.HM_SMS_PROVIDER || 'outbox',
    smsGatewayUrl: env.HM_SMS_GATEWAY_URL || '',
    pushProvider: env.HM_PUSH_PROVIDER || 'outbox',
    staticDir: env.HM_STATIC_DIR || '',
    dailyBackup: env.HM_BACKUP_DAILY === '1',
    exposeDevCodes: nodeEnv !== 'production' && env.HM_EXPOSE_DEV_CODES !== '0',
    now: () => new Date(),
    ...overrides,
  }
  if (config.env === 'production') {
    for (const k of ['HM_ENC_KEY', 'HM_INDEX_KEY', 'HM_JWT_SECRET']) {
      if (!env[k]) throw new Error(`${k} is required in production`)
    }
    if (config.dataRegion !== 'ru') {
      throw new Error('DATA_REGION must be "ru": personal data may only be processed on servers in the Russian Federation')
    }
    if (config.smsGatewayUrl && !/^https:\/\//.test(config.smsGatewayUrl)) {
      throw new Error('HM_SMS_GATEWAY_URL must use https')
    }
  }
  return config
}
