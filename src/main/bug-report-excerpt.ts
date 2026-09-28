/**
 * ORAIN-0747 — pure excerpt builder for the "Report a Bug" body.
 *
 * Extracts the last sync block (start + track failures + end) from
 * main.log, plus a small tail of other recent errors, and trims the
 * result to fit the GitHub issue-body URL budget.
 *
 * No fs or Electron imports: this module operates on log content already
 * read into memory, so it stays fully testable without touching disk.
 */

import * as os from 'node:os';

// Measured 2026-09-28: GitHub accepts a full
// `https://github.com/<org>/<repo>/issues/new?body=<...>` URL up to 7061
// characters (HTTP 302) and rejects 7063 (HTTP 500). 7061 * 0.9 ≈ 6354;
// rounded down to 6300 for extra cushion against org/repo name length and
// other query-string overhead.
export const URL_BUDGET = 6300;

/**
 * The three log-line tags we anchor on. Defined as constants so the
 * matcher is the single source of truth — used both to detect a sync
 * and to identify its sub-lines.
 */
const SYNC_START_TAG = '[sync-start]';
const SYNC_END_TAG = '[sync-end]';
const TRACK_FAILED_TAG = '[track-failed]';

/**
 * Scrub the user's home directory out of ANY occurrence inside a full log
 * line, not just a leading one. `scrubPath` in `./log-scrub` anchors the
 * match to the start of the string (`^home`), which fits its original
 * callers — it scrubs a standalone path before formatting a log line. Here
 * the home directory is embedded mid-line (e.g. `cause=/Users/alice/Music/x
 * .flac not found`), so we need a global, non-anchored replace instead.
 */
function scrubLine(line: string): string {
  const home = os.homedir();
  if (!home) return line;
  const escaped = home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return line.replace(new RegExp(`${escaped}(?=[/\\\\]|$)`, 'g'), '~');
}

/**
 * Find the rightmost [sync-start] line, then collect every following
 * line whose payload contains the same `syncId=…` token, until we
 * either hit a [sync-end] for that syncId or run out of lines.
 *
 * Lines from older syncs that happen to appear AFTER the new
 * [sync-start] (out-of-order writes, buffered transports) are excluded
 * by the syncId filter — see the "stale" test.
 *
 * Each collected line is scrubbed via scrubLine so a legacy line that
 * still contains the user's home directory lands as `~` in the body.
 *
 * Returns `{ lines, hasEnd }`. `hasEnd` is `true` iff a [sync-end] for
 * the chosen syncId was found inside the slice; the body builder uses
 * it to decide whether to append `(sync did not finish)`.
 */
export function extractLastSyncBlock(logLines: string[]): { lines: string[]; hasEnd: boolean } {
  // Find the last line that contains the [sync-start] tag. The body of
  // the line (after the tag) starts with `syncId=<value>` — extract it
  // before scrubLine rewrites the path parts.
  let startIdx = -1;
  let startSyncId = '';
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i];
    if (!line.includes(SYNC_START_TAG)) continue;
    const id = parseSyncId(line);
    if (id === null) continue;
    startIdx = i;
    startSyncId = id;
    break;
  }
  if (startIdx === -1) return { lines: [], hasEnd: false };

  const collected: string[] = [];
  let hasEnd = false;
  for (let i = startIdx; i < logLines.length; i++) {
    const line = logLines[i];
    if (i === startIdx) {
      collected.push(scrubLine(line));
      continue;
    }
    // Stop scanning as soon as we see a [sync-end] for our syncId —
    // any later line belongs to a different sync (or background noise)
    // and would only dilute the body.
    if (line.includes(SYNC_END_TAG) && line.includes(`syncId=${startSyncId}`)) {
      collected.push(scrubLine(line));
      hasEnd = true;
      break;
    }
    // [track-failed] (and only [track-failed]) for our syncId. Other
    // log lines — [info], [warn], [error] — that appear inside the
    // sync window are deliberately excluded: they are volume-detection
    // noise, ffmpeg chatter, etc., and AC1 says only sync-* lines go
    // into the Last sync block.
    if (line.includes(TRACK_FAILED_TAG) && line.includes(`syncId=${startSyncId}`)) {
      collected.push(scrubLine(line));
    }
  }

  return { lines: collected, hasEnd };
}

/**
 * Pull `syncId=<value>` out of a log line. Returns `null` when the
 * line is malformed (no syncId token) so the caller can skip it.
 * Tolerates the duplicated-prefix legacy form `[track-failed]
 * [track-failed] syncId=…` because the regex anchors on the LAST
 * occurrence of `syncId=` — which is always the real one.
 */
function parseSyncId(line: string): string | null {
  const idx = line.lastIndexOf('syncId=');
  if (idx === -1) return null;
  const tail = line.slice(idx + 'syncId='.length);
  // The id is delimited by whitespace OR by another `key=` (start of
  // the next k=v pair). Both shapes appear in the formatter output.
  const end = tail.search(/[\s=]/);
  const value = end === -1 ? tail : tail.slice(0, end);
  return value.length > 0 ? value : null;
}

/**
 * Pick the last `max` log lines that carry `[error]` or `[warn]` and
 * are not part of the sync block we're already reporting under "Last
 * sync". This is the "Other recent errors" tail.
 *
 * We compare raw-line identity (not normalised equality) so a
 * [track-failed] line that lives in the sync block stays there and is
 * not echoed here — duplicating it under both sections would inflate
 * the body and confuse the reader.
 */
export function pickRecentOtherErrors(logLines: string[], syncLines: string[], max = 10): string[] {
  const syncSet = new Set(syncLines);
  const candidates: string[] = [];
  for (const line of logLines) {
    if (!line.includes('[error]') && !line.includes('[warn]')) continue;
    if (syncSet.has(line)) continue;
    candidates.push(scrubLine(line));
  }
  return candidates.slice(-max);
}
