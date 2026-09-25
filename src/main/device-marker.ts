/**
 * Device Marker — read/write identity file on a removable device root.
 *
 * ORAIN-0716 S1: Each device gets a `.jellytunes-marker.json` written to its
 * root. This file serves two purposes:
 *   1. Stable identity — the `uuid` field lets JellyTunes recognise the same
 *      physical device across sessions even if the mount point changes.
 *   2. Real-writable proof — the act of writing the marker (not just listing)
 *      proves the filesystem is genuinely writable and not a read-only snapshot.
 *
 * Format: JSON with `uuid` (UUIDv4 string), `name` (string), and `version`
 * (positive integer). `version` starts at 1 and enables forward-compatibility:
 * a reader that encounters a higher version it doesn't understand treats the
 * marker as absent (so it won't overwrite a marker written by a newer app).
 *
 * Atomic write: write content to a `.tmp` sibling, then `fs.renameSync` into
 * place. On POSIX this is atomic by the OS; on Windows it is atomic for the
 * rename step (the temp file is in the same directory so rename is atomic).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const MARKER_FILENAME = '.jellytunes-marker.json';

export const CURRENT_FORMAT_VERSION = 1;

/** Fields persisted in the marker file. */
export interface DeviceMarker {
  uuid: string;
  name: string;
  version: number;
}

/** Result of a write attempt. */
export interface WriteMarkerResult {
  ok: true;
  marker: DeviceMarker;
}
export interface WriteMarkerNotWritable {
  ok: false;
  notWritable: true;
  code: string;
}
export type WriteMarkerResult_ = WriteMarkerResult | WriteMarkerNotWritable;

/**
 * Subset of `fs` synchronous operations needed by the marker module.
 * Extracted so tests can inject throwing stubs without mocking the whole `fs` module.
 */
export interface FsSync {
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string, options?: { encoding?: BufferEncoding }): void;
  renameSync(src: string, dest: string): void;
}

/** Path of the marker file for a given device root. */
export function getMarkerPath(deviceRoot: string): string {
  return path.join(deviceRoot, MARKER_FILENAME);
}

/**
 * Read and validate the marker file in `deviceRoot`.
 *
 * Returns `null` when:
 *   - the marker file does not exist
 *   - the marker file is not valid JSON
 *   - any required field (`uuid`, `name`, `version`) is missing
 *   - `version` is not a positive integer (including unknown/future versions)
 *
 * @param fs_ - Injectable fs for testing; defaults to the real `fs` module.
 */
export function readMarker(deviceRoot: string, fs_: FsSync = fs): DeviceMarker | null {
  const filePath = getMarkerPath(deviceRoot);
  let raw: string;
  try {
    raw = fs_.readFileSync(filePath, 'utf-8');
  } catch {
    // ENOENT or any other read error → treat as absent
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON → treat as absent
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || !hasRequiredFields(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // version must be a known, positive integer
  const v = obj.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > CURRENT_FORMAT_VERSION) {
    return null;
  }

  return {
    uuid: String(obj.uuid),
    name: String(obj.name),
    version: v,
  };
}

function hasRequiredFields(
  obj: unknown,
): obj is { uuid: unknown; name: unknown; version: unknown } {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.uuid === 'string' && typeof o.name === 'string' && typeof o.version === 'number';
}

/**
 * Generate a fresh UUID for a new device.
 * Exported so callers that need a UUID without writing can reuse the same
 * generation logic.
 */
export function generateMarkerUuid(): string {
  return randomUUID();
}

/**
 * Write (or overwrite) the marker file in `deviceRoot`.
 *
 * Uses atomic write: temp file + rename.
 *
 * Returns `WriteMarkerResult` on success.
 * Returns `WriteMarkerNotWritable` for EACCES, EPERM, or EROFS without throwing.
 *
 * @param fs_ - Injectable fs for testing; defaults to the real `fs` module.
 */
export function writeMarker(
  deviceRoot: string,
  uuid: string,
  name: string,
  fs_: FsSync = fs,
): WriteMarkerResult_ {
  const filePath = getMarkerPath(deviceRoot);
  const tmpPath = filePath + '.tmp';
  const marker: DeviceMarker = {
    uuid,
    name,
    version: CURRENT_FORMAT_VERSION,
  };
  const content = JSON.stringify(marker, undefined, 2);

  try {
    fs_.writeFileSync(tmpPath, content, { encoding: 'utf-8' });
    fs_.renameSync(tmpPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    // Distinguish the most common write-permission failures
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { ok: false, notWritable: true, code };
    }
    // Any other error (disk full, I/O error, etc.) — propagate
    throw err;
  }

  return { ok: true, marker };
}

// ---------------------------------------------------------------------------
// Async variants (for use from async code paths)
// ---------------------------------------------------------------------------

/** Default FsAsync implementation (fs/promises). */
export const defaultFsAsync = fsp;

/** Subset of `fs/promises` operations needed for async marker access. */
export interface FsAsync {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string, options?: { encoding?: BufferEncoding }): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
}

/**
 * Async read — mirrors `readMarker` but returns a Promise.
 * @param fs_ - Injectable fs/promises for testing; defaults to `fs/promises`.
 */
export async function readMarkerAsync(
  deviceRoot: string,
  fs_: FsAsync = fsp,
): Promise<DeviceMarker | null> {
  const filePath = getMarkerPath(deviceRoot);
  let raw: string;
  try {
    raw = await fs_.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || !hasRequiredFields(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const v = obj.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > CURRENT_FORMAT_VERSION) {
    return null;
  }

  return { uuid: String(obj.uuid), name: String(obj.name), version: v };
}

/**
 * Async write — mirrors `writeMarker` but returns a Promise.
 * @param fs_ - Injectable fs/promises for testing; defaults to `fs/promises`.
 */
export async function writeMarkerAsync(
  deviceRoot: string,
  uuid: string,
  name: string,
  fs_: FsAsync = fsp,
): Promise<WriteMarkerResult_> {
  const filePath = getMarkerPath(deviceRoot);
  const tmpPath = filePath + '.tmp';
  const marker: DeviceMarker = { uuid, name, version: CURRENT_FORMAT_VERSION };
  const content = JSON.stringify(marker, undefined, 2);

  try {
    await fs_.writeFile(tmpPath, content, { encoding: 'utf-8' });
    await fs_.rename(tmpPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { ok: false, notWritable: true, code };
    }
    throw err;
  }

  return { ok: true, marker };
}
