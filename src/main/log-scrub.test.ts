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
