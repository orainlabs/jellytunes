/**
 * Legacy ID3 tags (ORAIN-XXXX): per-device `id3TagVersion` must reach every
 * FFmpeg pass that writes an MP3, and must actually produce an ID3v2.3 tag.
 *
 * Background: the Sony NWZ-B183F (and other older players) cannot read
 * ID3v2.4 at all — they fall back to ID3v1 (or the filename). FFmpeg writes
 * v2.4 by default on every MP3 mux, including the `-c copy` passes used for
 * lyrics and ReplayGain, so a single missed call site silently upgrades the
 * file back to v2.4.
 *
 * Two layers of coverage:
 *   1. spawn-mocked argument tests — deterministic on every platform, assert
 *      the `-id3v2_version 3` flag reaches every writer and only for .mp3.
 *   2. real-FFmpeg byte tests — skip when no binary is on PATH, parse the
 *      on-disk ID3 header/frames to prove the version, TYER/TDRC swap and
 *      text encoding.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFFmpegConverter, createMockConverter, createMockFileSystem } from './sync-files';
import { createSyncCore } from './sync-core';
import { createMockApiClient } from './sync-api';
import type { SyncConfig } from './types';

// The unittest alias maps @ffmpeg-installer/ffmpeg to a fake path. Point the
// real-binary tests at PATH instead so they can actually run when ffmpeg is
// installed; spawn-mocked tests never touch the binary.
vi.mock('./ffmpeg-path', () => ({
  resolveFFmpegPath: () => 'ffmpeg',
  resolveFFprobePath: () => 'ffprobe',
}));

// sync-core imports the database module at load time; mock it so these tests
// do not need a built better-sqlite3 binding.
vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: vi.fn(() => []),
  getSyncedTracksForItem: vi.fn(() => []),
  getSyncedItems: vi.fn(() => []),
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

function mockSpawn(): { calls: string[][]; restore: () => void } {
  const calls: string[][] = [];
  const cp = require('child_process');
  const original = cp.spawn;
  cp.spawn = (_cmd: string, args: string[]) => {
    calls.push(args);
    const proc: Record<string, unknown> = {
      on(event: string, cb: (code: number) => void) {
        if (event === 'close') {
          setTimeout(() => {
            // Lyrics/ReplayGain/strip move the temp output onto itself after
            // a successful copy; create it so the fs step does not throw.
            try {
              require('fs').writeFileSync(args[args.length - 1], 'mock-output');
            } catch {
              /* destination may be a non-existent directory in arg tests */
            }
            cb(0);
          }, 0);
        }
        return proc;
      },
      stdin: new PassThrough(),
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: () => {},
      removeAllListeners: () => proc,
    };
    return proc;
  };
  return {
    calls,
    restore: () => {
      cp.spawn = original;
    },
  };
}

