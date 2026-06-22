#!/usr/bin/env node

/**
 * Migration: Album Downloads Enabled
 *
 * Adds albums.downloads_enabled so downloads can be disabled per album.
 * Existing albums default to downloads enabled to preserve current behavior.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'gallery.db');

console.log('='.repeat(60));
console.log('Album Downloads Enabled Migration');
console.log('='.repeat(60));

if (!existsSync(DB_PATH)) {
  console.log(`[Migration] Database not found at ${DB_PATH}, nothing to migrate`);
  process.exit(0);
}

try {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const albumsTable = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'albums'
  `).get();

  if (!albumsTable) {
    console.log('[Migration] albums table does not exist, nothing to migrate');
    db.close();
    process.exit(0);
  }

  const tableInfo = db.pragma('table_info(albums)');
  const hasDownloadsEnabled = tableInfo.some(col => col.name === 'downloads_enabled');

  if (hasDownloadsEnabled) {
    console.log('✓ albums.downloads_enabled already exists');
  } else {
    console.log('Adding albums.downloads_enabled...');
    db.exec('ALTER TABLE albums ADD COLUMN downloads_enabled BOOLEAN NOT NULL DEFAULT 1');
    console.log('✓ Added albums.downloads_enabled with default enabled');
  }

  const enabledCount = db.prepare('SELECT COUNT(*) AS count FROM albums WHERE downloads_enabled = 1').get().count;
  const disabledCount = db.prepare('SELECT COUNT(*) AS count FROM albums WHERE downloads_enabled = 0').get().count;

  db.close();

  console.log('\nAlbum download settings:');
  console.log(`  Enabled: ${enabledCount}`);
  console.log(`  Disabled: ${disabledCount}`);
  console.log('\nMigration completed successfully!');
  process.exit(0);
} catch (err) {
  console.error('\nMigration failed:', err);
  process.exit(1);
}
