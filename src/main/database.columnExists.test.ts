/**
 * columnExists helper unit tests
 * Tests PRAGMA table_info-based column existence checking.
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */

import { describe, it, expect } from 'vitest';

describe('columnExists', () => {
  it('returns true when column exists in table', async () => {
    const { columnExists } = await import('./database');
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
      prepare: (_sql: string) => ({
        all: () => [{ name: 'item_name' }],
      }),
    } as unknown as import('better-sqlite3').Database;

    expect(columnExists(mockDb, 'synced_files', 'item_name')).toBe(true);
    expect(columnExists(mockDb, 'synced_files', 'ITEM_NAME')).toBe(false);
  });

  it('handles empty column list gracefully', async () => {
    const { columnExists } = await import('./database');
    const mockDb = {
      prepare: (_sql: string) => ({
        all: () => [],
      }),
    } as unknown as import('better-sqlite3').Database;

    expect(columnExists(mockDb, 'any_table', 'any_column')).toBe(false);
  });

  it('queries correct table via PRAGMA', async () => {
    const { columnExists } = await import('./database');
    let capturedSql = '';
    const mockDb = {
      prepare: (sql: string) => ({
        all: () => {
          capturedSql = sql;
          return [{ name: 'id' }];
        },
      }),
    } as unknown as import('better-sqlite3').Database;

    columnExists(mockDb, 'my_table', 'my_col');
    expect(capturedSql).toBe("PRAGMA table_info('my_table')");
  });
});
