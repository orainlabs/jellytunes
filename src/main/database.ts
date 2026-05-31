/**
 * SQLite database module for JellyTunes
 *
 * Tracks sync history and synced files per device.
 * Used for smart sync (show what's new vs. already synced) and history view.
 */

import { app } from 'electron';
import Database from 'better-sqlite3';
import path from 'path';
import log from 'electron-log';

let db: Database.Database | null = null;

export interface SyncHistoryEntry {
  id: number;
  deviceMountPoint: string;
  startedAt: string;
  completedAt: string | null;
  tracksSynced: number;
  bytesTransferred: number;
  status: 'success' | 'error' | 'cancelled';
}

export interface DeviceSyncInfo {
  lastSync: string | null;
  totalTracks: number;
  totalBytes: number;
  syncCount: number;
}

export interface SyncedItemInfo {
  id: string;
  name: string;
  type: 'artist' | 'album' | 'albumArtist' | 'playlist';
}

// ---------------------------------------------------------------------------
// SyncedTrackRecord — track-level sync tracking (Phase 1)
// ---------------------------------------------------------------------------

export interface SyncedTrackRecord {
  id: number;
  deviceId: number;
  itemId: string;
  trackId: string;
  destinationPath: string;
  fileSize: number | null;
  metadataHash: string | null;
  coverArtMode: string;
  /** Lyrics mode at time of sync ('lrc', 'embed', or 'off') */
  lyricsMode: string;
  encodedBitrate: string | null;
  serverPath: string | null;
  serverRootPath: string | null;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDatabase(): void {
  if (db) return;

  const dbPath = path.join(app.getPath('userData'), 'jellytunes.db');
  log.info(`Database: ${dbPath}`);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mount_point TEXT UNIQUE NOT NULL,
      name        TEXT,
      last_sync_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_history (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id         INTEGER NOT NULL,
      started_at        TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at      TEXT,
      tracks_synced     INTEGER NOT NULL DEFAULT 0,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS synced_files (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id        INTEGER NOT NULL,
      item_id          TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      file_size        INTEGER,
      synced_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, item_id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS synced_tracks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id       INTEGER NOT NULL,
      item_id         TEXT NOT NULL,
      track_id        TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      file_size       INTEGER,
      metadata_hash   TEXT,
      cover_art_mode  TEXT NOT NULL DEFAULT 'embed',
      encoded_bitrate TEXT,
      server_path     TEXT,
      server_root_path TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, track_id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );
    CREATE INDEX IF NOT EXISTS idx_synced_tracks_device_item ON synced_tracks(device_id, item_id);
  `);

  // Index for device-based queries on sync_history (avoids full table scan as history grows)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_history_device ON sync_history(device_id)');

  // Migrations: add columns if they don't exist (SQLite has no IF NOT EXISTS for ALTER TABLE)
  if (!columnExists(db, 'synced_files', 'item_name')) {
    db.exec('ALTER TABLE synced_files ADD COLUMN item_name TEXT');
  }
  if (!columnExists(db, 'synced_files', 'item_type')) {
    db.exec('ALTER TABLE synced_files ADD COLUMN item_type TEXT');
  }

  // Migration: add server_root_path column if it doesn't exist (for stable path comparison)
  if (!columnExists(db, 'synced_tracks', 'server_root_path')) {
    db.exec('ALTER TABLE synced_tracks ADD COLUMN server_root_path TEXT');
  }

  // Migration: set cover_art_mode = 'embed' for existing records (Phase 1 bug fix)
  try {
    db.exec("UPDATE synced_tracks SET cover_art_mode = 'embed' WHERE cover_art_mode = 'off'");
  } catch {
    /* ignore */
  }

  // Migration: add lyrics_mode column for tracking lyrics sync mode per track
  if (!columnExists(db, 'synced_tracks', 'lyrics_mode')) {
    db.exec("ALTER TABLE synced_tracks ADD COLUMN lyrics_mode TEXT NOT NULL DEFAULT 'off'");
  }

  log.info('Database ready');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a column exists in a given SQLite table using PRAGMA table_info.
 * Safer than try/catch around ALTER TABLE because it distinguishes "column missing"
 * from actual error conditions (disk full, corrupt schema, FK violations, etc.).
 */
export function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function requireDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function upsertDevice(mountPoint: string, name?: string): number {
  const database = requireDb();
  const existing = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;

  if (existing) {
    database
      .prepare(
        "UPDATE devices SET last_sync_at = datetime('now'), name = COALESCE(?, name) WHERE id = ?",
      )
      .run(name ?? null, existing.id);
    return existing.id;
  }

  const result = database
    .prepare('INSERT INTO devices (mount_point, name) VALUES (?, ?)')
    .run(mountPoint, name ?? mountPoint);
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Sync history
// ---------------------------------------------------------------------------

export function recordSyncCompleted(
  mountPoint: string,
  tracksSynced: number,
  bytesTransferred: number,
  status: 'success' | 'error' | 'cancelled',
  items: SyncedItemInfo[],
): void {
  const database = requireDb();
  const deviceId = upsertDevice(mountPoint);

  // Record aggregate history
  database
    .prepare(
      `
      INSERT INTO sync_history (device_id, completed_at, tracks_synced, bytes_transferred, status)
      VALUES (?, datetime('now'), ?, ?, ?)
    `,
    )
    .run(deviceId, tracksSynced, bytesTransferred, status);

  // Record individual synced files (upsert so we update synced_at and name/type on re-sync)
  if (items.length > 0 && status !== 'error') {
    const stmt = database.prepare(`
      INSERT INTO synced_files (device_id, item_id, destination_path, item_name, item_type, synced_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(device_id, item_id) DO UPDATE SET
        synced_at = excluded.synced_at,
        item_name = excluded.item_name,
        item_type = excluded.item_type
    `);
    const insertMany = database.transaction((infos: SyncedItemInfo[]) => {
      for (const info of infos) stmt.run(deviceId, info.id, mountPoint, info.name, info.type);
    });
    insertMany(items);
  }
}

export function getSyncedItemIds(mountPoint: string): Set<string> {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return new Set();

  const rows = database
    .prepare('SELECT item_id FROM synced_files WHERE device_id = ?')
    .all(device.id) as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id));
}

export function getSyncedItems(mountPoint: string): SyncedItemInfo[] {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return [];

  const rows = database
    .prepare('SELECT item_id, item_name, item_type FROM synced_files WHERE device_id = ?')
    .all(device.id) as { item_id: string; item_name: string | null; item_type: string | null }[];
  return rows.map((r) => ({
    id: r.item_id,
    name: r.item_name ?? r.item_id,
    type: (r.item_type ?? 'artist') as 'artist' | 'album' | 'albumArtist' | 'playlist',
  }));
}

export function getDeviceSyncInfo(mountPoint: string): DeviceSyncInfo {
  const database = requireDb();
  const device = database
    .prepare('SELECT id, last_sync_at FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number; last_sync_at: string } | undefined;

  if (!device) return { lastSync: null, totalTracks: 0, totalBytes: 0, syncCount: 0 };

  const stats = database
    .prepare(
      `
      SELECT
        COUNT(*)          AS sync_count,
        SUM(tracks_synced)     AS total_tracks,
        SUM(bytes_transferred) AS total_bytes
      FROM sync_history
      WHERE device_id = ? AND status = 'success'
    `,
    )
    .get(device.id) as { sync_count: number; total_tracks: number; total_bytes: number };

  return {
    lastSync: device.last_sync_at,
    totalTracks: stats?.total_tracks ?? 0,
    totalBytes: stats?.total_bytes ?? 0,
    syncCount: stats?.sync_count ?? 0,
  };
}

export function getRecentSyncHistory(limit = 10): SyncHistoryEntry[] {
  const database = requireDb();
  return database
    .prepare(
      `
      SELECT
        sh.id,
        d.mount_point AS deviceMountPoint,
        sh.started_at AS startedAt,
        sh.completed_at AS completedAt,
        sh.tracks_synced AS tracksSynced,
        sh.bytes_transferred AS bytesTransferred,
        sh.status
      FROM sync_history sh
      JOIN devices d ON d.id = sh.device_id
      ORDER BY sh.started_at DESC
      LIMIT ?
    `,
    )
    .all(limit) as SyncHistoryEntry[];
}

export function removeSyncedItems(mountPoint: string, itemIds: string[]): void {
  if (itemIds.length === 0) return;
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return;

  const stmtFiles = database.prepare(
    'DELETE FROM synced_files WHERE device_id = ? AND item_id = ?',
  );
  const stmtTracks = database.prepare(
    'DELETE FROM synced_tracks WHERE device_id = ? AND item_id = ?',
  );
  const deleteMany = database.transaction((ids: string[]) => {
    for (const id of ids) {
      stmtFiles.run(device.id, id);
      stmtTracks.run(device.id, id);
    }
  });
  deleteMany(itemIds);
}

export function clearDestinationRecords(mountPoint: string): void {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return;
  database.transaction(() => {
    database.prepare('DELETE FROM synced_files WHERE device_id = ?').run(device.id);
    database.prepare('DELETE FROM synced_tracks WHERE device_id = ?').run(device.id);
    database.prepare('DELETE FROM sync_history WHERE device_id = ?').run(device.id);
    database.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
  })();
}

// ---------------------------------------------------------------------------
// SyncedTracks — track-level sync tracking (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Upsert a synced track record.
 * Updates existing record if (device_id, track_id) conflict.
 */
export function upsertSyncedTrack(
  mountPoint: string,
  itemId: string,
  trackId: string,
  destPath: string,
  fileSize: number | null,
  metadataHash: string | null,
  coverArtMode: string,
  encodedBitrate: string | null,
  serverPath: string | null,
  serverRootPath: string | null,
  lyricsMode: string = 'off',
): void {
  const database = requireDb();
  // Auto-register device if not yet in DB — must exist before we can insert tracks
  const deviceId = upsertDevice(mountPoint);

  database
    .prepare(
      `
      INSERT INTO synced_tracks (device_id, item_id, track_id, destination_path, file_size, metadata_hash, cover_art_mode, encoded_bitrate, server_path, server_root_path, lyrics_mode, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(device_id, track_id) DO UPDATE SET
        destination_path = excluded.destination_path,
        file_size = excluded.file_size,
        metadata_hash = excluded.metadata_hash,
        cover_art_mode = excluded.cover_art_mode,
        encoded_bitrate = excluded.encoded_bitrate,
        server_path = excluded.server_path,
        server_root_path = excluded.server_root_path,
        lyrics_mode = excluded.lyrics_mode,
        synced_at = datetime('now')
    `,
    )
    .run(
      deviceId,
      itemId,
      trackId,
      destPath,
      fileSize,
      metadataHash,
      coverArtMode,
      encodedBitrate,
      serverPath,
      serverRootPath,
      lyricsMode,
    );
}

/**
 * Get all synced track records for a device.
 */
export function getSyncedTracksForDevice(mountPoint: string): SyncedTrackRecord[] {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return [];

  const rows = database
    .prepare(
      `
      SELECT id, device_id AS deviceId, item_id AS itemId, track_id AS trackId,
             destination_path AS destinationPath, file_size AS fileSize,
             metadata_hash AS metadataHash, cover_art_mode AS coverArtMode,
             lyrics_mode AS lyricsMode,
             encoded_bitrate AS encodedBitrate, server_path AS serverPath,
             server_root_path AS serverRootPath, synced_at AS syncedAt
      FROM synced_tracks
      WHERE device_id = ?
    `,
    )
    .all(device.id) as SyncedTrackRecord[];
  return rows;
}

/**
 * Get synced track records for a specific item on a device.
 */
export function getSyncedTracksForItem(mountPoint: string, itemId: string): SyncedTrackRecord[] {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return [];

  return database
    .prepare(
      `
      SELECT id, device_id AS deviceId, item_id AS itemId, track_id AS trackId,
             destination_path AS destinationPath, file_size AS fileSize,
             metadata_hash AS metadataHash, cover_art_mode AS coverArtMode,
             lyrics_mode AS lyricsMode,
             encoded_bitrate AS encodedBitrate, server_path AS serverPath,
             server_root_path AS serverRootPath, synced_at AS syncedAt
      FROM synced_tracks
      WHERE device_id = ? AND item_id = ?
    `,
    )
    .all(device.id, itemId) as SyncedTrackRecord[];
}

/**
 * Remove all synced track records for an item on a device.
 */
export function removeSyncedTracksForItem(mountPoint: string, itemId: string): void {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return;

  database
    .prepare('DELETE FROM synced_tracks WHERE device_id = ? AND item_id = ?')
    .run(device.id, itemId);
}

/**
 * Remove a single synced track record.
 */
export function removeSyncedTrack(mountPoint: string, trackId: string): void {
  const database = requireDb();
  const device = database
    .prepare('SELECT id FROM devices WHERE mount_point = ?')
    .get(mountPoint) as { id: number } | undefined;
  if (!device) return;

  database
    .prepare('DELETE FROM synced_tracks WHERE device_id = ? AND track_id = ?')
    .run(device.id, trackId);
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}
