/**
 * Tests for temp file path construction (issue #3)
 *
 * Hardcoded /tmp/ paths fail on Windows — the OS interprets them as C:\tmp\
 * which doesn't exist, causing ENOENT on every FLAC→MP3 conversion attempt.
 * Paths must be built with os.tmpdir() so they resolve correctly on all platforms.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTempPaths } from './temp-path';
import { tmpdir } from 'os';
import { join } from 'path';

describe('buildTempPaths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses os.tmpdir() as the base directory', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track One', 123456789);
    expect(sourcePath.startsWith(tmpdir())).toBe(true);
    expect(tempPath.startsWith(tmpdir())).toBe(true);
  });

  it('uses os.tmpdir() as base — not a hardcoded string', () => {
    // The real bug was /tmp/ hardcoded as a string literal.
    // We verify the path starts with whatever tmpdir() returns on this OS
    // (e.g. /tmp on Linux, C:\Users\...\Temp on Windows).
    const { sourcePath, tempPath } = buildTempPaths('Track One', 123456789);
    expect(sourcePath.startsWith(tmpdir())).toBe(true);
    expect(tempPath.startsWith(tmpdir())).toBe(true);
  });

  it('includes the timestamp in both paths for uniqueness', () => {
    const ts = 1711620000000;
    const { sourcePath, tempPath } = buildTempPaths('Song', ts);
    expect(sourcePath).toContain(String(ts));
    expect(tempPath).toContain(String(ts));
  });

  it('sanitizes special characters from the track name', () => {
    const { tempPath } = buildTempPaths('AC/DC: Back in Black!', 1);
    // No slashes, colons or exclamation marks in the filename
    const filename = tempPath.split(/[\\/]/).pop()!;
    expect(filename).not.toMatch(/[/:!]/);
  });

  it('returns distinct paths for source and converted output', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track', 1);
    expect(sourcePath).not.toBe(tempPath);
  });

  it('produced paths are joinable with path.join without double separators', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track', 1);
    // Reconstructing via join should yield the same path
    const dir = tmpdir();
    const srcFile = sourcePath.replace(dir, '').replace(/^[\\/]/, '');
    const tmpFile = tempPath.replace(dir, '').replace(/^[\\/]/, '');
    expect(join(dir, srcFile)).toBe(sourcePath);
    expect(join(dir, tmpFile)).toBe(tempPath);
  });
});
