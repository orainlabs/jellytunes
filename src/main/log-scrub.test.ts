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
