/**
 * Versioned schema migration runner
 *
 * Provides a single source of truth for schema evolution. Every migration has a
 * unique, monotonically increasing `id` and is applied exactly once, in order,
 * inside its own transaction. A `schema_migrations` table records what has run.
 *
 * Unlike the previous ad-hoc approach (inline PRAGMA/ALTER blocks in
 * `initializeDatabase()` that swallowed errors into warnings, plus a parallel
 * set of standalone `scripts/migrate-*.js`), a failing migration here aborts
 * startup rather than degrading silently.
 *
 * Migrations are written defensively (they check current schema state before
 * acting) so that databases upgraded under the old scheme — which already have
 * these columns/tables but no `schema_migrations` rows — converge to the exact
 * same schema as a freshly created database.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './config.js';
import { info, error } from './utils/logger.js';

export interface Migration {
  id: number;
  name: string;
  up: (db: any) => void;
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv', '.wmv'];

function columnExists(db: any, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: any, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

/**
 * Ordered list of migrations. NEVER renumber or rewrite an existing migration
 * once it has shipped — add a new one with the next id instead.
 */
export const migrations: Migration[] = [
  {
    id: 1,
    name: 'add_sort_order_to_image_metadata',
    up: (db) => {
      if (!columnExists(db, 'image_metadata', 'sort_order')) {
        db.exec('ALTER TABLE image_metadata ADD COLUMN sort_order INTEGER');
      }
    },
  },
  {
    id: 2,
    name: 'add_media_type_to_image_metadata',
    up: (db) => {
      if (columnExists(db, 'image_metadata', 'media_type')) {
        return;
      }
      db.exec("ALTER TABLE image_metadata ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo'");

      // Backfill: detect existing video records by file extension.
      const records = db
        .prepare('SELECT id, filename FROM image_metadata')
        .all() as Array<{ id: number; filename: string }>;
      const updateStmt = db.prepare('UPDATE image_metadata SET media_type = ? WHERE id = ?');
      let videoCount = 0;
      for (const record of records) {
        const ext = record.filename.substring(record.filename.lastIndexOf('.')).toLowerCase();
        if (VIDEO_EXTENSIONS.includes(ext)) {
          updateStmt.run('video', record.id);
          videoCount++;
        }
      }
      if (videoCount > 0) {
        info(`[Migrations] Backfilled ${videoCount} existing video record(s) to media_type='video'`);
      }
    },
  },
  {
    id: 3,
    name: 'add_sort_order_to_albums',
    up: (db) => {
      if (!columnExists(db, 'albums', 'sort_order')) {
        db.exec('ALTER TABLE albums ADD COLUMN sort_order INTEGER');
      }
    },
  },
  {
    id: 4,
    name: 'add_sort_order_to_album_folders',
    up: (db) => {
      if (!columnExists(db, 'album_folders', 'sort_order')) {
        db.exec('ALTER TABLE album_folders ADD COLUMN sort_order INTEGER');
      }
    },
  },
  {
    id: 5,
    name: 'add_folder_id_to_albums',
    up: (db) => {
      if (!columnExists(db, 'albums', 'folder_id')) {
        db.exec(
          'ALTER TABLE albums ADD COLUMN folder_id INTEGER REFERENCES album_folders(id) ON DELETE SET NULL'
        );
      }
    },
  },
  {
    id: 6,
    name: 'add_description_to_albums',
    up: (db) => {
      if (!columnExists(db, 'albums', 'description')) {
        db.exec('ALTER TABLE albums ADD COLUMN description TEXT');
      }
    },
  },
  {
    id: 7,
    name: 'add_notified_to_share_links',
    up: (db) => {
      if (columnExists(db, 'share_links', 'notified')) {
        return;
      }
      db.exec('ALTER TABLE share_links ADD COLUMN notified INTEGER DEFAULT 0');
      // Mark already-expired links as notified so no spurious notifications fire.
      db.prepare(
        `UPDATE share_links SET notified = 1
         WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`
      ).run();
    },
  },
  {
    id: 8,
    name: 'albums_default_show_on_homepage_off',
    up: (db) => {
      // SQLite can't ALTER a column default, so recreate the table. Idempotent:
      // skip when the default is already 0 (fresh DBs and already-migrated DBs).
      const cols = db.pragma('table_info(albums)') as Array<{
        name: string;
        dflt_value: string | null;
      }>;
      const showOnHomepage = cols.find((c) => c.name === 'show_on_homepage');
      if (!showOnHomepage || showOnHomepage.dflt_value === '0') {
        return;
      }
      db.exec(`
        CREATE TABLE albums_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          published BOOLEAN NOT NULL DEFAULT 0,
          show_on_homepage BOOLEAN NOT NULL DEFAULT 0,
          description TEXT,
          sort_order INTEGER,
          folder_id INTEGER REFERENCES album_folders(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO albums_new
          (id, name, published, show_on_homepage, description, sort_order, folder_id, created_at, updated_at)
        SELECT id, name, published, show_on_homepage, description, sort_order, folder_id, created_at, updated_at
        FROM albums;
        DROP TABLE albums;
        ALTER TABLE albums_new RENAME TO albums;
      `);
    },
  },
  {
    id: 9,
    name: 'share_links_on_update_cascade',
    up: (db) => {
      // Recreate share_links so the album FK has ON UPDATE CASCADE. Idempotent:
      // skip when the constraint is already present.
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='share_links'")
        .get() as { sql: string } | undefined;
      if (!row || row.sql.includes('ON UPDATE CASCADE')) {
        return;
      }
      const hasNotified = columnExists(db, 'share_links', 'notified');
      db.exec(`
        CREATE TABLE share_links_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          album TEXT NOT NULL,
          secret_key TEXT NOT NULL UNIQUE,
          expires_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          notified INTEGER DEFAULT 0,
          FOREIGN KEY (album) REFERENCES albums(name) ON DELETE CASCADE ON UPDATE CASCADE
        );
        INSERT INTO share_links_new (id, album, secret_key, expires_at, created_at, notified)
        SELECT id, album, secret_key, expires_at, created_at, ${hasNotified ? 'notified' : '0'}
        FROM share_links;
        DROP TABLE share_links;
        ALTER TABLE share_links_new RENAME TO share_links;
        CREATE INDEX IF NOT EXISTS idx_share_links_secret ON share_links(secret_key);
        CREATE INDEX IF NOT EXISTS idx_share_links_album ON share_links(album);
      `);
    },
  },
  {
    id: 10,
    name: 'create_push_subscriptions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          user_agent TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)'
      );
    },
  },
  {
    id: 11,
    name: 'import_album_view_milestones',
    up: (db) => {
      // One-time import of legacy .album-milestones.json into album_view_counts.
      const milestoneFile = join(DATA_DIR, '.album-milestones.json');
      if (!existsSync(milestoneFile)) {
        return;
      }
      let data: Record<string, number>;
      try {
        data = JSON.parse(readFileSync(milestoneFile, 'utf8'));
      } catch {
        return;
      }
      const insertStmt = db.prepare(
        `INSERT INTO album_view_counts (album, view_count, last_milestone, updated_at)
         VALUES (?, 0, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(album) DO UPDATE SET
           last_milestone = MAX(last_milestone, excluded.last_milestone)`
      );
      let migrated = 0;
      for (const [albumName, lastMilestone] of Object.entries(data)) {
        insertStmt.run(albumName, lastMilestone);
        migrated++;
      }
      if (migrated > 0) {
        info(`[Migrations] Imported ${migrated} album milestone(s) from .album-milestones.json`);
      }
    },
  },
];

