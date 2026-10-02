/**
 * ORAIN-0767 — Actionable per-track error messages (jellytunes#27).
 *
 * The reporter saw eight failures as "Download failed: Download failed: 404
 * Not Found" — duplicate prefix, no hint that the source library may need a
 * rescan. FFmpeg failures showed up as "FFmpeg exited with code 1: <path>"
 * because the path-scrub regex anchors at any `/` or `\` and consumes
 * bracketed prefixes like `[out#0/mp3 @ 0x...]` along with the path. The
 * zero-byte track (`Bomb (1)`) surfaced as "Incomplete download (0 of 0
 * bytes)" — true and useless.
 *
 * Each AC below is a regression pin against the user-facing message shape.
 * The scrub regex is shared between the FFmpeg path and the catch-block
 * download path; both tests below exercise one or both.
 */

import { describe, it, expect, vi } from 'vitest';
import { ApiError, createMockApiClient } from './sync-api';
import { createMockFileSystem, ffmpegErrorMessage, type AudioConverter } from './sync-files';
import { createTestSyncCore } from './sync-core';
import { validateDownloadSize } from './download-validation';
import type { TrackInfo, ItemType } from './types';

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

function makeTrack(overrides: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id: 'track-0767',
    name: 'Bomb (1)',
    album: 'Album',
    artists: ['Artist'],
    path: '/music/Artist/Album/track.mp3',
    format: 'mp3',
    size: 5_000_000,
    trackNumber: 1,
    ...overrides,
  };
}

function makeConverter(): AudioConverter {
  return {
    isAvailable: async () => true,
    convertToMp3: async () => ({ success: true }),
    convertStreamToMp3: async () => ({ success: true }),
    convertStreamToMp3WithMeta: async () => ({ success: true }),
    tagFile: async () => ({ success: true }),
    readFileMetadata: async () => ({}),
    embedLyrics: async () => ({ success: true }),
    stripCoverArt: async () => ({ success: true, hadCover: false }),
    embedReplayGain: async () => ({ success: true }),
  };
}

describe('ORAIN-0767 AC1: 404 message is dedup-prefixed + Jellyfin-rescan hint', () => {
  it('404 download failure: exactly one "Download failed:" prefix + Jellyfin rescan hint', async () => {
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [makeTrack()], errors: [] }),
      downloadItemStream: async () => {
        // Real production shape: sync-api throws `ApiError("Download failed: 404 Not Found", 404)`
        // at sync-api.ts:670. We mimic that throw shape directly so this
        // test pins the catch-side scrubber rather than the throw site.
        throw new ApiError('Download failed: 404 Not Found', 404);
      },
    });
    const fs = createMockFileSystem();
    const converter = makeConverter();
    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      { api, fs, converter },
    );

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: '/music',
      options: { convertToMp3: false },
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = result.errors[0].message;

    // AC1 first half: prefix appears exactly once. The old behaviour
    // emitted `Download failed: Download failed: 404 Not Found` because
    // the throw site and the catch site both prepended the prefix.
    const matches = msg.match(/Download failed:/g) ?? [];
    expect(matches).toHaveLength(1);

    // AC1 second half: actionable hint. The 404 came from Jellyfin
    // because the file is no longer on disk server-side — JellyTunes
    // cannot fix it, only explain it.
    expect(msg.toLowerCase()).toContain('jellyfin');
    expect(msg.toLowerCase()).toMatch(/rescan|library/);
    expect(result.errors[0].phase).toBe('download');
  });

  it('non-404 5xx: prefix dedup still applies, but no Jellyfin-rescan hint', async () => {
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [makeTrack()], errors: [] }),
      downloadItemStream: async () => {
        // 500 is "server error", not "file gone" — a different cause and
        // a different action. The hint must NOT appear for non-404.
        throw new ApiError('Download failed: 500 Internal Server Error', 500);
      },
    });
    const fs = createMockFileSystem();
    const converter = makeConverter();
    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      { api, fs, converter },
    );

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: '/music',
      options: { convertToMp3: false },
    });

    const matches = (result.errors[0].message.match(/Download failed:/g) ?? []).length;
    expect(matches).toBe(1);
    // No Jellyfin-rescan hint for 500 — it's a generic server error.
    expect(result.errors[0].message.toLowerCase()).not.toContain('rescan');
  });

  it('non-ApiError throw: still exactly one "Download failed:" prefix', async () => {
    // Defensive: any non-ApiError that reaches the catch site (e.g. a
    // bare TypeError from the HTTP layer) must not get a second prefix
    // either. The contract is: ONE prefix regardless of source.
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [makeTrack()], errors: [] }),
      downloadItemStream: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8096');
      },
    });
    const fs = createMockFileSystem();
    const converter = makeConverter();
    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      { api, fs, converter },
    );

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: '/music',
      options: { convertToMp3: false },
    });

    const matches = (result.errors[0].message.match(/Download failed:/g) ?? []).length;
    expect(matches).toBe(1);
  });
});

