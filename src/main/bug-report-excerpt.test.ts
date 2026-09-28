import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { URL_BUDGET, extractLastSyncBlock, pickRecentOtherErrors } from './bug-report-excerpt';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os');
  return { ...actual, homedir: vi.fn() };
});

describe('URL_BUDGET', () => {
  it('stays under the measured GitHub issue-body URL ceiling with margin', () => {
    // Measured 2026-09-28: GitHub accepts a full
    // `https://github.com/<org>/<repo>/issues/new?body=<...>` URL up to 7061
    // characters (HTTP 302) and rejects 7063 (HTTP 500). URL_BUDGET must stay
    // comfortably below that ceiling.
    const measuredCeiling = 7061;
    expect(URL_BUDGET).toBeLessThan(measuredCeiling * 0.9);
    expect(URL_BUDGET).toBe(6300);
  });
});

const wrap = (msg: string, level: 'info' | 'warn' | 'error' = 'info'): string =>
  `[2026-09-28T10:30:15.123Z] [${level}] ${msg}`;

describe('extractLastSyncBlock', () => {
  beforeEach(() => vi.mocked(os.homedir).mockReturnValue('/Users/alice'));

  it('returns empty block when log has no [sync-start]', () => {
    const lines = [wrap('[warn] something else'), wrap('[error] another')];
    expect(extractLastSyncBlock(lines)).toEqual({ lines: [], hasEnd: false });
  });

  it('extracts start + [track-failed] + end for the most recent sync', () => {
    const oldStart = wrap('[sync-start] syncId=old appVersion=0.7.1');
    const oldEnd = wrap('[sync-end] syncId=old copied=1 failed=0');
    const newStart = wrap('[sync-start] syncId=new appVersion=0.7.1');
    const failed = wrap('[track-failed] syncId=new trackName=Track phase=download cause=boom');
    const newEnd = wrap('[sync-end] syncId=new copied=1 failed=1');
    const log = [oldStart, oldEnd, newStart, failed, newEnd];
    const block = extractLastSyncBlock(log);
    expect(block.lines).toHaveLength(3);
    expect(block.lines[0]).toContain('syncId=new');
    expect(block.lines[0]).toContain('[sync-start]');
    expect(block.lines[1]).toContain('[track-failed]');
    expect(block.lines[2]).toContain('[sync-end]');
    expect(block.lines.every((l) => !l.includes('syncId=old'))).toBe(true);
    expect(block.hasEnd).toBe(true);
  });

  it('omits lines from previous syncs even when they appear after the latest start', () => {
    const oldStart = wrap('[sync-start] syncId=old');
    const oldEnd = wrap('[sync-end] syncId=old');
    const newStart = wrap('[sync-start] syncId=new');
    // A stale [track-failed] from the old session appearing AFTER the new
    // [sync-start] must not be included.
    const staleOldFailed = wrap('[track-failed] syncId=old trackName=Z');
    const newEnd = wrap('[sync-end] syncId=new');
    const log = [oldStart, oldEnd, newStart, staleOldFailed, newEnd];
    const block = extractLastSyncBlock(log);
    expect(block.lines).toHaveLength(2);
    expect(block.lines[0]).toContain('syncId=new');
    expect(block.lines[1]).toContain('[sync-end]');
    expect(block.lines.some((l) => l.includes('syncId=old'))).toBe(false);
  });

  it('returns start + all [track-failed] but no end marker when sync did not finish', () => {
    const start = wrap('[sync-start] syncId=aborted appVersion=0.7.1');
    const f1 = wrap('[track-failed] syncId=aborted trackName=A');
    const f2 = wrap('[track-failed] syncId=aborted trackName=B');
    // No [sync-end] follows.
    const log = [start, f1, f2, wrap('[warn] something after the crash')];
    const block = extractLastSyncBlock(log);
    expect(block.lines).toHaveLength(3);
    expect(block.lines.every((l) => l.includes('syncId=aborted'))).toBe(true);
    expect(block.hasEnd).toBe(false);
  });

  it('includes start but NO [track-failed] when a sync had zero failures', () => {
    const start = wrap('[sync-start] syncId=clean appVersion=0.7.1');
    const end = wrap('[sync-end] syncId=clean copied=10 failed=0');
    const block = extractLastSyncBlock([start, end]);
    expect(block.lines).toHaveLength(2);
    expect(block.lines[0]).toContain('[sync-start]');
    expect(block.lines[1]).toContain('[sync-end]');
    expect(block.hasEnd).toBe(true);
  });

  it('strips the home directory from lines that contain it (scrubPath)', () => {
    const start = wrap('[sync-start] syncId=abc appVersion=0.7.1');
    const f1 = wrap(
      '[track-failed] syncId=abc trackName=T phase=download cause=/Users/alice/Music/x.flac not found',
    );
    const log = [start, f1];
    const block = extractLastSyncBlock(log);
    expect(block.lines[1]).not.toContain('/Users/alice');
    expect(block.lines[1]).toContain('~/Music/x.flac');
  });

  it('parses [track-failed] lines that carry the legacy duplicated prefix', () => {
    // NOTICED BUT NOT TOUCHING: production logs sometimes emit
    //   [warn]  [track-failed] [track-failed] syncId=abc ...
    // because the formatTrackFailed string contains its own tag and the
    // wrapper prepends the level tag. The matcher must accept BOTH the
    // canonical `[track-failed] syncId=X` AND the duplicated form.
    const start = wrap('[sync-start] syncId=abc');
    const dup =
      '[2026-09-28T10:30:15.123Z] [warn] [track-failed] [track-failed] syncId=abc trackName=Z phase=download cause=boom';
    const end = wrap('[sync-end] syncId=abc');
    const block = extractLastSyncBlock([start, dup, end]);
    expect(block.lines).toHaveLength(3);
    expect(block.lines[1]).toContain('[track-failed]');
    expect(block.lines[1]).toContain('syncId=abc');
  });
});

describe('pickRecentOtherErrors', () => {
  it('returns last 10 [error]/[warn] lines when no sync lines exist', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`[warn] noise ${i}`);
    const picked = pickRecentOtherErrors(lines, []);
    expect(picked).toHaveLength(10);
    // Must be the LAST 10, in order.
    expect(picked[picked.length - 1]).toBe('[warn] noise 19');
    expect(picked[0]).toBe('[warn] noise 10');
  });

  it('excludes lines that appear inside the sync block', () => {
    const sharedLine = '[warn] [track-failed] syncId=abc trackName=Z';
    const lines = ['[error] earlier failure', sharedLine, '[error] later failure'];
    const syncLines = [sharedLine];
    const picked = pickRecentOtherErrors(lines, syncLines);
    expect(picked).toHaveLength(2);
    expect(picked).toEqual(['[error] earlier failure', '[error] later failure']);
  });

  it('returns at most `max` lines and accepts a custom max', () => {
    const lines = ['[error] a', '[warn] b', '[error] c'];
    expect(pickRecentOtherErrors(lines, [], 2)).toHaveLength(2);
    expect(pickRecentOtherErrors(lines, [], 2)).toEqual(['[warn] b', '[error] c']);
  });

  it('scrubs the home directory from picked lines', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const lines = ['[error] /Users/alice/private/secret leaked somewhere'];
    const picked = pickRecentOtherErrors(lines, []);
    expect(picked[0]).toContain('~/private/secret');
    expect(picked[0]).not.toContain('/Users/alice');
  });
});
