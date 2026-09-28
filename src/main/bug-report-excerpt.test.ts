import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import {
  URL_BUDGET,
  buildBugReportBody,
  extractLastSyncBlock,
  pickRecentOtherErrors,
} from './bug-report-excerpt';

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

  it('does NOT match a longer syncId that has our id as prefix (substring collision)', () => {
    // ORAIN-0747 cycle 2 MEDIUM: with syncIds like `abc` and `abcdef`,
    // a substring `includes('syncId=abc')` check matches BOTH and pulls
    // the abcdef block into the abc sync — corrupting the body. The
    // matcher must compare the extracted syncId for equality.
    const start = wrap('[sync-start] syncId=abc');
    const foreign = wrap('[track-failed] syncId=abcdef trackName=F');
    const end = wrap('[sync-end] syncId=abc');
    const block = extractLastSyncBlock([start, foreign, end]);
    expect(block.lines).toHaveLength(2);
    expect(block.lines[0]).toContain('[sync-start]');
    expect(block.lines[1]).toContain('[sync-end]');
    expect(block.lines.some((l) => l.includes('abcdef'))).toBe(false);
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

  it('excludes a legacy sync line that contains the home directory (scrubbed in sync block, raw in log)', () => {
    // A [track-failed] emitted by an older build may still carry an
    // unscrubbed /Users/alice path. After extractLastSyncBlock the
    // syncLines array holds the SCRUBBED version (with ~). The raw
    // logLine in logLines still contains /Users/alice. The dedup Set
    // built from syncLines must not match the raw line, so the same
    // physical log entry would appear under both sections.
    // The fix must dedup against the SCRUBBED form of logLines too,
    // so the legacy entry is excluded from "Other recent errors".
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const rawLegacyLine =
      '[warn] [track-failed] syncId=abc trackName=Z phase=download cause=/Users/alice/Music/x.flac not found';
    const scrubbedLegacyLine = rawLegacyLine.replace('/Users/alice', '~');
    const lines = ['[error] earlier failure', rawLegacyLine, '[error] later failure'];
    const syncLines = [scrubbedLegacyLine];
    const picked = pickRecentOtherErrors(lines, syncLines);
    expect(picked).toHaveLength(2);
    expect(picked).toEqual(['[error] earlier failure', '[error] later failure']);
    expect(picked.every((l) => !l.includes('/Users/alice'))).toBe(true);
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

  it('scrubs the home directory even when followed by whitespace (defense in depth)', () => {
    // ORAIN-0747 cycle 2 MEDIUM: a legacy unformatted line such as
    // `Copying from /Users/alice to /dest` carries the home as a bare
    // token followed by a space. The original lookahead (?=[/\\\\]|$)
    // only matches a path continuation or end-of-string, so the home
    // leaks through. Defending here costs ~10 lines and the risk in
    // practice (an unformatted line with an embedded home) is
    // already low — but the privacy surface is a public issue, so the
    // defense-in-depth is worth it.
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const lines = ['[error] Copying from /Users/alice to /dest'];
    const picked = pickRecentOtherErrors(lines, []);
    expect(picked[0]).not.toContain('/Users/alice');
    expect(picked[0]).toContain('~');
  });
});

describe('buildBugReportBody', () => {
  it('returns a body with only "no sync in current log" when the log has zero sync starts', () => {
    const log = [
      '[2026-09-28T10:00:00.000Z] [warn] volume detection: nothing yet',
      '[2026-09-28T10:00:01.000Z] [error] /Users/alice/private/x leaked',
    ].join('\n');
    const body = buildBugReportBody(log);
    expect(body).toContain('**Log output**');
    expect(body).toContain('(no sync in current log)');
    expect(body).not.toContain('**Last sync**');
  });

  it('returns a body with a "Last sync" section when a sync exists', () => {
    const start =
      '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc appVersion=0.7.1 dest=/Volumes/USB';
    const end =
      '[2026-09-28T10:00:30.000Z] [info] [sync-end] syncId=abc copied=1 failed=0 durationMs=30000';
    const log = [start, end].join('\n');
    const body = buildBugReportBody(log);
    expect(body).toContain('**Last sync**');
    expect(body).toContain('[sync-start]');
    expect(body).toContain('[sync-end]');
    expect(body).not.toContain('(sync did not finish)');
  });

  it('appends "(sync did not finish)" when the sync lacks [sync-end]', () => {
    const start = '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc';
    const f =
      '[2026-09-28T10:00:05.000Z] [warn] [track-failed] syncId=abc trackName=Z phase=download cause=boom';
    const log = [start, f].join('\n');
    const body = buildBugReportBody(log);
    expect(body).toContain('(sync did not finish)');
  });

  it('keeps start + end and adds the truncation marker when track-failures overflow the budget', () => {
    // Build a sync with 50 track-failed lines; each line is ~400 chars
    // so they overflow URL_BUDGET after start+end. We expect the
    // marker `… and M more failed tracks` to appear with M > 0.
    const start =
      '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc appVersion=0.7.1 platform=darwin arch=arm64 dest=/Volumes/USB destFs=msdos items=50 tracks=50 convert=false cover=embed lyrics=server retag=true';
    const failed = (i: number): string =>
      `[2026-09-28T10:00:${String(5 + (i % 50)).padStart(2, '0')}.000Z] [warn] [track-failed] syncId=abc trackId=t${i} trackName=Track ${i} phase=download cause=HTTP 500 from /Items/t${i}/Download — body said: {"code":"InternalServerError","message":"upstream jellyfin returned 500"} format=flac bitrate=0 declaredSize=12345678 hasImage=false`;
    const end =
      '[2026-09-28T10:00:30.000Z] [info] [sync-end] syncId=abc copied=0 converted=0 retagged=0 skipped=0 failed=50 removed=0 durationMs=30000 bytes=0 cancelled=false';
    const lines = [start, ...Array.from({ length: 50 }, (_, i) => failed(i)), end];
    const body = buildBugReportBody(lines.join('\n'));
    expect(body).toContain('[sync-start]');
    expect(body).toContain('[sync-end]');
    expect(body).toMatch(
      /… and (\d+) more failed tracks — please attach main\.log \(About > Open log folder\)/,
    );
    const m = body.match(/… and (\d+) more/);
    expect(Number(m![1])).toBeGreaterThan(0);
    // Body must fit within budget (we can't test URL length without
    // the prefix; assert body length <= URL_BUDGET - 200 to leave room
    // for the boilerplate + URL prefix).
    expect(body.length).toBeLessThanOrEqual(URL_BUDGET - 200);
  });

  it('includes "Other recent errors" section after the sync block when non-sync warn lines exist', () => {
    const start = '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc';
    const end = '[2026-09-28T10:00:30.000Z] [info] [sync-end] syncId=abc';
    const noise = '[2026-09-28T10:01:00.000Z] [warn] volume detection: nothing';
    const body = buildBugReportBody([start, end, noise].join('\n'));
    expect(body).toContain('**Last sync**');
    expect(body).toContain('**Other recent errors**');
    expect(body).toContain('volume detection: nothing');
  });

  it('scrubs the home directory inside the Last sync block (legacy lines)', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    const start = '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc';
    const f =
      '[2026-09-28T10:00:05.000Z] [warn] [track-failed] syncId=abc trackName=Z phase=download cause=/Users/alice/Music/x.flac not found';
    const body = buildBugReportBody([start, f].join('\n'));
    expect(body).not.toContain('/Users/alice');
    expect(body).toContain('~/Music/x.flac');
  });

  it('body never exceeds URL_BUDGET chars even when log is huge', () => {
    const start = '[2026-09-28T10:00:00.000Z] [info] [sync-start] syncId=abc';
    const failed = (i: number): string =>
      `[warn] [track-failed] syncId=abc trackId=t${i} trackName=Track ${i} phase=download cause=HTTP 500 with a long error message ${'x'.repeat(200)}`;
    const end = '[2026-09-28T10:00:30.000Z] [info] [sync-end] syncId=abc';
    const lines = [start, ...Array.from({ length: 200 }, (_, i) => failed(i)), end];
    const body = buildBugReportBody(lines.join('\n'));
    expect(body.length).toBeLessThanOrEqual(URL_BUDGET - 200);
  });

  it('renders the full boilerplate when log content is empty (handler called with missing log file)', () => {
    // ORAIN-0747 cycle 2 HIGH: when electron-log has not written
    // main.log yet (first run, early crash, etc.) the handler used to
    // return '(log file not found)' as the literal body, stripping
    // the boilerplate. The builder must still emit the boilerplate so
    // the issue template is usable, plus an explicit notice inside
    // the excerpt.
    const body = buildBugReportBody('', { logMissing: true });
    expect(body).toContain('**Describe the bug**');
    expect(body).toContain('**To Reproduce**');
    expect(body).toContain('**Desktop (please complete the following information):**');
    expect(body).toContain('(log file not found');
    expect(body).toContain('(no sync in current log)');
    // Empty log is a tiny body — it must still fit the budget.
    expect(body.length).toBeLessThanOrEqual(URL_BUDGET - 200);
  });

  it('omits the log-missing notice when the log content is present', () => {
    const log = '[2026-09-28T10:00:00.000Z] [warn] something\n';
    const body = buildBugReportBody(log, { logMissing: false });
    expect(body).not.toContain('(log file not found');
  });
});
