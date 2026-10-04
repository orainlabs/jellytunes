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
// ORAIN-0770 AC5: the [server-info] line is captured into the
// "Last sync" block right above the [sync-start] line, so support
// reads the server totals immediately before the sync they describe.
const SERVER_INFO_TAG = '[server-info]';
// ORAIN-0770 AC5: when no [server-info] line precedes the chosen
// [sync-start], the body shows this literal so support can tell a
// missing-line from a successful empty payload.
const SERVER_INFO_UNKNOWN = 'server-info: unknown';

/**
 * Scrub the user's home directory out of ANY occurrence inside a full log
 * line, not just a leading one. `scrubPath` in `./log-scrub` anchors the
 * match to the start of the string (`^home`), which fits its original
 * callers — it scrubs a standalone path before formatting a log line. Here
 * the home directory is embedded mid-line (e.g. `cause=/Users/alice/Music/x
 * .flac not found`), so we need a global, non-anchored replace instead.
 *
 * The trailing-context lookahead matches anything that cannot be part of
 * the path token: path separators, end-of-string, whitespace, or the
 * start of another key=value pair. This is a slightly looser contract
 * than `scrubPath` (which only requires a separator or EOL) — same
 * family of behaviour, but covers legacy unformatted lines such as
 * `Copying from /Users/alice to /dest`, where the home is followed by
 * a space (cycle 2 MEDIUM).
 */
