#!/usr/bin/env node

/**
 * Migration: Add MFA attempts table
 *
 * Creates the MFA attempt log used for MFA rate limiting.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'gallery.db');

console.log('[Migration] Opening database:', DB_PATH);
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

try {
  console.log('[Migration] Creating mfa_attempts table if needed...');

  db.exec(`
    CREATE TABLE IF NOT EXISTS mfa_attempts (
      user_id INTEGER,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      success INTEGER,
      ip_address TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mfa_attempts_user_attempted_at
    ON mfa_attempts(user_id, attempted_at)
  `);

  console.log('[Migration] MFA attempts table and index are ready');
  process.exit(0);
} catch (err) {
  console.error('[Migration] Migration failed:', err);
  process.exit(1);
} finally {
  db.close();
}