function id3Arg(args: string[]): string | null {
  const index = args.indexOf('-id3v2_version');
  return index === -1 ? null : args[index + 1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('id3TagVersion reaches every MP3 writer', () => {
  it('defaults to FFmpeg modern tags (no flag)', async () => {
    const spawn = mockSpawn();
    try {
      const converter = createFFmpegConverter();
      await converter.convertStreamToMp3WithMeta('/a/in.flac', '/a/out.mp3', '192k', {});
      expect(id3Arg(spawn.calls[0])).toBeNull();
    } finally {
      spawn.restore();
    }
  });

  it('passes -id3v2_version 3 when legacy mode is selected', async () => {
    const spawn = mockSpawn();
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      const result = await converter.convertStreamToMp3WithMeta(
        '/a/in.flac',
        '/a/out.mp3',
        '192k',
        { title: 'T' },
      );
      expect(result.success).toBe(true);
      expect(id3Arg(spawn.calls[0])).toBe('3');
    } finally {
      spawn.restore();
    }
  });

  it('switches back to modern when the setting is reset', async () => {
    const spawn = mockSpawn();
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      converter.setId3TagVersion?.('v2.4');
      await converter.convertStreamToMp3WithMeta('/a/in.flac', '/a/out.mp3', '192k', {});
      expect(id3Arg(spawn.calls[0])).toBeNull();
    } finally {
      spawn.restore();
    }
  });

  it('tags an MP3 with v2.3 but never passes the flag to non-MP3 output', async () => {
    const spawn = mockSpawn();
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      await converter.tagFile('/a/in.mp3', '/a/out.mp3', { title: 'T' });
      await converter.tagFile('/a/in.flac', '/a/out.flac', { title: 'T' });

      expect(id3Arg(spawn.calls[0])).toBe('3');
      expect(id3Arg(spawn.calls[1])).toBeNull();
    } finally {
      spawn.restore();
    }
  });

  it('keeps v2.3 for lyric embedding even when the caller passes the stale source format', async () => {
    const spawn = mockSpawn();
    const dir = mkdtempSync(join(tmpdir(), 'jt-id3-args-'));
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      // A FLAC→MP3 conversion leaves track.format === 'flac' upstream. The
      // temp file must still be .mp3 (not .flac) and carry the v2.3 flag.
      const result = await converter.embedLyrics(
        join(dir, 'track.mp3'),
        join(dir, 'out.mp3'),
        'hi',
        'flac',
      );
      expect(result.success).toBe(true);
      expect(spawn.calls[0].at(-1)).toMatch(/\.mp3$/);
      expect(id3Arg(spawn.calls[0])).toBe('3');
    } finally {
      spawn.restore();
    }
  });

  it('keeps v2.3 for ReplayGain embedding on a converted MP3', async () => {
    const spawn = mockSpawn();
    const dir = mkdtempSync(join(tmpdir(), 'jt-id3-args-'));
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      const result = await converter.embedReplayGain(
        join(dir, 'track.mp3'),
        join(dir, 'out.mp3'),
        { trackGain: '-3.0 dB', trackPeak: '0.9' },
        'flac',
      );
      expect(result.success).toBe(true);
      expect(spawn.calls[0].at(-1)).toMatch(/\.mp3$/);
      expect(id3Arg(spawn.calls[0])).toBe('3');
    } finally {
      spawn.restore();
    }
  });

  it('keeps v2.3 when stripping cover art from an MP3', async () => {
    const spawn = mockSpawn();
    try {
      const converter = createFFmpegConverter();
      converter.setId3TagVersion?.('v2.3');
      await converter.stripCoverArt('/a/in.mp3', '/a/out.mp3');
      expect(id3Arg(spawn.calls[0])).toBe('3');
    } finally {
      spawn.restore();
    }
  });
});

describe('SyncCore propagates the per-destination setting', () => {
  it('calls setId3TagVersion with the resolved option before writing tracks', async () => {
    const converter = { ...createMockConverter(), setId3TagVersion: vi.fn() };
    const fs = createMockFileSystem();
    fs.__setDirectory?.('/mnt/usb');
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [], errors: [] }),
    });
    const config: SyncConfig = {
      serverUrl: 'https://jellyfin.test',
      apiKey: 'key',
      userId: '0123456789abcdef0123456789abcdef',
    };
    const core = createSyncCore(config, { api, fs, converter });

    await core.sync({
      itemIds: [],
      itemTypes: new Map(),
      destinationPath: '/mnt/usb',
      options: { id3TagVersion: 'v2.3' },
    });

    expect(converter.setId3TagVersion).toHaveBeenCalledWith('v2.3');
  });

  it('uses the modern default when the option is absent', async () => {
    const converter = { ...createMockConverter(), setId3TagVersion: vi.fn() };
    const fs = createMockFileSystem();
    fs.__setDirectory?.('/mnt/usb');
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [], errors: [] }),
    });
    const core = createSyncCore(
      {
        serverUrl: 'https://jellyfin.test',
        apiKey: 'key',
        userId: '0123456789abcdef0123456789abcdef',
      },
      { api, fs, converter },
    );

    await core.sync({ itemIds: [], itemTypes: new Map(), destinationPath: '/mnt/usb' });

    expect(converter.setId3TagVersion).toHaveBeenCalledWith('v2.4');
  });
});

// ---------------------------------------------------------------------------
// Real-FFmpeg byte-level verification
// ---------------------------------------------------------------------------

interface Id3Info {
  major: number;
  frames: string[];
  encodings: Record<string, number>;
}

function syncsafe(bytes: Buffer): number {
  return (
    ((bytes[0] & 0x7f) << 21) |
    ((bytes[1] & 0x7f) << 14) |
    ((bytes[2] & 0x7f) << 7) |
    (bytes[3] & 0x7f)
  );
}

