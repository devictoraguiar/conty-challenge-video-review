import { DatabaseSync } from 'node:sqlite';

export function createDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaign_required_pieces (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        kind TEXT NOT NULL CHECK (kind IN ('script', 'video', 'cover', 'caption')),
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (campaign_id, kind),
        UNIQUE (campaign_id, position)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        creator_id TEXT NOT NULL CHECK (length(trim(creator_id)) > 0),
        status TEXT NOT NULL DEFAULT 'in_production' CHECK (status IN ('in_production', 'approved')),
        approved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'approved' AND approved_at IS NOT NULL)
          OR (status = 'in_production' AND approved_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS deliveries_campaign ON deliveries(campaign_id);
      CREATE TABLE IF NOT EXISTS piece_versions (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id),
        kind TEXT NOT NULL CHECK (kind IN ('script', 'video', 'cover', 'caption')),
        number INTEGER NOT NULL CHECK (number > 0),
        content TEXT NOT NULL CHECK (length(trim(content)) > 0),
        status TEXT NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review', 'approved')),
        approved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (delivery_id, kind, number),
        CHECK ((status = 'approved' AND approved_at IS NOT NULL)
          OR (status = 'in_review' AND approved_at IS NULL))
      );
      CREATE TABLE IF NOT EXISTS video_comments (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES piece_versions(id),
        second REAL NOT NULL CHECK (second >= 0),
        text TEXT NOT NULL CHECK (length(trim(text)) > 0),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS video_comments_version ON video_comments(version_id);
      COMMIT;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Callbacks are synchronous: no request-body reads or awaits may hold this lock.
export function transaction<T>(db: DatabaseSync, work: () => T, mode: 'read' | 'write' = 'write'): T {
  db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite may already have rolled back; cleanup must not mask the original error.
    try { db.exec('ROLLBACK'); } catch { /* Transaction already ended. */ }
    throw error;
  }
}
