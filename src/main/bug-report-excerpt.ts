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

const NO_SYNC_NOTE = '(no sync in current log)';
const SYNC_DID_NOT_FINISH_NOTE = '(sync did not finish)';
const TRUNCATION_NOTE_PREFIX = '… and ';
const TRUNCATION_NOTE_SUFFIX =
  ' more failed tracks — please attach main.log (About > Open log folder)';

/**
 * The fixed boilerplate that wraps the log excerpt. Mirrors the
 * existing `bug:report` handler body template in `src/main/index.ts`.
 * We render the full body inside this module so the URL budget is
 * enforced against the final markdown, and the handler only has to
 * pass `logContent` and trust the result.
 */
const BOILERPLATE_LINES: ReadonlyArray<string> = [
  '**Describe the bug**',
  'A clear and concise description of what the bug is.',
  '',
  '**To Reproduce**',
  'Steps to reproduce the behavior:',
  "1. Go to '...'",
  "2. Click on '...'",
  '3. See error',
  '',
  '**Expected behavior**',
  'A clear and concise description of what you expected to happen.',
  '',
  '**Screenshots**',
  'If applicable, add screenshots to help explain your problem.',
  '',
  '**Desktop (please complete the following information):**',
  ' - OS: <filled by handler>',
  ' - JellyTunes version: <filled by handler>',
  ' - Jellyfin server version: [e.g. 10.9.0]',
  '',
  '**Log output**',
  '```',
  '<EXCERPT>',
  '```',
  '',
  '**Additional context**',
  'Add any other context about the problem here.',
];

const BOILERPLATE = BOILERPLATE_LINES.join('\n');
const HANDLER_RESERVE = 200; // chars reserved for OS/version lines the handler appends

/**
 * Compose the bug-report body. Steps:
 *   1. Split the log into lines.
 *   2. Extract the last sync block (start + track-failures + end).
 *   3. Collect non-sync error/warn lines.
 *   4. Render the two sections inside an excerpt string.
 *   5. If the assembled excerpt exceeds the per-section budget, shrink
 *      the [track-failed] tail first (preserving start + end + the
 *      truncation note), then shrink the "Other recent errors" tail.
 *
 * URL_BUDGET is enforced on the assembled body, NOT on the encoded URL
 * — encoding growth is uniform (each reserved char becomes %XX), so if
 * the body fits, the URL fits too.
 */
export function buildBugReportBody(logContent: string): string {
  const logLines = logContent.split('\n').filter((l) => l.length > 0);
  const { lines: syncLines, hasEnd } = extractLastSyncBlock(logLines);
  const otherLines = pickRecentOtherErrors(logLines, syncLines);

  const excerptBudget = URL_BUDGET - BOILERPLATE.length - HANDLER_RESERVE;

  const excerpt = renderExcerpt({
    syncLines,
    hasEnd,
    otherLines,
    budget: excerptBudget,
  });

  return BOILERPLATE.replace('<EXCERPT>', excerpt);
}

interface RenderArgs {
  syncLines: string[];
  hasEnd: boolean;
  otherLines: string[];
  budget: number;
}

function renderExcerpt({ syncLines, hasEnd, otherLines, budget }: RenderArgs): string {
  const sections: string[] = [];

  if (syncLines.length > 0) {
    const header = '**Last sync**';
    const tail = hasEnd ? '' : `\n${SYNC_DID_NOT_FINISH_NOTE}`;
    // The excerpt budget is for the WHOLE excerpt (both sections). We
    // reserve a minimum for the "Other recent errors" section so it is
    // never silently dropped, then split the rest.
    const otherReserve = otherLines.length > 0 ? Math.min(budget / 4, otherLines.length * 200) : 0;
    const syncBudget = Math.max(50, budget - otherReserve - tail.length - header.length - 2);
    const syncBody = trimSyncBlock(syncLines, syncBudget);
    sections.push(`${header}\n${syncBody}${tail}`);
  } else {
    sections.push(NO_SYNC_NOTE);
  }

  if (otherLines.length > 0) {
    const otherHeader = '**Other recent errors**';
    const remaining = Math.max(0, budget - sections[0].length - otherHeader.length - 2);
    const otherBody = trimOtherErrors(otherLines, remaining);
    if (otherBody.length > 0) {
      sections.push(`${otherHeader}\n${otherBody}`);
    }
  }

  let joined = sections.join('\n\n');
  // Belt-and-braces: if we still overshot (rare — only when otherLines
  // is huge), drop the tail of the "Other recent errors" section
  // line-by-line until the budget is met.
  if (joined.length > budget) joined = trimToLength(joined, budget);
  return joined;
}

