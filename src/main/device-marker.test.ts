import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MARKER_FILENAME = '.jellytunes-marker.json';
const CURRENT_FORMAT_VERSION = 1;

import {
  readMarker,
  writeMarker,
  getMarkerPath,
  type WriteMarkerNotWritable,
  type FsSync,
} from './device-marker';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function markerPath(dir: string) {
  return path.join(dir, MARKER_FILENAME);
}

/** Throwing stub that simulates writeFileSync throwing with the given code. */
function throwingWriteFs(code: string): FsSync {
  return {
    readFileSync: fs.readFileSync,
    writeFileSync: (_path, _data, _opts) => {
      const err = new Error(`simulated ${code}`) as Error & { code: string };
      err.code = code;
      throw err;
    },
    renameSync: fs.renameSync,
  };
}

/** Throwing stub that simulates renameSync throwing with the given code. */
function throwingRenameFs(code: string): FsSync {
  return {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: (_src, _dest) => {
      const err = new Error(`simulated ${code}`) as Error & { code: string };
      err.code = code;
      throw err;
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jellytunes-marker-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// AC1 – write + read returns same fields
// ---------------------------------------------------------------------------

describe('writeMarker + readMarker', () => {
  it('writes and reads back the same uuid, name, and version', () => {
    const uuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
    const name = 'My USB Drive';
    const result = writeMarker(tmpDir, uuid, name);
    expect(result.ok).toBe(true);

    const marker = readMarker(tmpDir);
    expect(marker).toEqual({
      uuid,
      name,
      version: CURRENT_FORMAT_VERSION,
    });
  });

  it('writes atomically (temp file + rename)', () => {
    const uuid = '12345678-1234-4234-8234-123456789abc';
    const name = 'SD Card';

    writeMarker(tmpDir, uuid, name);

    // The final file must exist with correct content
    expect(fs.existsSync(markerPath(tmpDir))).toBe(true);
    const raw = fs.readFileSync(markerPath(tmpDir), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.uuid).toBe(uuid);
    expect(parsed.name).toBe(name);
    expect(parsed.version).toBe(CURRENT_FORMAT_VERSION);

    // No stray .tmp file must remain
    const entries = fs.readdirSync(tmpDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 – absent / corrupt marker
// ---------------------------------------------------------------------------

describe('readMarker — absent or corrupt', () => {
  it('returns null for absent marker (no exception)', () => {
    const result = readMarker(tmpDir);
    expect(result).toBeNull();
  });

  it('treats corrupt marker (non-JSON) as absent — no exception', () => {
    fs.writeFileSync(markerPath(tmpDir), 'not json {', 'utf-8');
    const result = readMarker(tmpDir);
    expect(result).toBeNull();
  });

  it('treats marker with missing required fields as absent — no exception', () => {
    fs.writeFileSync(
      markerPath(tmpDir),
      JSON.stringify({ uuid: 'abc' }), // missing name and version
      'utf-8',
    );
    const result = readMarker(tmpDir);
    expect(result).toBeNull();
  });

  it('treats marker with version=0 (unknown) as absent — no exception', () => {
    fs.writeFileSync(
      markerPath(tmpDir),
      JSON.stringify({ uuid: 'abc', name: 'x', version: 0 }),
      'utf-8',
    );
    const result = readMarker(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 – permission errors
// ---------------------------------------------------------------------------

describe('writeMarker — permission errors', () => {
  it('returns "not-writable" with EACCES when writeFileSync fails', () => {
    const result = writeMarker(tmpDir, 'uuid', 'name', throwingWriteFs('EACCES'));
    expect(result.ok).toBe(false);
    const notWritable = result as WriteMarkerNotWritable;
    expect(notWritable.notWritable).toBe(true);
    expect(notWritable.code).toBe('EACCES');
  });

  it('returns "not-writable" with EPERM when writeFileSync fails', () => {
    const result = writeMarker(tmpDir, 'uuid', 'name', throwingWriteFs('EPERM'));
    expect(result.ok).toBe(false);
    const notWritable = result as WriteMarkerNotWritable;
    expect(notWritable.notWritable).toBe(true);
    expect(notWritable.code).toBe('EPERM');
  });

  it('returns "not-writable" with EROFS when renameSync fails', () => {
    const result = writeMarker(tmpDir, 'uuid', 'name', throwingRenameFs('EROFS'));
    expect(result.ok).toBe(false);
    const notWritable = result as WriteMarkerNotWritable;
    expect(notWritable.notWritable).toBe(true);
    expect(notWritable.code).toBe('EROFS');
  });
});

// ---------------------------------------------------------------------------
// AC4 – getMarkerPath
// ---------------------------------------------------------------------------

describe('getMarkerPath', () => {
  it('returns the expected marker path for a given device root', () => {
    const deviceRoot = '/Volumes/USB';
    expect(getMarkerPath(deviceRoot)).toBe(path.join('/Volumes/USB', MARKER_FILENAME));
  });
});

// ---------------------------------------------------------------------------
// AC5 – forward-compatibility (higher version preserves uuid/name)
// ---------------------------------------------------------------------------

describe('readMarker — forward compatibility', () => {
  it('returns null for a marker with a version higher than known', () => {
    const futureUuid = 'aabbccdd-aabb-aabb-aabb-aabbccddeeff';
    const futureName = 'Future Device';
    fs.writeFileSync(
      markerPath(tmpDir),
      JSON.stringify({ uuid: futureUuid, name: futureName, version: 99 }),
      'utf-8',
    );

    const result = readMarker(tmpDir);
    // Reader doesn't understand version 99 → treats as absent
    expect(result).toBeNull();
  });
});
