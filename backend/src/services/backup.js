/**
 * Backup and restore (KAN-50). A backup is a consistent SQLite snapshot (VACUUM INTO) encrypted
 * with AES-256-GCM (the snapshot contains already field-encrypted data plus metadata). Backups must
 * be stored on servers in the RF, like the primary database.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function createBackup(ctx, { userId = null } = {}) {
  const dir = path.resolve(ctx.config.backupDir)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-')
  const tmp = path.join(os.tmpdir(), `hm-snapshot-${process.pid}-${Date.now()}.db`)
  try {
    ctx.db.prepare('VACUUM INTO ?').run(tmp)
    const plain = fs.readFileSync(tmp)
    const blob = ctx.cipher.encryptBuffer(plain)
    const file = path.join(dir, `healthmonitor-${stamp}.hmbak`)
    fs.writeFileSync(file, blob, { mode: 0o600 })
    const sha = crypto.createHash('sha256').update(blob).digest('hex')
    ctx.db.prepare('INSERT INTO backups (file, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(path.basename(file), blob.length, sha, userId, ctx.now().toISOString())
    return { file, name: path.basename(file), size: blob.length, sha256: sha }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Verifies that a backup decrypts and contains a valid database. Returns basic table counts. */
export function verifyBackup(cipher, file) {
  const plain = cipher.decryptBuffer(fs.readFileSync(file))
  const tmp = path.join(os.tmpdir(), `hm-verify-${process.pid}-${Date.now()}.db`)
  fs.writeFileSync(tmp, plain)
  try {
    const db = new DatabaseSync(tmp, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const counts = {}
    for (const t of ['users', 'measurements', 'alerts', 'messages']) counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    db.close()
    return { ok: Object.values(integrity)[0] === 'ok', counts }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * Restores a backup into `targetFile`. The server must be stopped. An existing target is kept
 * as `<target>.before-restore-<timestamp>` so the operation can be undone.
 */
export function restoreBackup(cipher, backupFile, targetFile) {
  const check = verifyBackup(cipher, backupFile)
  if (!check.ok) throw new Error('Backup integrity check failed')
  const target = path.resolve(targetFile)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let keptAs = null
  if (fs.existsSync(target)) {
    keptAs = `${target}.before-restore-${Date.now()}`
    fs.renameSync(target, keptAs)
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(target + ext)) fs.renameSync(target + ext, keptAs + ext)
  }
  fs.writeFileSync(target, cipher.decryptBuffer(fs.readFileSync(backupFile)), { mode: 0o600 })
  return { target, keptAs, counts: check.counts }
}
