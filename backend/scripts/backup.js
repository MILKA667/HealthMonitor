/** Creates an encrypted, verified backup of the database into HM_BACKUP_DIR. Safe to run while the API is up. */
import { loadConfig } from '../src/config.js'
import { createContext } from '../src/app.js'
import { createBackup, verifyBackup } from '../src/services/backup.js'

const ctx = createContext({ config: loadConfig() })
const b = createBackup(ctx)
const v = verifyBackup(ctx.cipher, b.file)
console.log(JSON.stringify({ file: b.file, size: b.size, sha256: b.sha256, verification: v }, null, 2))
ctx.db.close()
process.exit(v.ok ? 0 : 1)
