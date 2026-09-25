/**
 * Tests for validateDestination writability logic (AC4).
 *
 * The key AC4 requirement: writable = true only after writing and re-reading
 * the device marker. A directory that passes `readdir` but rejects writes
 * (e.g. a read-only USB snapshot) must yield writable: false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateDestination } from './sync-files';
import { createMockFileSystem } from './sync-files';
import type { FileSystem } from './sync-files';

const MARKER_FILENAME = '.jellytunes-marker.json';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jellytunes-valdest-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// AC4 – validateDestination writability proof
// ---------------------------------------------------------------------------

describe('validateDestination — AC4 writable proof', () => {
  it('returns writable: true after successfully writing the marker', async () => {
    // Register tmpDir as a directory in the mock so exists() returns true.
    // The mock's FileSystem interface satisfies validateDestination's needs;
    // the real fs/promises handles actual marker I/O.
    const mockFs = createMockFileSystem();
    (mockFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    const result = await validateDestination(tmpDir, mockFs as FileSystem);
    expect(result.writable).toBe(true);
    expect(result.errors).toHaveLength(0);
    // Verify the marker was written to the mock filesystem (in-memory Map)
    await expect(mockFs.exists(path.join(tmpDir, MARKER_FILENAME))).resolves.toBe(true);
  });

  it('returns writable: false for a readable-but-not-writable directory', async () => {
    const mockFs = createMockFileSystem();
    // Inject a writeFile that always throws — simulating a read-only filesystem.
    // This is more reliable than chmod, which root ignores on macOS/Windows.
    const alwaysRejectFs = Object.assign(Object.create(mockFs), {
      writeFile: async (_path: string, _data: Buffer) => {
        const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        throw err;
      },
    });
    (alwaysRejectFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    const result = await validateDestination(tmpDir, alwaysRejectFs as FileSystem);
    expect(result.writable).toBe(false);
    expect(result.errors.some((e) => /not.*writable|not readable/i.test(e))).toBe(true);
  });
});
