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
    // The probe is written to a temporary path (not the canonical marker) and is
    // cleaned up after validation — the canonical marker path must NOT be created.
    await expect(mockFs.exists(path.join(tmpDir, MARKER_FILENAME))).resolves.toBe(false);
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

  // Finding [HIGH-1]: probe must never overwrite the canonical device marker.
  // Seed the mock with an existing marker, call validateDestination, then assert
  // the marker content is unchanged.
  it('does not overwrite an existing canonical device marker', async () => {
    const existingMarker = { uuid: 'device-uuid-1234', name: 'My USB Drive', version: 1 };
    const markerPath = path.join(tmpDir, MARKER_FILENAME);

    const mockFs = createMockFileSystem();
    (mockFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);
    // Seed an existing marker
    await mockFs.writeFile(markerPath, Buffer.from(JSON.stringify(existingMarker)));

    await validateDestination(tmpDir, mockFs as FileSystem);

    // The canonical marker must be untouched — not replaced by a probe uuid/name.
    const raw = await mockFs.readFile(markerPath);
    const marker = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
    expect(marker.uuid).toBe('device-uuid-1234');
    expect(marker.name).toBe('My USB Drive');
    expect(marker.version).toBe(1);
  });

  // Finding [HIGH-2]: a JSON.parse failure on re-read must NOT be reported as
  // "Directory is not readable/writable" — that message is for write failures.
  it('reports a read-back failure (not write failure) when re-read returns corrupt JSON', async () => {
    const mockFs = createMockFileSystem();
    (mockFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    // Overriding readFile: succeed on write, but return corrupt data on re-read.
    let writeSucceeded = false;
    const probeFs = Object.assign(Object.create(mockFs), {
      writeFile: async (p: string, data: Buffer) => {
        await mockFs.writeFile(p, data);
        writeSucceeded = true;
      },
      readFile: async (p: string) => {
        if (writeSucceeded && p.includes('.jellytunes-writeprobe-')) {
          // Simulate a corrupt filesystem that returns malformed JSON on re-read
          return Buffer.from('not valid json {{{');
        }
        return mockFs.readFile(p);
      },
    });
    (probeFs as FileSystem & { __setDirectory: (p: string) => void }).__setDirectory(tmpDir);

    const result = await validateDestination(tmpDir, probeFs as FileSystem);

    expect(result.writable).toBe(false);
    // Must NOT say "not writable" — the write succeeded; the read-back failed.
    expect(result.errors.some((e) => /not.*writable/i.test(e))).toBe(false);
    // Must mention read-back failure
    expect(result.errors.some((e) => /could not be read back/i.test(e))).toBe(true);
  });
});
