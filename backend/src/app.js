import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { createCipher } from './crypto.js'
import { HttpError } from './errors.js'
import { openDb, schemaVersion } from './db.js'
import { loadConfig } from './config.js'
import { authenticate } from './middleware/auth.js'
import { ensureConsentDocuments } from './services/consents.js'
import { authRouter } from './routes/auth.js'
import { patientsRouter } from './routes/patients.js'
import { alertsRouter, doctorRouter } from './routes/alerts.js'
import { miscRouter } from './routes/misc.js'
import { devicesRouter, integrationsRouter } from './routes/devices.js'
import { chatRouter } from './routes/chat.js'
import { remindersRouter } from './routes/reminders.js'
import { reportsRouter } from './routes/reports.js'
import { adminRouter } from './routes/admin.js'
import { relativeRouter } from './routes/relative.js'
import { consentsRouter } from './routes/consents.js'

/** Builds the application context shared by routes, services and the scheduler. */
export function createContext({ config = loadConfig(), db } = {}) {
  const ctx = {
    config,
    db: db ?? openDb(config.dbFile),
    cipher: createCipher(config.encKey),
    now: () => config.now(),
  }
  ensureConsentDocuments(ctx)
  return ctx
}

function securityHeaders(ctx) {
  return (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    if (req.path.startsWith('/api')) {
      res.set({ 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Cache-Control': 'no-store' })
    } else {
      res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    }
    if (ctx.config.env === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    const origin = req.get('origin')
    if (origin && ctx.config.corsOrigin.split(',').includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        Vary: 'Origin',
      })
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }
}

/** Rejects plain HTTP in production (encryption in transit, KAN-47); TLS terminates at the reverse proxy. */
function requireHttps(ctx) {
  return (req, _res, next) => {
    if (ctx.config.env === 'production' && !req.secure && req.path !== '/api/health') {
      return next(new HttpError(403, 'HTTPS_REQUIRED', 'Требуется HTTPS'))
    }
    next()
  }
}

export function createApp(ctx) {
  const app = express()
  app.disable('x-powered-by')
  if (ctx.config.trustProxy) app.set('trust proxy', 1)
  app.use(securityHeaders(ctx))
  app.use(requireHttps(ctx))
  app.use(express.json({ limit: '256kb' }))
  app.use(authenticate(ctx))

  app.get('/api/health', (_req, res) => {
    ctx.db.prepare('SELECT 1').get()
    res.json({ status: 'ok', schemaVersion, dataRegion: ctx.config.dataRegion, time: ctx.now().toISOString() })
  })

  app.use('/api/auth', authRouter(ctx))
  app.use('/api/consents', consentsRouter(ctx))
  app.use('/api/patients', patientsRouter(ctx))
  app.use('/api/alerts', alertsRouter(ctx))
  app.use('/api/doctor', doctorRouter(ctx))
  app.use('/api/devices', devicesRouter(ctx))
  app.use('/api/integrations', integrationsRouter(ctx))
  app.use('/api/chat', chatRouter(ctx))
  app.use('/api/reminders', remindersRouter(ctx))
  app.use('/api/reports', reportsRouter(ctx))
  app.use('/api/admin', adminRouter(ctx))
  app.use('/api/relative', relativeRouter(ctx))
  app.use('/api', miscRouter(ctx))

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')))

  // Production: the built web client is served by the same process (single container behind TLS proxy).
  if (ctx.config.staticDir && fs.existsSync(path.join(ctx.config.staticDir, 'index.html'))) {
    const dir = path.resolve(ctx.config.staticDir)
    app.use(express.static(dir, { index: false, maxAge: '1h' }))
    app.get(/^\/(?!api\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(dir, 'index.html')))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Некорректный JSON' } })
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Слишком большой запрос' } })
    }
    if (ctx.config.env !== 'test') console.error(`[${req.method} ${req.path}]`, err)
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } })
  })
  return app
}