/**
 * Apply all pending migrations in order. Creates the `schema_migrations`
 * tracking table on first run. Each migration runs in its own transaction and
 * is recorded atomically with its effects. Throws on the first failure so the
 * caller (startup) can abort rather than running on a half-migrated schema.
 */
export function runMigrations(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const ordered = [...migrations].sort((a, b) => a.id - b.id);

  // Guard against duplicate ids — a programming error that must fail loudly.
  const seen = new Set<number>();
  for (const m of ordered) {
    if (seen.has(m.id)) {
      throw new Error(`[Migrations] Duplicate migration id ${m.id}`);
    }
    seen.add(m.id);
  }

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(
      (r) => r.id
    )
  );

  const pending = ordered.filter((m) => !applied.has(m.id));
  if (pending.length === 0) {
    info('[Migrations] Schema up to date');
    return;
  }

  // SQLite requires foreign_keys to be toggled OUTSIDE a transaction. Disable it
  // for the duration of the run so table recreations (DROP/RENAME) are safe, then
  // re-enable and verify integrity afterwards.
  db.pragma('foreign_keys = OFF');
  try {
    const record = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');
    for (const migration of pending) {
      info(`[Migrations] Applying ${migration.id} — ${migration.name}`);
      const apply = db.transaction(() => {
        migration.up(db);
        record.run(migration.id, migration.name);
      });
      try {
        apply();
      } catch (err) {
        error(`[Migrations] Migration ${migration.id} (${migration.name}) failed:`, err);
        throw new Error(
          `Migration ${migration.id} (${migration.name}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `[Migrations] foreign_key_check found ${violations.length} violation(s) after migrating`
    );
  }

  info(`[Migrations] Applied ${pending.length} migration(s)`);
}
