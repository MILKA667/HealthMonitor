import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Schema migrations. Personal and medical data columns ending with `_enc` hold AES-GCM ciphertext;
 * `*_idx` columns hold keyed blind indexes used for lookups. Append new migrations, never edit old ones.
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('patient','doctor','relative','admin')),
    email_idx TEXT NOT NULL UNIQUE,
    email_enc TEXT NOT NULL,
    phone_enc TEXT,
    full_name_enc TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','blocked','rejected')),
    twofa_enabled INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    login_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX users_role ON users(role, status);

  CREATE TABLE patient_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    conditions TEXT NOT NULL DEFAULT '[]',
    doctor_id INTEGER REFERENCES users(id),
    birth_date_enc TEXT,
    notes_enc TEXT,
    peak_flow_best INTEGER
  );
  CREATE INDEX patient_doctor ON patient_profiles(doctor_id);

  CREATE TABLE doctor_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    specialty TEXT,
    license_enc TEXT
  );

  CREATE TABLE relatives (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    name_enc TEXT NOT NULL,
    phone_enc TEXT NOT NULL,
    relation TEXT,
    notify_emergency INTEGER NOT NULL DEFAULT 1,
    user_id INTEGER REFERENCES users(id),
    invite_code_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX relatives_patient ON relatives(patient_id);
  CREATE INDEX relatives_user ON relatives(user_id);

  CREATE TABLE requests (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('doctor_registration','doctor_assignment')),
    user_id INTEGER NOT NULL REFERENCES users(id),
    target_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    comment TEXT,
    reviewed_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE INDEX requests_status ON requests(status, type);

  CREATE TABLE consent_documents (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('personal_data','health_data','user_agreement')),
    version TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    published_at TEXT NOT NULL,
    UNIQUE (type, version)
  );

  CREATE TABLE consents (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    document_id INTEGER NOT NULL REFERENCES consent_documents(id),
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    ip TEXT
  );
  CREATE INDEX consents_user ON consents(user_id);

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('glucometer','tonometer')),
    adapter TEXT NOT NULL,
    model TEXT NOT NULL,
    serial TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    linked_at TEXT NOT NULL,
    last_sync_at TEXT
  );
  CREATE UNIQUE INDEX devices_active_serial ON devices(adapter, serial) WHERE active = 1;

  CREATE TABLE measurements (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('glucose','blood_pressure','peak_flow')),
    value_enc TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','device')),
    device_id INTEGER REFERENCES devices(id),
    severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','warning','critical')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX measurements_patient ON measurements(patient_id, type, measured_at);
  CREATE UNIQUE INDEX measurements_device_dedupe ON measurements(device_id, type, measured_at) WHERE device_id IS NOT NULL;

  CREATE TABLE thresholds (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    metric TEXT NOT NULL,
    crit_low REAL, warn_low REAL, warn_high REAL, crit_high REAL,
    set_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL,
    UNIQUE (patient_id, metric)
  );

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    measurement_id INTEGER REFERENCES measurements(id),
    severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
    kind TEXT NOT NULL DEFAULT 'threshold',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
    escalation_level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    escalated_at TEXT,
    acknowledged_at TEXT,
    acknowledged_by INTEGER REFERENCES users(id),
    resolution_note TEXT,
    resolved_at TEXT
  );
  CREATE INDEX alerts_patient ON alerts(patient_id, status);
  CREATE INDEX alerts_status ON alerts(status, severity, created_at);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    channel TEXT NOT NULL CHECK (channel IN ('push','sms')),
    recipient_enc TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    alert_id INTEGER REFERENCES alerts(id),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, channel, created_at);
  CREATE INDEX notifications_status ON notifications(status);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    body_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX messages_patient ON messages(patient_id, created_at);

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('medication','measurement')),
    title TEXT NOT NULL,
    time_of_day TEXT NOT NULL,
    days TEXT NOT NULL DEFAULT '1234567',
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_on TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX reminders_patient ON reminders(patient_id);

  CREATE TABLE otp_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    purpose TEXT NOT NULL CHECK (purpose IN ('login','reset')),
    challenge TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    role TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    ip TEXT,
    details TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX audit_at ON audit_log(at);
  CREATE INDEX audit_user ON audit_log(user_id, at);

  CREATE TABLE data_access_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    patient_id INTEGER NOT NULL,
    resource TEXT NOT NULL,
    ip TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX access_patient ON data_access_log(patient_id, at);

  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );
  `,
]

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version))
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1
    if (done.has(version)) return
    transaction(db, () => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString())
    })
  })
}

export function transaction(db, fn) {
  if (db.isTransaction) return fn()
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const schemaVersion = MIGRATIONS.length
