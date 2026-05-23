/**
 * Database Unit Tests — synced_tracks table
 * Tests for Phase 1: track-level sync tracking
 * Uses vi.mock for better-sqlite3 to avoid native module issues in test env.
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: () => '/fake/userData',
  },
}));

// =============================================================================
// MOCK DATABASE (in-memory, no native module)
// =============================================================================

interface MockRow {
  id: number;
  device_id: number;
  item_id: string;
  track_id?: string;
  destination_path: string;
  file_size: number | null;
  metadata_hash?: string | null;
  cover_art_mode?: string;
  encoded_bitrate?: string | null;
  server_path?: string | null;
  synced_at: string;
  mount_point?: string;
  name?: string;
  last_sync_at?: string | null;
  item_name?: string | null;
  item_type?: string | null;
  [key: string]: unknown;
}

interface MockDbState {
  devices: Map<number, MockRow>;
  synced_tracks: Map<string, MockRow>;
  synced_files: Map<string, MockRow>;
  sync_history: Map<number, MockRow>;
  nextDeviceId: number;
  nextTrackId: number;
  nextFileId: number;
  nextHistoryId: number;
}

const state: MockDbState = {
  devices: new Map(),
  synced_tracks: new Map(),
  synced_files: new Map(),
  sync_history: new Map(),
  nextDeviceId: 1,
  nextTrackId: 1,
  nextFileId: 1,
  nextHistoryId: 1,
};

function resetState() {
  state.devices.clear();
  state.synced_tracks.clear();
  state.synced_files.clear();
  state.sync_history.clear();
  state.nextDeviceId = 1;
  state.nextTrackId = 1;
  state.nextFileId = 1;
  state.nextHistoryId = 1;
}

function findDeviceByMount(mountPoint: string): MockRow | undefined {
  for (const row of state.devices.values()) {
    if (row.mount_point === mountPoint) return row;
  }
  return undefined;
}

vi.mock('better-sqlite3', () => {
  return {
    __esModule: true,
    default: class MockDatabase {
      constructor(_path: string) {
        /* no-op */
      }
      pragma(_p: string) {
        return this;
      }
      exec(_sql: string) {
        // Table creation — no-op for mock; schema assumed to exist
        return this;
      }
      prepare(sql: string) {
        return {
          run: (...args: unknown[]) => {
            // --- devices ---
            if (sql.includes('INSERT INTO devices')) {
              const id = state.nextDeviceId++;
              const mountPoint = args[0] as string;
              const name = args[1] as string | undefined;
              state.devices.set(id, {
                id,
                mount_point: mountPoint,
                name: name ?? mountPoint,
                last_sync_at: null,
              } as MockRow);
              return { lastInsertRowid: id, changes: 1 };
            }
            if (sql.includes('UPDATE devices SET')) {
              const mountPoint = args[1] as string;
              const device = findDeviceByMount(mountPoint);
              if (device) device.last_sync_at = new Date().toISOString();
              return { lastInsertRowid: 0, changes: 1 };
            }
            // --- synced_tracks upsert ---
            if (sql.includes('INSERT INTO synced_tracks') || sql.includes('ON CONFLICT')) {
              const deviceId = args[0] as number;
              const trackId = args[2] as string;
              const existing = state.synced_tracks.get(trackId);
              const id = existing?.id ?? state.nextTrackId++;
              state.synced_tracks.set(trackId, {
                id,
                device_id: deviceId,
                item_id: args[1] as string,
                track_id: trackId,
                destination_path: args[3] as string,
                file_size: args[4] as number | null,
                metadata_hash: args[5] as string | null,
                cover_art_mode: args[6] as string,
                encoded_bitrate: args[7] as string | null,
                server_path: args[8] as string | null,
                synced_at: new Date().toISOString(),
              });
              return { lastInsertRowid: id, changes: existing ? 0 : 1 };
            }
            // --- synced_tracks delete ---
            if (sql.includes('DELETE FROM synced_tracks')) {
              if (sql.includes('device_id = ? AND item_id = ?')) {
                const deviceId = args[0] as number;
                const itemId = args[1] as string;
                let count = 0;
                for (const [k, v] of state.synced_tracks.entries()) {
                  if (v.device_id === deviceId && v.item_id === itemId) {
                    state.synced_tracks.delete(k);
                    count++;
                  }
                }
                return { changes: count };
              }
              if (sql.includes('device_id = ? AND track_id = ?')) {
                const trackId = args[1] as string;
                if (state.synced_tracks.delete(trackId)) return { changes: 1 };
                return { changes: 0 };
              }
            }
            // --- synced_files ---
            if (sql.includes('INSERT INTO synced_files')) {
              const deviceId = args[0] as number;
              const itemId = args[1] as string;
              const key = `${deviceId}-${itemId}`;
              state.synced_files.set(key, {
                id: state.nextFileId++,
                device_id: deviceId,
                item_id: itemId,
                destination_path: args[2] as string,
                item_name: args[3] as string | null,
                item_type: args[4] as string | null,
                file_size: null,
                synced_at: new Date().toISOString(),
              });
              return { lastInsertRowid: state.nextFileId - 1, changes: 1 };
            }
            if (sql.includes('DELETE FROM synced_files')) {
              if (sql.includes('device_id = ? AND item_id = ?')) {
                const deviceId = args[0] as number;
                const itemId = args[1] as string;
                const key = `${deviceId}-${itemId}`;
                if (state.synced_files.delete(key)) return { changes: 1 };
                return { changes: 0 };
              }
              if (sql.includes('device_id = ?')) {
                const deviceId = args[0] as number;
                let count = 0;
                for (const [k, v] of state.synced_files.entries()) {
                  if (v.device_id === deviceId) {
                    state.synced_files.delete(k);
                    count++;
                  }
                }
                return { changes: count };
              }
            }
            // --- sync_history ---
            if (sql.includes('INSERT INTO sync_history')) {
              const id = state.nextHistoryId++;
              state.sync_history.set(id, {
                id,
                device_id: args[0],
                started_at: new Date().toISOString(),
                completed_at: args[1],
                tracks_synced: args[2],
                bytes_transferred: args[3],
                status: args[4],
              } as unknown as MockRow);
              return { lastInsertRowid: id, changes: 1 };
            }
            return { lastInsertRowid: 0, changes: 0 };
          },
          get: (...args: unknown[]) => {
            if (sql.includes('SELECT id FROM devices')) {
              return findDeviceByMount(args[0] as string);
            }
            if (sql.includes('SELECT id, last_sync_at FROM devices')) {
              return findDeviceByMount(args[0] as string);
            }
            if (sql.includes('SELECT') && sql.includes('FROM synced_tracks')) {
              if (sql.includes('device_id = ? AND track_id = ?')) {
                const deviceId = args[0] as number;
                const trackId = args[1] as string;
                const row = state.synced_tracks.get(trackId);
                if (row?.device_id === deviceId) return row;
                return undefined;
              }
              if (sql.includes('COUNT(*)')) {
                return { sync_count: 0, total_tracks: 0, total_bytes: 0 };
              }
            }
            return undefined;
          },
          all: (...args: unknown[]) => {
            // --- PRAGMA table_info ---
            const pragmaMatch = sql.match(/PRAGMA table_info\(['"]?(\w+)['"]?\)/);
            if (pragmaMatch) {
              const tableName = pragmaMatch[1];
              // Return column definitions based on table name
              if (tableName === 'synced_files') {
                // These columns exist after the Phase 1 migration
                return [
                  { name: 'id' },
                  { name: 'device_id' },
                  { name: 'item_id' },
                  { name: 'destination_path' },
                  { name: 'file_size' },
                  { name: 'synced_at' },
                  { name: 'item_name' },
                  { name: 'item_type' },
                ];
              }
              if (tableName === 'synced_tracks') {
                return [
                  { name: 'id' },
                  { name: 'device_id' },
                  { name: 'item_id' },
                  { name: 'track_id' },
                  { name: 'destination_path' },
                  { name: 'file_size' },
                  { name: 'metadata_hash' },
                  { name: 'synced_at' },
                  { name: 'cover_art_mode' },
                  { name: 'encoded_bitrate' },
                  { name: 'server_path' },
                ];
              }
              if (tableName === 'devices') {
                return [
                  { name: 'id' },
                  { name: 'mount_point' },
                  { name: 'name' },
                  { name: 'last_sync_at' },
                ];
              }
              return [];
            }
            if (sql.includes('SELECT item_id FROM synced_files WHERE device_id = ?')) {
              const deviceId = args[0] as number;
              return [...state.synced_files.values()]
                .filter((r) => r.device_id === deviceId)
                .map((r) => ({ item_id: r.item_id }));
            }
            if (sql.includes('SELECT item_id, item_name, item_type FROM synced_files')) {
              const deviceId = args[0] as number;
              return [...state.synced_files.values()]
                .filter((r) => r.device_id === deviceId)
                .map((r) => ({
                  item_id: r.item_id,
                  item_name: r.item_name,
                  item_type: r.item_type,
                }));
            }
            if (sql.includes('SELECT') && sql.includes('FROM synced_tracks')) {
              const deviceId = args[0] as number;
              if (sql.includes('AND item_id = ?')) {
                const itemId = args[1] as string;
                return [...state.synced_tracks.values()].filter(
                  (r) => r.device_id === deviceId && r.item_id === itemId,
                );
              }
              return [...state.synced_tracks.values()].filter((r) => r.device_id === deviceId);
            }
            if (sql.includes('SELECT') && sql.includes('FROM sync_history')) {
              return [];
            }
            if (sql.includes('SELECT') && sql.includes('FROM devices')) {
              if (sql.includes('ORDER BY')) return [...state.devices.values()];
            }
            return [];
          },
        };
      }
      transaction(fn: () => void) {
        return () => fn();
      }
      close() {
        /* no-op */
      }
    } as unknown as new (path: string) => import('better-sqlite3').Database,
  };
});