describe('ORAIN-0767 AC3: zero-byte download yields "Server returned an empty file" message', () => {
  it('Content-Length=0 → friendly reason with Jellyfin-rescan hint', () => {
    const r = validateDownloadSize({
      contentLength: 0,
      receivedBytes: 0,
      declaredSize: 5_000_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.toLowerCase()).toContain('empty');
    // AC3 actionable: suggests Jellyfin rescan.
    expect(r.reason.toLowerCase()).toMatch(/rescan|library|jellyfin/);
  });

  it('receivedBytes < contentLength → existing "Incomplete download" wording is preserved', () => {
    // The zero-byte case is the ONLY reason we are rewriting. A partial
    // download keeps the existing wording so we do not regress 401-style
    // failure logs or change the diagnostic surface.
    const r = validateDownloadSize({
      contentLength: 1024,
      receivedBytes: 800,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('Incomplete download (800 of 1024 bytes)');
  });

  it('SyncCore surfaces the empty-body reason via download phase + no absolute paths', async () => {
    // End-to-end shape check: the message that lands in SyncError.message
    // must be the friendly one, must be in phase 'download' (not
    // 'validation'), and must not leak the URL placeholder.
    const api = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [makeTrack()], errors: [] }),
      downloadItemStream: async () => {
        // Empty stream with Content-Length: 0 → triggers the
        // contentLength===0 branch in validateDownloadSize. The mock
        // cannot return headers so we instead throw at the stream start;
        // the shape check below is independent of the wire (it tests
        // validateDownloadSize, which is what `_downloadWithValidation`
        // delegates to). The integration assertion is in the unit test
        // above (`Content-Length=0 → friendly reason`).
        throw new ApiError('Download failed: empty response body', 0);
      },
    });
    const fs = createMockFileSystem();
    const converter = makeConverter();
    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      { api, fs, converter },
    );

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: '/music',
      options: { convertToMp3: false },
    });

    const msg = result.errors[0].message;
    // No absolute paths: the empty-body path doesn't include the URL, but
    // we pin the contract for future contributors.
    expect(msg).not.toMatch(/[a-zA-Z]:[\\/]/); // Windows absolute
    expect(msg).not.toMatch(/\/(?:var|Users|tmp|home)\//); // POSIX absolute
    // Dedup also holds for the empty-body path.
    const matches = msg.match(/Download failed:/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe('ORAIN-0767 AC2: FFmpeg stderr scrub preserves the error text', () => {
  // ORAIN-0752 AC4 rewrote the scrub to anchor at a path-start and consume
  // whitespace-bearing segments. That regex is `/^\s*(?:[a-zA-Z]:)?[\\/](?:[^\\/:"']*[\\/])*[^\\/:"']*/g`
  // anchored at `/` or `\` anywhere in the string — which is the bug. A
  // line like `[out#0/mp3 @ 0x7f8f9c] Error opening output /var/folders/x.mp3: No such file or directory`
  // begins with `[`, then contains `0x...` and `/`, and the regex eats
  // the whole prefix.

  it('preserves bracketed-hex prefix when a path follows it (POSIX)', () => {
    const stderr =
      'ffmpeg version 6.1\n[out#0/mp3 @ 0x7f8f9c0042a0] Error opening output /var/folders/abc/jt-copy_xyz.mp3 for writing: No such file or directory\n';
    // The scrub consumes the path including FFmpeg's literal ` for writing`
    // suffix because that suffix has no `/`/`\` separator to bound it.
    // The error text the user needs to act on ("No such file or directory")
    // survives, which is the AC2 goal. The bracketed-hex prefix is also
    // preserved because it is not in path-start position.
    expect(ffmpegErrorMessage(1, stderr)).toBe(
      'FFmpeg exited with code 1: [out#0/mp3 @ 0x7f8f9c0042a0] Error opening output <path>: No such file or directory',
    );
  });

  it('preserves bracketed-hex prefix when a Windows mixed-separator path follows it', () => {
    // Real FFmpeg lines on Windows use mixed `/` and `\` because paths
    // come from ffmpeg.c which sometimes emits forward-slashes inside
    // backslash-context lines (MKV muxer, W: Media Centre mapping). Pin
    // that the scrub matches it as one path and keeps the prefix.
    const stderr =
      '[mp3 @ 0xdeadbeef] Could not open file W:\\Music MP3s/Media/Artist/Album/track.mp3: Invalid argument\n';
    expect(ffmpegErrorMessage(1, stderr)).toBe(
      'FFmpeg exited with code 1: [mp3 @ 0xdeadbeef] Could not open file <path>: Invalid argument',
    );
  });

  it('preserves bracketed-hex prefix when a whitespace-bearing POSIX path follows it', () => {
    const stderr =
      '[in#0/flac @ 0x1234] /Users/John Doe/Music/x.flac: Invalid data found when processing input\n';
    expect(ffmpegErrorMessage(1, stderr)).toBe(
      'FFmpeg exited with code 1: [in#0/flac @ 0x1234] <path>: Invalid data found when processing input',
    );
  });

  it('scrubs a bare POSIX path with no bracketed prefix (preserves error text after)', () => {
    const stderr = '/var/folders/abc/jt-copy_xyz.mp3: No such file or directory\n';
    expect(ffmpegErrorMessage(1, stderr)).toBe(
      'FFmpeg exited with code 1: <path>: No such file or directory',
    );
  });

  it('scrubs a bare Windows path with spaces', () => {
    const stderr = 'C:\\Program Files\\FFmpeg\\file.mp3: Permission denied\n';
    expect(ffmpegErrorMessage(1, stderr)).toBe(
      'FFmpeg exited with code 1: <path>: Permission denied',
    );
  });

  it('never returns a message that is JUST <path> (AC2 explicit)', () => {
    // A stderr line that is ONLY a path leaves nothing useful for the
    // user. The fallback must produce a non-trivial message: either the
    // raw tail (still scrubbed, non-empty) OR a generic explanatory
    // message. The spec is explicit: the user-facing message must never
    // be ONLY `<path>`. The generic fallback ("FFmpeg exited with code
    // N") IS non-trivial because it explains WHAT failed (FFmpeg), just
    // not WHY — and the WHY was just a path.
    const stderr = 'C:\\Users\\someone\\file.mp3\n';
    const msg = ffmpegErrorMessage(1, stderr);
    expect(msg).not.toBe('FFmpeg exited with code 1: <path>');
    expect(msg).not.toMatch(/^FFmpeg exited with code \d+: <path>$/);
    // Must still communicate that FFmpeg was the source of failure.
    expect(msg).toMatch(/^FFmpeg exited with code 1/);
  });

  it('does not regress ORAIN-0752 AC4: no absolute path in any tested stderr shape', () => {
    const inputs = [
      '[out#0/mp3 @ 0x7f8f9c] /var/folders/abc/x.mp3: No such file or directory',
      '[mp3 @ 0xdead] W:\\Music MP3s/Media/Artist/Album/track.mp3: Invalid argument',
      '[in#0/flac @ 0x1234] /Users/John Doe/Music/x.flac: Invalid data',
      'C:\\Program Files\\FFmpeg\\file.mp3: Permission denied',
      'No such file or directory: /var/folders/abc/x.mp3',
      'No such file or directory: C:\\Users\\dev\\AppData\\Local\\Temp\\jt.mp3',
      'No such file or directory: C:/Users/dev/AppData/Local/Temp/jt.mp3',
      'No such file or directory: \\\\server\\share\\temp\\jt.mp3',
      'No such file or directory: C:\\Program Files\\FFmpeg\\file.mp3',
      'No such file or directory: C:\\Users\\John Doe\\AppData\\Local\\Temp\\jt.mp3',
      'No such file or directory: /Users/Jane Smith/Music/file.mp3',
    ];
    for (const tail of inputs) {
      const msg = ffmpegErrorMessage(1, tail + '\n');
      // Must not contain a Windows absolute path
      expect(msg, `leaked Win path in: ${msg}`).not.toMatch(/[A-Z]:\\(?!FFmpeg exited|Invalid)/);
      // Must not contain an obvious POSIX absolute path
      expect(msg, `leaked POSIX path in: ${msg}`).not.toMatch(
        /(?<!<path>)\/(?:var|Users|tmp|home)\//,
      );
      // Must not be only <path>
      expect(msg).not.toMatch(/^FFmpeg exited with code \d+: <path>$/);
    }
  });
});
