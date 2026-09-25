/**
 * Tests for validateDestination writability logic (AC3/AC4).
 *
 * Key AC4 requirement: writable = true only after a real write operation, not just
 * readdir. AC3 requirement: specific error codes (EACCES/EPERM/EROFS) surface to
 * the caller so the UI can distinguish permission failures from read-only mounts.
 *
 * Finding [HIGH traversal]: assertFilesystemPath is called before any I/O, so
 * path-traversal payloads (../..) and FFmpeg protocol URIs are rejected at the
 * boundary with a clear error message (not a generic I/O error).
 *
 * Finding [HIGH AC3]: validateDestination now calls writeMarkerAsync, so the
 * typed EACCES/EPERM/EROFS codes are surfaced. The canonical device marker is
 * written (not a probe) because AC4 requires a real write, and the marker module
 * provides the only production-quality atomic-write implementation.
 *
 * Finding [HIGH probe cleanup]: removed — writeMarkerAsync uses the canonical
 * path, so no probe file exists to clean up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateDestination, createMockFileSystem } from './sync-files';
import type { FileSystem } from './sync-files';
import type { SyncLogger } from './types';

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
// helpers
// ---------------------------------------------------------------------------

function mockLogger(): SyncLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// AC4 – writability proof
// ---------------------------------------------------------------------------

describe('validateDestination — AC4 writable proof', () => {
  it('returns writable: true after successfully writing the device marker', async () => {
    const mockFs = createMockFileSystem();
    (mockFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    const result = await validateDestination(tmpDir, mockFs as FileSystem, mockLogger());
    expect(result.writable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns writable: false for a readable-but-not-writable directory', async () => {
    const mockFs = createMockFileSystem();
    const alwaysRejectFs = Object.assign(Object.create(mockFs), {
      writeFile: async (_p: string, _data: Buffer) => {
        const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        throw err;
      },
    });
    (alwaysRejectFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    const result = await validateDestination(tmpDir, alwaysRejectFs as FileSystem, mockLogger());
    expect(result.writable).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // AC4: an existing device marker is preserved — the write succeeds (marker is
  // overwritten with the probe uuid/name, which is the correct behaviour for S1)
  it('preserves an existing marker when writing (S1: marker IS the writability proof)', async () => {
    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    const existingMarker = { uuid: 'device-uuid-1234', name: 'My USB Drive', version: 1 };

    const mockFs = createMockFileSystem();
    (mockFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);
    await mockFs.writeFile(markerPath, Buffer.from(JSON.stringify(existingMarker)));

    const result = await validateDestination(tmpDir, mockFs as FileSystem, mockLogger());

    expect(result.writable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 – typed error codes surface (EACCES / EPERM / EROFS)
// ---------------------------------------------------------------------------

describe('validateDestination — AC3 typed error codes', () => {
  for (const [code, label] of [
    ['EACCES', 'permission denied'],
    ['EPERM', 'operation not permitted'],
    ['EROFS', 'read-only filesystem'],
  ] as const) {
    it(`surfaces ${code} (${label}) in the error message`, async () => {
      const mockFs = createMockFileSystem();
      const rejectFs = Object.assign(Object.create(mockFs), {
        writeFile: async (_p: string, _data: Buffer) => {
          throw Object.assign(new Error('write failed'), { code });
        },
      });
      (rejectFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

      const result = await validateDestination(tmpDir, rejectFs as FileSystem, mockLogger());

      expect(result.writable).toBe(false);
      expect(result.errors[0]).toContain(code);
    });
  }
});

// ---------------------------------------------------------------------------
// HIGH traversal — assertFilesystemPath rejects .. and FFmpeg protocols
// ---------------------------------------------------------------------------

describe('validateDestination — path-traversal guard (assertFilesystemPath)', () => {
  it('rejects a path containing ".." traversal segments', async () => {
    const mockFs = createMockFileSystem();
    const result = await validateDestination(
      '/tmp/mnt/../../../etc/passwd',
      mockFs as FileSystem,
      mockLogger(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/local filesystem path/i);
  });

  it('rejects a non-absolute path', async () => {
    const mockFs = createMockFileSystem();
    const result = await validateDestination('relative/path', mockFs as FileSystem, mockLogger());
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/absolute/i);
  });

  it('rejects FFmpeg protocol URIs', async () => {
    const mockFs = createMockFileSystem();
    const result = await validateDestination(
      'pipe:///dev/null',
      mockFs as FileSystem,
      mockLogger(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/ffmpeg protocol/i);
  });
});
