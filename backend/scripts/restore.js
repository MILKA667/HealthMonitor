/**
 * Restores an encrypted backup into HM_DB_FILE. STOP THE API FIRST.
 * The current database is not deleted: it is renamed to <db>.before-restore-<timestamp>.
 *
 *   node scripts/restore.js backups/healthmonitor-....hmbak --yes
 */
import { loadConfig } from '../src/config.js'
import { createCipher } from '../src/crypto.js'
import { restoreBackup, verifyBackup } from '../src/services/backup.js'

const [file, flag] = process.argv.slice(2)
if (!file) {
  console.error('usage: restore.js <backup file> [--yes]')
  process.exit(1)
}
const config = loadConfig()
const cipher = createCipher(config.encKey)
const check = verifyBackup(cipher, file)
console.log('backup verification:', JSON.stringify(check))
if (flag !== '--yes') {
  console.log(`dry run: re-run with --yes to restore into ${config.dbFile} (the API must be stopped)`)
  process.exit(check.ok ? 0 : 1)
}
const r = restoreBackup(cipher, file, config.dbFile)
console.log(`restored into ${r.target}${r.keptAs ? `; previous database kept as ${r.keptAs}` : ''}`)