function scrubLine(line: string): string {
  const home = os.homedir();
  if (!home) return line;
  const escaped = home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return line.replace(new RegExp(`${escaped}(?=[/\\\\=\\s]|$)`, 'g'), '~');
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
 * Returns `{ lines, hasEnd, serverInfoLine }`. `hasEnd` is `true` iff
 * a [sync-end] for the chosen syncId was found inside the slice; the
 * body builder uses it to decide whether to append `(sync did not
 * finish)`. `serverInfoLine` is either the most recent [server-info]
 * line that PRECEDED the chosen [sync-start], or `null` when no such
 * line exists in the log (log rotated out, never emitted, etc.).
 *
 * ORAIN-0770 AC5: the [server-info] line is the only sync-context
 * line we look for BEFORE the [sync-start] (everything before is
 * historical noise). We walk backwards from the [sync-start] position
 * and stop at the first [server-info] we see — that is, by
 * construction, the most recent one.
 */
export function extractLastSyncBlock(logLines: string[]): {
  lines: string[];
  hasEnd: boolean;
  serverInfoLine: string | null;
} {
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
  if (startIdx === -1) {
    return { lines: [], hasEnd: false, serverInfoLine: null };
  }

  // ORAIN-0770 AC5: walk backwards from startIdx-1 and pick the FIRST
  // [server-info] line we see. The first hit is the most recent one
  // because we are walking towards the start of the log.
  let serverInfoLine: string | null = null;
  for (let i = startIdx - 1; i >= 0; i--) {
    const line = logLines[i];
    if (line.includes(SERVER_INFO_TAG)) {
      serverInfoLine = scrubLine(line);
      break;
    }
  }

  const collected: string[] = [];
  let hasEnd = false;
  for (let i = startIdx; i < logLines.length; i++) {
    const line = logLines[i];
    if (i === startIdx) {
      collected.push(scrubLine(line));
      continue;
    }
    // Compare on the EXACT extracted syncId, not a substring of the
    // raw line. With short ids like `abc` a literal
    // `line.includes('syncId=abc')` check would also match a longer
    // id `abcdef` (cycle 2 MEDIUM). The entropy of UUID-derived ids
    // makes the production collision astronomically unlikely, but
    // correctness shouldn't depend on it.
    const lineSyncId = parseSyncId(line);
    const isOurSyncId = lineSyncId !== null && lineSyncId === startSyncId;
    // Stop scanning as soon as we see a [sync-end] for our syncId —
    // any later line belongs to a different sync (or background noise)
    // and would only dilute the body.
    if (isOurSyncId && line.includes(SYNC_END_TAG)) {
      collected.push(scrubLine(line));
      hasEnd = true;
      break;
    }
    // [track-failed] (and only [track-failed]) for our syncId. Other
    // log lines — [info], [warn], [error] — that appear inside the
    // sync window are deliberately excluded: they are volume-detection
    // noise, ffmpeg chatter, etc., and AC1 says only sync-* lines go
    // into the Last sync block.
    if (isOurSyncId && line.includes(TRACK_FAILED_TAG)) {
      collected.push(scrubLine(line));
    }
  }

  // ORAIN-0770 AC5: surface the captured [server-info] line as the
  // FIRST entry of `lines` (when present) so `buildBugReportBody` can
  // iterate `lines` and preserve the natural order: server-info,
  // sync-start, ..., sync-end. The line is scrubbed via scrubLine
  // already (see above) so legacy home-directory leaks are
  // automatically redacted.
  if (serverInfoLine !== null) {
    collected.unshift(serverInfoLine);
  }

  return { lines: collected, hasEnd, serverInfoLine };
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
 * Dedup is performed against the SCRUBBED form of every log line, not
 * the raw one, because `extractLastSyncBlock` scrubs each sync line
 * before pushing it. Comparing raw identity would let a legacy log
 * line carrying `/Users/alice` slip through: it lives in the sync
 * block as `~/...` but in `logLines` as `/Users/alice`, so a Set
 * check on the raw form never matches and the same physical entry
 * ends up under both sections (violating AC3).
 */
export function pickRecentOtherErrors(logLines: string[], syncLines: string[], max = 10): string[] {
  const syncSet = new Set(syncLines);
  const candidates: string[] = [];
  for (const line of logLines) {
    if (!line.includes('[error]') && !line.includes('[warn]')) continue;
    if (syncSet.has(scrubLine(line))) continue;
    candidates.push(scrubLine(line));
  }
  return candidates.slice(-max);
}

const NO_SYNC_NOTE = '(no sync in current log)';
const SYNC_DID_NOT_FINISH_NOTE = '(sync did not finish)';
const TRUNCATION_NOTE_PREFIX = '… and ';
const TRUNCATION_NOTE_SUFFIX =
  ' more failed tracks — please attach main.log (About > Log files > Open folder)';

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
export function buildBugReportBody(
  logContent: string,
  options: { logMissing?: boolean } = {},
): string {
  const logLines = logContent.split('\n').filter((l) => l.length > 0);
  const { lines: syncLines, hasEnd, serverInfoLine } = extractLastSyncBlock(logLines);
  const otherLines = pickRecentOtherErrors(logLines, syncLines);

  const excerptBudget = URL_BUDGET - BOILERPLATE.length - HANDLER_RESERVE;

  const excerpt = renderExcerpt({
    syncLines,
    hasEnd,
    serverInfoLine,
    otherLines,
    logMissing: options.logMissing === true,
    budget: excerptBudget,
  });

  return BOILERPLATE.replace('<EXCERPT>', excerpt);
}

interface RenderArgs {
  syncLines: string[];
  hasEnd: boolean;
  // ORAIN-0770 AC5: most recent [server-info] line that preceded the
  // chosen [sync-start], or null when no such line was found in the
  // log. When present, the body builder prepends it to the "Last sync"
  // section so support reads the server totals immediately before the
  // sync they describe. When null, the body shows
  // `server-info: unknown` so the gap is visible rather than silent.
  serverInfoLine: string | null;
  otherLines: string[];
  logMissing: boolean;
  budget: number;
}

const LOG_MISSING_NOTE =
  '(log file not found — please attach main.log from About > Log files > Open folder)';

function renderExcerpt({
  syncLines,
  hasEnd,
  serverInfoLine,
  otherLines,
  logMissing,
  budget,
}: RenderArgs): string {
  const sections: string[] = [];

  // ORAIN-0747 cycle 2 (HIGH): surface the missing-log condition INSIDE
  // the excerpt (not as a body prefix in the handler) so it consumes
  // budget the same way every other section does, instead of silently
  // pushing the final URL past GitHub's ceiling.
  if (logMissing) {
    sections.push(LOG_MISSING_NOTE);
  }

  if (syncLines.length > 0) {
    const header = '**Last sync**';
    const tail = hasEnd ? '' : `\n${SYNC_DID_NOT_FINISH_NOTE}`;
    // ORAIN-0770 AC5: `extractLastSyncBlock` already places the
    // [server-info] line at index 0 of `syncLines` when it was found
    // in the log. When no [server-info] precedes the [sync-start], we
    // surface the literal `server-info: unknown` so support sees the
    // gap rather than reading silence and assuming it is OK.
    const syncBodyLines = serverInfoLine !== null ? syncLines : [SERVER_INFO_UNKNOWN, ...syncLines];
    // The excerpt budget is for the WHOLE excerpt (both sections). We
    // reserve a minimum for the "Other recent errors" section so it is
    // never silently dropped, then split the rest. The [server-info]
    // line is part of the "Last sync" section and consumes syncBudget.
    const otherReserve = otherLines.length > 0 ? Math.min(budget / 4, otherLines.length * 200) : 0;
    const syncBudget = Math.max(50, budget - otherReserve - tail.length - header.length - 2);
    const syncBody = trimSyncBlock(syncBodyLines, syncBudget);
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
 * Trim a sync block to fit a byte budget, preserving the start marker
 * always, the end marker when present, and as many [track-failed]
 * lines as fit. When middle lines have to be dropped, append a single
 * truncation note that names the exact number omitted (AC2).
 *
 * Sync block shapes we have to support:
 *   - [start, ...failures, end]            — finished sync
 *   - [start, ...failures]                 — sync did not finish (no end)
 *   - [start, end]                         — clean sync, zero failures
 *   - [start]                              — empty block (shouldn't happen
 *                                             because the handler always
 *                                             pairs start with at least an
 *                                             end, but defend anyway)
 *
 * `tail` here means the LAST element of `syncLines`, which is either
 * the [sync-end] marker (when the sync finished) or the last
 * [track-failed] (when it didn't). Both are part of the block we want
 * to surface; only the literal "[sync-end]" tag earns the special
 * `isEndLine` cost — non-end tails are middle-line-equivalent for
 * budget purposes.
 */
function trimSyncBlock(syncLines: string[], budget: number): string {
  if (syncLines.length === 0) return '';

  // Always pass through the budget check, even for a single line: an
  // unusually long [sync-start] (legacy + a giant `dest=` path) could
  // otherwise overshoot the URL ceiling (MEDIUM #5).
  if (syncLines.length === 1) return trimToLength(syncLines[0], budget);

  const head = syncLines[0];
  const tail = syncLines[syncLines.length - 1];
  const isEndLine = tail.includes(SYNC_END_TAG);
  // When there is an end marker, the middle is everything between
  // start and end (failures only). When there is no end marker, the
  // tail itself is a [track-failed] line and belongs with the middle.
  const middle = isEndLine ? syncLines.slice(1, -1) : syncLines.slice(1);

  // Cost = head + (newline+end if end line) + newline+note.
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
