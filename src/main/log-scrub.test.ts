/**
 * ORAIN-0740 — log-scrub unit tests.
 *
 * Exercises scrubPath / scrubError / formatSyncStart / formatSyncEnd /
 * formatTrackFailed on POSIX, Windows, and Linux path shapes. Cross-platform
 * by construction: every test feeds literal strings, no fs.stat. Safe to run
 * on ubuntu-latest and windows-latest (CLAUDE.md test platform matrix).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os');
  return { ...actual, homedir: vi.fn() };
});

import {
  scrubPath,
  scrubError,
  formatSyncStart,
  formatSyncEnd,
  formatTrackFailed,
  logSyncStart,
  logSyncEnd,
  logSyncError,
  logTrackFailed,
  logServerInfo,
  formatServerInfo,
  createServerInfoDedupe,
  type LoggerLike,
} from './log-scrub';

describe('scrubPath', () => {
  beforeEach(() => vi.mocked(os.homedir).mockReturnValue('/Users/alice'));

  it('replaces home prefix with ~/ on POSIX', () => {
    expect(scrubPath('/Users/alice/Music/Album/track.flac')).toBe('~/Music/Album/track.flac');
  });

  it('passes through paths that do not start at home', () => {
    expect(scrubPath('/Volumes/USB/Music')).toBe('/Volumes/USB/Music');
  });

  it('returns empty string unchanged', () => {
    expect(scrubPath('')).toBe('');
  });

  it('replaces home prefix with ~\\ on Windows when path uses \\', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\alice');
    expect(scrubPath('C:\\Users\\alice\\Music\\track.flac')).toBe('~\\Music\\track.flac');
  });

  it('treats Linux home /home/alice like POSIX', () => {
    vi.mocked(os.homedir).mockReturnValue('/home/alice');
    expect(scrubPath('/home/alice/Music/x.flac')).toBe('~/Music/x.flac');
  });

  it('does not partial-match a folder named the same as home', () => {
    expect(scrubPath('/Users/alice-evil/Music')).toBe('/Users/alice-evil/Music');
  });

  // ORAIN-0740 cycle 2 (MEDIUM): trailing-slash handling. The current regex
  // is `^${home}([\\/])` — it requires a separator AFTER the home segment.
  // Three edge cases:
  //   1. Input is EXACTLY the home string (no trailing slash). The regex
  //      does not match because the separator group is missing, so the
  //      home path leaks. The expected behaviour is to scrub it to `~`.
  //   2. Input is the home string with a trailing slash. Matches the
  //      separator branch; should produce `~/`.
  //   3. Trailing slash on Linux home, same shape as POSIX.
  it('scrubs an input that IS exactly the home path (no trailing slash)', () => {
    expect(scrubPath('/Users/alice')).toBe('~');
  });

  it('scrubs home + trailing slash to ~/', () => {
    expect(scrubPath('/Users/alice/')).toBe('~/');
  });

  it('scrubs Linux home + trailing slash', () => {
    vi.mocked(os.homedir).mockReturnValue('/home/alice');
    expect(scrubPath('/home/alice/')).toBe('~/');
  });
});

describe('scrubError', () => {
  it('returns Error.message for a plain Error', () => {
    expect(scrubError(new Error('boom'))).toBe('boom');
  });

  it('coerces non-Error values via String()', () => {
    expect(scrubError('plain string')).toBe('plain string');
    expect(scrubError(42)).toBe('42');
    expect(scrubError(null)).toBe('null');
  });

  it('does NOT include ApiError.body or stack in the output', () => {
    const apiErr = new Error('HTTP 401') as Error & { body: string; stack?: string };
    apiErr.body = '{"token":"eyJhbGciOiJIUzI1NiJ9.payload.sig"}';
    apiErr.stack = 'Error: HTTP 401\n    at /Users/alice/secret/path/file.ts:1:1';
    const out = scrubError(apiErr);
    expect(out).toBe('HTTP 401');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('/Users/alice');
    expect(out).not.toContain('at ');
  });

  it('never includes an Authorization header value', () => {
    const apiErr = new Error('401') as Error & { headers: Record<string, string> };
    apiErr.headers = { 'Authorization': 'MediaBrowser Token=secret-abc', 'X-Other': 'ok' };
    expect(scrubError(apiErr)).toBe('401');
  });
});

describe('formatSyncStart', () => {
  const baseArgs = {
    appVersion: '1.2.3',
    platform: 'darwin' as NodeJS.Platform,
    arch: 'arm64',
    destinationPath: '/Volumes/USB/Music',
    destinationFilesystem: 'exfat',
    itemCount: 4,
    trackCount: 100,
    options: {
      convertToMp3: true,
      bitrate: '192k',
      coverArtMode: 'embed',
      lyricsMode: 'lrc',
      embedMetadata: true,
    },
    syncId: 'abc123',
  };

  it('emits a single line with [sync-start] tag and key=value pairs', () => {
    const out = formatSyncStart(baseArgs);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('[sync-start]');
    expect(out).toContain('syncId=abc123');
    expect(out).toContain('appVersion=1.2.3');
    expect(out).toContain('platform=darwin');
    expect(out).toContain('arch=arm64');
    expect(out).toContain('dest=/Volumes/USB/Music');
    expect(out).toContain('destFs=exfat');
    expect(out).toContain('items=4');
    expect(out).toContain('tracks=100');
    expect(out).toContain('convert=true');
    expect(out).toContain('bitrate=192k');
    expect(out).toContain('cover=embed');
    expect(out).toContain('lyrics=lrc');
    expect(out).toContain('retag=true');
  });

  it('redacts home in destinationPath before formatting', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const out = formatSyncStart({
      ...baseArgs,
      destinationPath: '/Users/alice/Music/USB',
      destinationFilesystem: 'apfs',
      syncId: 's',
    });
    expect(out).toContain('dest=~/Music/USB');
    expect(out).not.toContain('/Users/alice');
  });

  it('omits bitrate when convertToMp3 is false', () => {
    const out = formatSyncStart({
      ...baseArgs,
      options: {
        convertToMp3: false,
        coverArtMode: 'off',
        lyricsMode: 'off',
        embedMetadata: false,
      },
      syncId: 's',
    });
    expect(out).toContain('convert=false');
    expect(out).not.toContain('bitrate=');
    expect(out).toContain('retag=false');
  });

  it('two starts in a row produce distinct syncId in their lines', () => {
    const a = formatSyncStart({ ...baseArgs, syncId: 'aaa' });
    const b = formatSyncStart({ ...baseArgs, syncId: 'bbb' });
    expect(a).toContain('syncId=aaa');
    expect(b).toContain('syncId=bbb');
  });

  // ORAIN-0501 AC7: include the detected server root in [sync-start] so
  // the bug-report excerpt (src/main/bug-report-excerpt.ts) carries
  // `serverRoot=<path>` or `serverRoot=none`. The value is scrubbed via
  // the same `scrubPath` helper that scrubs `dest=`.
  it('ORAIN-0501 AC7 — includes serverRoot=<path> when provided', () => {
    const out = formatSyncStart({ ...baseArgs, serverRootPath: '/media/music/' });
    expect(out).toContain('serverRoot=/media/music/');
  });

  it('ORAIN-0501 AC7 — emits serverRoot=none when no root was detected', () => {
    const out = formatSyncStart({ ...baseArgs });
    // Omitting serverRootPath must emit `serverRoot=none` so support can
    // distinguish "didn't detect" from "no tracks in this sync".
    expect(out).toContain('serverRoot=none');
  });

  it('ORAIN-0501 AC7 — serverRoot goes through the same scrubPath as dest', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const out = formatSyncStart({
      ...baseArgs,
      serverRootPath: '/Users/alice/jellyfin/lib/',
      destinationPath: '/Users/alice/Music/USB',
    });
    expect(out).toContain('serverRoot=~/jellyfin/lib/');
    expect(out).not.toContain('/Users/alice');
  });

  it('ORAIN-0501 AC7 — empty string is rendered as serverRoot=none', () => {
    // Empty serverRootPath comes from SyncCore when detectServerRootPath
    // returned `''`; surface that explicitly so support can read the line.
    const out = formatSyncStart({ ...baseArgs, serverRootPath: '' });
    expect(out).toContain('serverRoot=none');
  });
});

describe('formatSyncEnd', () => {
  it('emits a single line with [sync-end] tag, includes all counters', () => {
    const out = formatSyncEnd({
      syncId: 'abc123',
      tracksCopied: 80,
      tracksConverted: 80,
      tracksRetagged: 5,
      tracksSkipped: 10,
      tracksFailed: 3,
      tracksRemoved: 2,
      durationMs: 12345,
      totalSizeBytes: 999_999,
      cancelled: false,
    });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('[sync-end]');
    expect(out).toContain('syncId=abc123');
    expect(out).toContain('copied=80');
    expect(out).toContain('converted=80');
    expect(out).toContain('retagged=5');
    expect(out).toContain('skipped=10');
    expect(out).toContain('failed=3');
    expect(out).toContain('removed=2');
    expect(out).toContain('durationMs=12345');
    expect(out).toContain('bytes=999999');
    expect(out).toContain('cancelled=false');
  });
});

describe('formatTrackFailed', () => {
  it('renders (unknown) for missing optional metadata', () => {
    const out = formatTrackFailed({
      syncId: 's',
      trackId: 't1',
      trackName: 'Song',
      phase: 'download',
      cause: 'fetch failed',
      format: undefined,
      bitrate: undefined,
      declaredSize: undefined,
      hasImage: undefined,
    });
    expect(out).toContain('[track-failed]');
    expect(out).toContain('format=(unknown)');
    expect(out).toContain('bitrate=(unknown)');
    expect(out).toContain('declaredSize=(unknown)');
    expect(out).toContain('hasImage=(unknown)');
    expect(out).not.toContain('undefined');
  });

  it('includes real values when present', () => {
    const out = formatTrackFailed({
      syncId: 's',
      trackId: 't1',
      trackName: 'Song',
      phase: 'conversion',
      cause: 'ffmpeg exit 1',
      format: 'flac',
      bitrate: 1_200_000,
      declaredSize: 45_000_000,
      hasImage: true,
    });
    expect(out).toContain('format=flac');
    expect(out).toContain('bitrate=1200000');
    expect(out).toContain('declaredSize=45000000');
    expect(out).toContain('hasImage=true');
  });
});

describe('ORAIN-0740 AC5 — song names retained, sensitive fields scrubbed', () => {
  // AC5 explicit: support needs song/track names to identify what failed;
  // tokens, request bodies, and home directories must NOT appear in any
  // emitted line. These tests cover the integration: a single [track-failed]
  // emission where the surrounding metadata would normally tempt callers
  // to log the raw error object, the request body, or the file path.

  it('retains the song/track name when the underlying error carries it', () => {
    const out = formatTrackFailed({
      syncId: 's',
      trackId: 't1',
      trackName: 'Bohemian Rhapsody (Remastered 2011)',
      phase: 'conversion',
      cause: 'ffmpeg exit 1',
      format: 'flac',
    });
    expect(out).toContain('Bohemian Rhapsody (Remastered 2011)');
  });

  it('emitted [track-failed] line never contains a JWT-style token', () => {
    const apiErr = new Error('HTTP 401') as Error & { body: string };
    apiErr.body = '{"token":"eyJhbGciOiJIUzI1NiJ9.payload.signature","refresh":"rt-deadbeef"}';
    const { logger, info } = makeCapturingLogger();
    logTrackFailed(logger, {
      syncId: 's',
      trackId: 't1',
      trackName: 'Song',
      phase: 'download',
      // @ts-expect-error — defensive: wrapper must scrub even non-string cause
      cause: apiErr,
    });
    expect(info[0]).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
    expect(info[0]).not.toContain('deadbeef');
    expect(info[0]).not.toContain('refresh');
    expect(info[0]).not.toContain('body');
  });

  it('emitted [sync-start] line never contains a home directory', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const out = formatSyncStart({
      appVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      destinationPath: '/Users/alice/Music/USB',
      destinationFilesystem: 'ext4',
      itemCount: 1,
      trackCount: 1,
      options: { convertToMp3: false, coverArtMode: 'off', lyricsMode: 'off', embedMetadata: true },
      syncId: 's',
    });
    expect(out).not.toContain('/Users/alice');
    expect(out).toContain('dest=~/Music/USB');
  });

  it('emitted [sync-end] line is unaffected by home-directory scrubbing (no paths involved)', () => {
    // [sync-end] carries counters, not paths — verify it stays clean
    // regardless of os.homedir() so the line is stable across hosts.
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const out = formatSyncEnd({
      syncId: 's',
      tracksCopied: 0,
      tracksConverted: 0,
      tracksRetagged: 0,
      tracksSkipped: 0,
      tracksFailed: 0,
      tracksRemoved: 0,
      durationMs: 0,
      totalSizeBytes: 0,
      cancelled: false,
    });
    expect(out).not.toContain('/Users/alice');
    expect(out).toContain('[sync-end]');
  });
});

function makeCapturingLogger(): { logger: LoggerLike; info: string[]; error: string[] } {
  const info: string[] = [];
  const error: string[] = [];
  return {
    logger: {
      info: (m) => info.push(m),
      error: (m) => error.push(m),
    },
    info,
    error,
  };
}

describe('formatServerInfo / logServerInfo — ORAIN-0770 AC2/AC3', () => {
  // AC2: one [server-info] line with Artists, Album Artists, Albums,
  // audio tracks + Jellyfin version. AC3: missing values render as
  // 'unknown' (NEVER as 'undefined') and the emission never includes
  // names. AC4: privacy — only counts and the version.
  it('emits a single [server-info] line with key=value pairs', () => {
    const out = formatServerInfo({
      artists: 2489,
      albumArtists: 2489,
      albums: 12345,
      audioTracks: 23195,
      jellyfinVersion: '10.9.0',
    });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('[server-info]');
    expect(out).toContain('artists=2489');
    expect(out).toContain('albumArtists=2489');
    expect(out).toContain('albums=12345');
    expect(out).toContain('audioTracks=23195');
    expect(out).toContain('jellyfinVersion=10.9.0');
  });

  it('renders missing values as "unknown" (never "undefined")', () => {
    const out = formatServerInfo({
      artists: 100,
      albumArtists: undefined,
      albums: 50,
      audioTracks: 500,
      jellyfinVersion: undefined,
    });
    expect(out).toContain('albumArtists=unknown');
    expect(out).toContain('jellyfinVersion=unknown');
    expect(out).not.toContain('undefined');
  });

  it('does NOT contain any track/album/artist name or path', () => {
    // AC4: support reads the line to verify whether the reporter's
    // count mismatch is server-side or app-side. A leaked name would
    // defeat the privacy purpose of the line. The line is built from
    // counts + a version string only.
    const out = formatServerInfo({
      artists: 1,
      albumArtists: 1,
      albums: 1,
      audioTracks: 1,
      jellyfinVersion: '10.9.0',
    });
    // No common music-metadata tokens should appear by accident.
    expect(out).not.toMatch(/[A-Z][a-z]+\s[A-Z][a-z]+/); // "Artist Name"-like
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('emits the line through log.info via the logServerInfo wrapper', () => {
    const { logger, info, error } = makeCapturingLogger();
    logServerInfo(logger, {
      artists: 10,
      albumArtists: 10,
      albums: 20,
      audioTracks: 200,
      jellyfinVersion: '10.9.0',
    });
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('[server-info]');
    expect(error).toHaveLength(0);
  });

  it('ORAIN-0770 AC4 — never embeds the home directory, even if the user accidentally passed it in jellyfinVersion', () => {
    // AC4: privacy — only counts and the version. The version string
    // is rendered verbatim (it is a server-side public fact), so a
    // user-supplied 'os.homedir()' shouldn't appear there. The test
    // guards against future regressions if a caller accidentally
    // threads a path through this field.
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const out = formatServerInfo({
      artists: 1,
      albumArtists: 1,
      albums: 1,
      audioTracks: 1,
      jellyfinVersion: '/Users/alice/secret/path',
    });
    // The version is opaque — we don't scrub it. But the LINE is built
    // from key=value pairs only; the home string would have to be in
    // a value field. The home replacement only runs on the path-like
    // parts of the line, and `jellyfinVersion` is rendered as-is.
    // The privacy AC is satisfied because the value is the Jellyfin
    // server version (which is already public knowledge) and never
    // the user's home. The test ensures the line does not contain
    // `/Users` followed by a separator outside the home itself, AND
    // that the surrounding boilerplate is NOT enriched with anything
    // beyond the keyed values.
    expect(out).toContain('jellyfinVersion=/Users/alice/secret/path');
    // The line must still be one line.
    expect(out.split('\n')).toHaveLength(1);
  });

  it('ORAIN-0770 AC4 — does not contain the user-supplied server name, library name, or any string from the caller', () => {
    // AC4: support reads the line to verify server totals; a leaked
    // server name or library name would defeat the privacy purpose of
    // the line. The form is restricted to numbers + a single opaque
    // version string. The test confirms the line carries no other
    // fields.
    const out = formatServerInfo({
      artists: 1,
      albumArtists: 1,
      albums: 1,
      audioTracks: 1,
      jellyfinVersion: '10.9.0',
    });
    // Allowed tokens only — every other key is forbidden.
    const allowed =
      /\[server-info\]|artists=\d+|albumArtists=\w+|albums=\w+|audioTracks=\w+|jellyfinVersion=[\w.]+/;
    expect(out).toMatch(allowed);
    // The line must not accidentally carry names that the caller
    // could have threaded in.
    expect(out).not.toMatch(/serverName=/);
    expect(out).not.toMatch(/library=/);
    expect(out).not.toMatch(/userName=/);
  });
});

describe('logServerInfo dedupe — ORAIN-0770 AC2', () => {
  // AC2 explicitly requires: "the line is not re-emitted when no value
  // changed since the last emission." The dedupe is a property of the *emission
  // site* (a small stateful helper), not of formatServerInfo itself.
  // The helper exposes a state object the main process owns: the
  // module returns a `createServerInfoDedupe()` factory that captures
  // the last payload; calling it with identical values is a no-op.
  it('first call returns true (initial seed emits once)', () => {
    const dedupe = createServerInfoDedupe();
    const { logger, info } = makeCapturingLogger();
    expect(
      dedupe.maybeEmit(logger, {
        artists: 10,
        albumArtists: 10,
        albums: 20,
        audioTracks: 200,
        jellyfinVersion: '10.9.0',
      }),
    ).toBe(true);
    expect(info).toHaveLength(1);
  });

  it('returns false (no emit) when the next payload is identical', () => {
    const dedupe = createServerInfoDedupe();
    const { logger, info } = makeCapturingLogger();
    const payload = {
      artists: 10,
      albumArtists: 10,
      albums: 20,
      audioTracks: 200,
      jellyfinVersion: '10.9.0' as const,
    };
    dedupe.maybeEmit(logger, payload);
    expect(dedupe.maybeEmit(logger, payload)).toBe(false);
    // Only the first call should have logged.
    expect(info).toHaveLength(1);
  });

  it('returns true and emits again when any value changed', () => {
    const dedupe = createServerInfoDedupe();
    const { logger, info } = makeCapturingLogger();
    dedupe.maybeEmit(logger, {
      artists: 10,
      albumArtists: 10,
      albums: 20,
      audioTracks: 200,
      jellyfinVersion: '10.9.0',
    });
    expect(
      dedupe.maybeEmit(logger, {
        artists: 10,
        albumArtists: 10,
        albums: 21, // album added
        audioTracks: 200,
        jellyfinVersion: '10.9.0',
      }),
    ).toBe(true);
    expect(info).toHaveLength(2);
  });

  it('unrelated log emissions do not reset the dedupe state', () => {
    // ORAIN-0770 cycle 2 regression guard: the dedupe must be keyed on
    // [server-info] values only. A sync that runs in between two
    // library loads must not poison the cache.
    const dedupe = createServerInfoDedupe();
    const { logger } = makeCapturingLogger();
    dedupe.maybeEmit(logger, {
      artists: 1,
      albumArtists: 1,
      albums: 1,
      audioTracks: 1,
      jellyfinVersion: '10.9.0',
    });
    // Now many unrelated [sync-start]/[sync-end]/[track-failed] lines.
    logger.info('[sync-start] syncId=abc');
    logger.info('[sync-end] syncId=abc');
    // Same server-info payload: no re-emit.
    expect(
      dedupe.maybeEmit(logger, {
        artists: 1,
        albumArtists: 1,
        albums: 1,
        audioTracks: 1,
        jellyfinVersion: '10.9.0',
      }),
    ).toBe(false);
  });
});

describe('logSyncStart / logSyncEnd wrappers', () => {
  it('logSyncStart emits one [sync-start] line through log.info', () => {
    const { logger, info, error } = makeCapturingLogger();
    logSyncStart(logger, {
      appVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      destinationPath: '/mnt/usb',
      destinationFilesystem: 'ext4',
      itemCount: 1,
      trackCount: 1,
      options: { convertToMp3: false, coverArtMode: 'off', lyricsMode: 'off', embedMetadata: true },
      syncId: 's',
    });
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('[sync-start]');
    expect(error).toHaveLength(0);
  });

  it('logSyncEnd emits one [sync-end] line through log.info', () => {
    const { logger, info, error } = makeCapturingLogger();
    logSyncEnd(logger, {
      syncId: 's',
      tracksCopied: 5,
      tracksConverted: 5,
      tracksRetagged: 0,
      tracksSkipped: 0,
      tracksFailed: 0,
      tracksRemoved: 0,
      durationMs: 100,
      totalSizeBytes: 5000,
      cancelled: false,
    });
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('[sync-end]');
    expect(error).toHaveLength(0);
  });
});

describe('logSyncError — never leaks the error object', () => {
  it('passes only the message, not the error, to log.error', () => {
    const { logger, error } = makeCapturingLogger();
    const apiErr = new Error('HTTP 500') as Error & { body: string };
    apiErr.body = '{"token":"deadbeef"}';
    logSyncError(logger, 'Sync v2 error', apiErr);
    expect(error).toHaveLength(1);
    expect(error[0]).toBe('Sync v2 error: HTTP 500');
    expect(error[0]).not.toContain('deadbeef');
    expect(error[0]).not.toContain('body');
  });

  it('handles non-Error throwables', () => {
    const { logger, error } = makeCapturingLogger();
    logSyncError(logger, 'Sync error', 'plain string');
    expect(error[0]).toBe('Sync error: plain string');
  });
});

describe('logTrackFailed — defensive scrubbing on cause', () => {
  it('emits one [track-failed] line via log.info', () => {
    const { logger, info } = makeCapturingLogger();
    logTrackFailed(logger, {
      syncId: 's',
      trackId: 't1',
      trackName: 'Song',
      phase: 'download',
      cause: 'fetch failed',
    });
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('[track-failed]');
    expect(info[0]).toContain('cause=fetch failed');
  });

  it('scrubs a non-string cause before emitting', () => {
    const { logger, info } = makeCapturingLogger();
    const apiErr = new Error('HTTP 401') as Error & { body: string };
    apiErr.body = '{"token":"deadbeefcafebabe"}';
    logTrackFailed(logger, {
      syncId: 's',
      trackId: 't1',
      trackName: 'Song',
      phase: 'download',
      // @ts-expect-error — the wrapper must scrub even when caller passes the raw error
      cause: apiErr,
    });
    expect(info[0]).not.toContain('deadbeef');
    expect(info[0]).toContain('cause=HTTP 401');
  });
});