function parseId3(data: Buffer): Id3Info | null {
  if (data.subarray(0, 3).toString('latin1') !== 'ID3') return null;
  const major = data[3];
  const tagSize = syncsafe(data.subarray(6, 10));
  const frames: string[] = [];
  const encodings: Record<string, number> = {};
  let offset = 10;
  while (offset + 10 <= 10 + tagSize) {
    const id = data.subarray(offset, offset + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size =
      major === 4 ? syncsafe(data.subarray(offset + 4, offset + 8)) : data.readUInt32BE(offset + 4);
    if (['TIT2', 'TPE1', 'TALB', 'TYER', 'TDRC', 'TRCK'].includes(id)) {
      encodings[id] = data[offset + 10];
    }
    frames.push(id);
    offset += 10 + size;
  }
  return { major, frames, encodings };
}

const realFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
const canRunReal = realFfmpeg.status === 0;

describe.skipIf(!canRunReal)('real FFmpeg produces the expected ID3 bytes', () => {
  let dir: string;
  let flac: string;
  let v23: string;
  // Escaped so this source file stays ASCII-only for scripts/check-spanish.sh,
  // while the tag values still exercise FFmpeg's non-ASCII handling.
  const metadata = {
    title: 'Caf\u00e9',
    artist: 'Sigur R\u00f3s',
    album: 'Test',
    year: '1999',
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jt-id3-'));
    flac = join(dir, 'source.flac');
    const gen = spawnSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=1',
      '-ac',
      '1',
      '-c:a',
      'flac',
      flac,
    ]);
    expect(gen.status).toBe(0);

    v23 = join(dir, 'legacy-source.mp3');
    const converter = createFFmpegConverter();
    converter.setId3TagVersion?.('v2.3');
    const result = await converter.convertStreamToMp3WithMeta(flac, v23, '192k', metadata);
    expect(result.success).toBe(true);
  });

  it('writes ID3v2.4 + TDRC + UTF-8 by default', async () => {
    const out = join(dir, 'modern.mp3');
    const converter = createFFmpegConverter();
    const result = await converter.convertStreamToMp3WithMeta(flac, out, '192k', metadata);
    expect(result.success).toBe(true);

    const info = parseId3(readFileSync(out));
    expect(info).not.toBeNull();
    expect(info?.major).toBe(4);
    expect(info?.frames).toContain('TDRC');
    expect(info?.frames).not.toContain('TYER');
    expect(info?.encodings.TIT2).toBe(3); // UTF-8
  });

  it('writes ID3v2.3 + TYER + UTF-16 for non-ASCII in legacy mode', () => {
    const info = parseId3(readFileSync(v23));
    expect(info).not.toBeNull();
    expect(info?.major).toBe(3);
    expect(info?.frames).toContain('TYER');
    expect(info?.frames).not.toContain('TDRC');
    // FFmpeg uses Latin-1 for ASCII and UTF-16 for non-ASCII in v2.3.
    expect(info?.encodings.TIT2).toBe(1);
    expect(info?.encodings.TALB).toBe(0);
  });

  it('tagFile keeps v2.3 and applies the new metadata', async () => {
    const out = join(dir, 'retagged.mp3');
    const converter = createFFmpegConverter();
    converter.setId3TagVersion?.('v2.3');
    const result = await converter.tagFile(v23, out, { title: 'New Title' });
    expect(result.success).toBe(true);

    const info = parseId3(readFileSync(out));
    expect(info?.major).toBe(3);
    expect(info?.frames).toContain('TYER');
  });

  it('embedLyrics keeps v2.3 even when the stale source format is passed', async () => {
    const out = join(dir, 'lyrics.mp3');
    const converter = createFFmpegConverter();
    converter.setId3TagVersion?.('v2.3');
    const result = await converter.embedLyrics(v23, out, 'hello lyrics', 'flac');
    expect(result.success).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);

    const info = parseId3(readFileSync(out));
    expect(info?.major).toBe(3);
  });

  it('embedReplayGain keeps v2.3', async () => {
    const out = join(dir, 'replaygain.mp3');
    const converter = createFFmpegConverter();
    converter.setId3TagVersion?.('v2.3');
    const result = await converter.embedReplayGain(
      v23,
      out,
      { trackGain: '-3.0 dB', trackPeak: '0.9' },
      'flac',
    );
    expect(result.success).toBe(true);

    const info = parseId3(readFileSync(out));
    expect(info?.major).toBe(3);
  });

  it('stripCoverArt keeps v2.3', async () => {
    const out = join(dir, 'stripped.mp3');
    const converter = createFFmpegConverter();
    converter.setId3TagVersion?.('v2.3');
    const result = await converter.stripCoverArt(v23, out);
    expect(result.success).toBe(true);

    const info = parseId3(readFileSync(out));
    expect(info?.major).toBe(3);
  });
});