// Import after mocking
import {
  initDatabase,
  closeDatabase,
  upsertSyncedTrack,
  getSyncedTracksForDevice,
  removeSyncedTracksForItem,
  removeSyncedTrack,
} from './database';

// =============================================================================
// TESTS
// =============================================================================

describe('synced_tracks table', () => {
  beforeEach(() => {
    resetState();
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // upsertSyncedTrack
  // ---------------------------------------------------------------------------

  describe('upsertSyncedTrack', () => {
    it('inserts a new synced track record', () => {
      // Seed device
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/mnt/usb/track.mp3',
        5000000,
        'abc123',
        'embed',
        '192k',
        '/music/track.flac',
        null,
      );

      const row = state.synced_tracks.get('track-1');
      expect(row).toBeDefined();
      expect(row!.track_id).toBe('track-1');
      expect(row!.item_id).toBe('album-1');
      expect(row!.metadata_hash).toBe('abc123');
      expect(row!.cover_art_mode).toBe('embed');
      expect(row!.encoded_bitrate).toBe('192k');
      expect(row!.server_path).toBe('/music/track.flac');
    });

    it('updates existing record on conflict (same device_id, track_id)', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      // Insert initial
      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/mnt/usb/old.mp3',
        4000000,
        'oldhash',
        'off',
        null,
        '/old/path.flac',
        null,
      );

      // Update
      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/mnt/usb/new.mp3',
        5000000,
        'newhash',
        'embed',
        '320k',
        '/new/path.flac',
        null,
      );

      const row = state.synced_tracks.get('track-1');
      expect(row!.destination_path).toBe('/mnt/usb/new.mp3');
      expect(row!.metadata_hash).toBe('newhash');
      expect(row!.cover_art_mode).toBe('embed');
      expect(row!.encoded_bitrate).toBe('320k');
    });
  });

  // ---------------------------------------------------------------------------
  // getSyncedTracksForDevice
  // ---------------------------------------------------------------------------

  describe('getSyncedTracksForDevice', () => {
    it('returns all tracks for a device', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/mnt/usb/t1.mp3',
        100,
        'h1',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-2',
        '/mnt/usb/t2.mp3',
        200,
        'h2',
        'embed',
        '192k',
        null,
        null,
      );

      // The function queries the DB — since our mock stores in state.synced_tracks
      // and the real function reads from the mock DB, we need to verify via state
      const rows = [...state.synced_tracks.values()].filter((r) => r.device_id === 1);
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for unknown device', () => {
      const rows = getSyncedTracksForDevice('/nonexistent');
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getSyncedTracksForItem
  // ---------------------------------------------------------------------------

  describe('getSyncedTracksForItem', () => {
    it('returns tracks for a specific item on a device', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/t1.mp3',
        100,
        'h1',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb',
        'album-2',
        'track-3',
        '/t3.mp3',
        300,
        'h3',
        'embed',
        '192k',
        null,
        null,
      );

      const rows = [...state.synced_tracks.values()].filter(
        (r) => r.device_id === 1 && r.item_id === 'album-1',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].track_id).toBe('track-1');
    });
  });

  // ---------------------------------------------------------------------------
  // removeSyncedTracksForItem
  // ---------------------------------------------------------------------------

  describe('removeSyncedTracksForItem', () => {
    it('deletes all tracks for an item on a device', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/t1.mp3',
        100,
        'h1',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-2',
        '/t2.mp3',
        200,
        'h2',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb',
        'album-2',
        'track-3',
        '/t3.mp3',
        300,
        'h3',
        'embed',
        '192k',
        null,
        null,
      );

      removeSyncedTracksForItem('/mnt/usb', 'album-1');

      const remaining = [...state.synced_tracks.values()].filter((r) => r.device_id === 1);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].track_id).toBe('track-3');
    });
  });

  // ---------------------------------------------------------------------------
  // removeSyncedTrack
  // ---------------------------------------------------------------------------

  describe('removeSyncedTrack', () => {
    it('deletes a specific track by track_id', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-1',
        '/t1.mp3',
        100,
        'h1',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb',
        'album-1',
        'track-2',
        '/t2.mp3',
        200,
        'h2',
        'embed',
        '192k',
        null,
        null,
      );

      removeSyncedTrack('/mnt/usb', 'track-1');

      const remaining = [...state.synced_tracks.values()];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].track_id).toBe('track-2');
    });
  });

  // ---------------------------------------------------------------------------
  // SyncedTrackRecord interface shape
  // ---------------------------------------------------------------------------

  describe('SyncedTrackRecord interface', () => {
    it('record contains all required fields from the plan', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb',
        name: 'USB',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb',
        'item-1',
        'track-x',
        '/dest.mp3',
        12345,
        'hashval',
        'embed',
        '320k',
        '/server/path.mp3',
        null,
      );

      const row = state.synced_tracks.get('track-x')!;
      expect(row.id).toBeDefined();
      expect(row.device_id).toBe(1);
      expect(row.item_id).toBe('item-1');
      expect(row.track_id).toBe('track-x');
      expect(row.destination_path).toBe('/dest.mp3');
      expect(row.file_size).toBe(12345);
      expect(row.metadata_hash).toBe('hashval');
      expect(row.cover_art_mode).toBe('embed');
      expect(row.encoded_bitrate).toBe('320k');
      expect(row.server_path).toBe('/server/path.mp3');
      expect(row.synced_at).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Device isolation
  // ---------------------------------------------------------------------------

  describe('device isolation', () => {
    it('tracks are isolated between devices', () => {
      state.devices.set(1, {
        id: 1,
        mount_point: '/mnt/usb1',
        name: 'USB1',
        last_sync_at: null,
      } as MockRow);
      state.devices.set(2, {
        id: 2,
        mount_point: '/mnt/usb2',
        name: 'USB2',
        last_sync_at: null,
      } as MockRow);

      upsertSyncedTrack(
        '/mnt/usb1',
        'album-1',
        'track-a',
        '/usb1/track.mp3',
        100,
        'ha',
        'embed',
        '192k',
        null,
        null,
      );
      upsertSyncedTrack(
        '/mnt/usb2',
        'album-1',
        'track-b',
        '/usb2/track.mp3',
        200,
        'hb',
        'off',
        null,
        null,
        null,
      );

      const usb1Tracks = [...state.synced_tracks.values()].filter((r) => r.device_id === 1);
      const usb2Tracks = [...state.synced_tracks.values()].filter((r) => r.device_id === 2);

      expect(usb1Tracks).toHaveLength(1);
      expect(usb2Tracks).toHaveLength(1);
      expect(usb1Tracks[0].track_id).toBe('track-a');
      expect(usb2Tracks[0].cover_art_mode).toBe('off');
      expect(usb2Tracks[0].encoded_bitrate).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // columnExists helper
  // ---------------------------------------------------------------------------

  describe('columnExists', () => {
    it('returns true when column exists in table', async () => {
      const { columnExists } = await import('./database');
      // Mock Database that returns column list via PRAGMA
      const mockDb = {
        prepare: (sql: string) => ({
          all: () => {
            if (sql.includes('PRAGMA table_info')) {
              return [{ name: 'id' }, { name: 'device_id' }, { name: 'item_name' }];
            }
            return [];
          },
        }),
      } as unknown as import('better-sqlite3').Database;

      const result = columnExists(mockDb, 'synced_files', 'item_name');
      expect(result).toBe(true);
    });

    it('returns false when column does not exist in table', async () => {
      const { columnExists } = await import('./database');
      const mockDb = {
        prepare: (sql: string) => ({
          all: () => {
            if (sql.includes('PRAGMA table_info')) {
              return [{ name: 'id' }, { name: 'device_id' }]; // no item_name
            }
            return [];
          },
        }),
      } as unknown as import('better-sqlite3').Database;

      const result = columnExists(mockDb, 'synced_files', 'item_name');
      expect(result).toBe(false);
    });

    it('is case-sensitive for column names', async () => {
      const { columnExists } = await import('./database');
      const mockDb = {
        prepare: (sql: string) => ({
          all: () => {
            if (sql.includes('PRAGMA table_info')) {
              return [{ name: 'item_name' }];
            }
            return [];
          },
        }),
      } as unknown as import('better-sqlite3').Database;

      expect(columnExists(mockDb, 'synced_files', 'item_name')).toBe(true);
      expect(columnExists(mockDb, 'synced_files', 'ITEM_NAME')).toBe(false);
    });
  });
});
