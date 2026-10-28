import { loadConfig } from './config.js'
import { createApp, createContext } from './app.js'
import { startScheduler } from './services/scheduler.js'
import { createUser, findUserByEmail } from './services/users.js'

const config = loadConfig()
if (config.env !== 'production') console.warn('[healthmonitor] development mode: built-in dev keys are used; never use this mode with real patient data')

const ctx = createContext({ config })

// Bootstrap the first administrator from the environment (idempotent).
if (process.env.HM_ADMIN_EMAIL && process.env.HM_ADMIN_PASSWORD && !findUserByEmail(ctx, process.env.HM_ADMIN_EMAIL)) {
  createUser(ctx, { role: 'admin', email: process.env.HM_ADMIN_EMAIL, password: process.env.HM_ADMIN_PASSWORD, fullName: process.env.HM_ADMIN_NAME || 'Администратор', phone: process.env.HM_ADMIN_PHONE || null })
  console.log(`[healthmonitor] administrator ${process.env.HM_ADMIN_EMAIL} created`)
}

const app = createApp(ctx)
const stopScheduler = startScheduler(ctx)
const server = app.listen(config.port, () => console.log(`[healthmonitor] API listening on :${config.port} (data region: ${config.dataRegion})`))

function shutdown() {
  stopScheduler()
  server.close(() => {
    ctx.db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