/**
 * Trim a sync block to fit a byte budget, preserving the start + end
 * markers and as many [track-failed] lines as fit. When lines have to
 * be dropped, append a single truncation note that names the exact
 * number omitted (AC2).
 */
function trimSyncBlock(syncLines: string[], budget: number): string {
  if (syncLines.length === 0) return '';
  if (syncLines.length === 1) return syncLines[0];

  const head = syncLines[0];
  const tail = syncLines[syncLines.length - 1];
  const isEndLine = tail.includes(SYNC_END_TAG);
  const middle = syncLines.slice(1, -1);

  // Cost = head + (newline+tail if end line) + newline+note.
  const noteFor = (omitted: number): string =>
    `${TRUNCATION_NOTE_PREFIX}${omitted}${TRUNCATION_NOTE_SUFFIX}`;
  const headCost = head.length + 1; // newline after head
  const tailCost = isEndLine ? tail.length + 1 : 0;

  // Try to fit: head + (kept middle lines) + tail + note.
  const kept: string[] = [];
  for (const line of middle) {
    const cost = line.length + 1;
    if (
      headCost +
        tailCost +
        kept.reduce((s, l) => s + l.length + 1, 0) +
        cost +
        noteFor(middle.length - kept.length - 1).length >
      budget
    ) {
      break;
    }
    kept.push(line);
  }
  const omitted = middle.length - kept.length;
  const parts = [head];
  for (const line of kept) parts.push(line);
  if (isEndLine) parts.push(tail);
  if (omitted > 0) parts.push(noteFor(omitted));

  const joined = parts.join('\n');
  if (joined.length <= budget) return joined;

  // Could not fit head + at least one middle + tail + note. Fallback
  // to head + tail + note (drop ALL middle).
  const minimal = isEndLine
    ? [head, tail, noteFor(middle.length)].join('\n')
    : [head, noteFor(middle.length)].join('\n');
  if (minimal.length <= budget) return minimal;

  // Even head + end + note does not fit. Drop end (AC2 says start is
  // the only must-keep; end and note are sacrificed in the worst case).
  const headOnlyWithNote = [head, noteFor(middle.length + (isEndLine ? 1 : 0))].join('\n');
  if (headOnlyWithNote.length <= budget) return headOnlyWithNote;

  // Absolute last resort: just the head.
  return head.length <= budget ? head : head.slice(0, budget);
}

/**
 * Trim the "Other recent errors" list to a byte budget by dropping
 * lines from the head (oldest first). The tail is the most recent and
 * most useful, so we keep it.
 */
function trimOtherErrors(otherLines: string[], budget: number): string {
  if (budget <= 0 || otherLines.length === 0) return '';
  let joined = otherLines.join('\n');
  if (joined.length <= budget) return joined;
  // Drop lines from the front until it fits.
  let start = 0;
  while (joined.length > budget && start < otherLines.length - 1) {
    start++;
    joined = otherLines.slice(start).join('\n');
  }
  if (joined.length > budget) joined = trimToLength(joined, budget);
  return joined;
}

/**
 * Right-trim a string to `max` chars. If the cut lands mid-line, drop
 * the partial line so we never emit half a log entry.
 */
function trimToLength(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline === -1 ? cut : cut.slice(0, lastNewline);
}
