/**
 * ORAIN-0740 — log scrubber for support-friendly main.log.
 *
 * Four responsibilities:
 * 1. Redact the user home directory out of any path before it reaches the logger.
 * 2. Flatten error objects to their `.message` — never leak bodies, headers, or
 *    stack frames with the user's name in them.
 * 3. Format the three support-friendly sync log lines ([sync-start], [sync-end],
 *    [track-failed]) into single lines that a grep can parse and a paste into a
 *    public issue does not leak.
 * 4. Wrap those formatters behind a small `logSync*` interface so callers
 *    pass a logger object and never have to remember to scrub-error the
 *    exception object — the wrapper does it.
 *
 * Pure functions; no Electron deps. Safe to unit-test on any platform.
 */
import * as os from 'node:os';

type SyncPhase = 'download' | 'validation' | 'conversion' | 'tagging' | 'write';

/**
 * Scrub the home directory out of an absolute path. The replacement preserves
 * the original separator so POSIX paths get '~/...' and Windows paths get
 * '~\...'. Empty input is returned unchanged. Paths that do not begin at the
 * home dir are returned unchanged — including folder names that merely start
 * with the home string (e.g. '/Users/alice-evil' when home is '/Users/alice').
 */
export function scrubPath(input: string): string {
  if (!input) return input;
  const home = os.homedir();
  if (!home) return input;
  const escaped = home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const re = new RegExp(`^${escaped}([\\\\/])`);
  return input.replace(re, (full) => `~${full.slice(home.length)}`);
}

/**
 * Flatten an error to its `.message`. Non-Error values are coerced via
 * `String(x)`. The output NEVER includes `error.body`, `error.headers`,
 * `error.stack`, or any other field that could leak a token, path, or
 * server-internal detail.
 */
export function scrubError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  return String(err);
}

interface FormatOptions {
  convertToMp3: boolean;
  bitrate?: string;
  coverArtMode: string;
  lyricsMode: string;
  embedMetadata: boolean;
}

/**
 * Format one [sync-start] line. The destinationPath is scrubbed before
 * formatting. bitrate= is only emitted when conversion is enabled.
 */
export function formatSyncStart(input: {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  destinationPath: string;
  destinationFilesystem: string;
  itemCount: number;
  trackCount: number;
  options: FormatOptions;
  syncId: string;
}): string {
  const dest = scrubPath(input.destinationPath);
  const parts: string[] = [
    `[sync-start] syncId=${input.syncId}`,
    `appVersion=${input.appVersion}`,
    `platform=${input.platform}`,
    `arch=${input.arch}`,
    `dest=${dest}`,
    `destFs=${input.destinationFilesystem}`,
    `items=${input.itemCount}`,
    `tracks=${input.trackCount}`,
    `convert=${input.options.convertToMp3}`,
  ];
  if (input.options.convertToMp3 && input.options.bitrate) {
    parts.push(`bitrate=${input.options.bitrate}`);
  }
  parts.push(
    `cover=${input.options.coverArtMode}`,
    `lyrics=${input.options.lyricsMode}`,
    `retag=${input.options.embedMetadata}`,
  );
  return parts.join(' ');
}

/**
 * Format one [sync-end] line. `totalSizeBytes` is the post-sync destination
 * counter from ORAIN-0738 (NOT the size estimate or sum of track.size).
 */
export function formatSyncEnd(input: {
  syncId: string;
  tracksCopied: number;
  tracksConverted: number;
  tracksRetagged: number;
  tracksSkipped: number;
  tracksFailed: number;
  tracksRemoved: number;
  durationMs: number;
  totalSizeBytes: number;
  cancelled: boolean;
}): string {
  return [
    `[sync-end] syncId=${input.syncId}`,
    `copied=${input.tracksCopied}`,
    `converted=${input.tracksConverted}`,
    `retagged=${input.tracksRetagged}`,
    `skipped=${input.tracksSkipped}`,
    `failed=${input.tracksFailed}`,
    `removed=${input.tracksRemoved}`,
    `durationMs=${input.durationMs}`,
    `bytes=${input.totalSizeBytes}`,
    `cancelled=${input.cancelled}`,
  ].join(' ');
}

const fmtOptional = (v: string | number | boolean | undefined): string =>
  v === undefined || v === null ? '(unknown)' : String(v);

/**
 * Format one [track-failed] line. Missing optional metadata renders as
 * '(unknown)' (never 'undefined'). `cause` is the already-scrubbed error
 * message — callers MUST run `scrubError` first.
 */
export function formatTrackFailed(input: {
  syncId: string;
  trackId: string;
  trackName: string;
  phase: SyncPhase | 'unknown';
  cause: string;
  format?: string;
  bitrate?: number;
  declaredSize?: number;
  hasImage?: boolean;
}): string {
  return [
    '[track-failed]',
    `syncId=${input.syncId}`,
    `trackId=${input.trackId}`,
    `trackName=${input.trackName}`,
    `phase=${input.phase}`,
    `cause=${input.cause}`,
    `format=${fmtOptional(input.format)}`,
    `bitrate=${fmtOptional(input.bitrate)}`,
    `declaredSize=${fmtOptional(input.declaredSize)}`,
    `hasImage=${fmtOptional(input.hasImage)}`,
  ].join(' ');
}

/**
 * Minimal logger surface the wrappers need. Matches electron-log's
 * `log.info(msg)` / `log.error(msg)` signature so the existing
 * electron-log instance plugs in directly.
 */
export interface LoggerLike {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Emit a [sync-start] line. `syncId` is generated by the caller — the
 * wrapper does not invent one because the same id is reused for
 * [track-failed] and [sync-end] in the same sync.
 */
export function logSyncStart(log: LoggerLike, args: Parameters<typeof formatSyncStart>[0]): void {
  log.info(formatSyncStart(args));
}

/**
 * Emit a [sync-end] line.
 */
export function logSyncEnd(log: LoggerLike, args: Parameters<typeof formatSyncEnd>[0]): void {
  log.info(formatSyncEnd(args));
}

/**
 * Emit a single error line that wraps the error message but NOT the
 * error object. Use this instead of `log.error('...', err)` — the second
 * argument path was the source of the AC5 leak.
 */
export function logSyncError(log: LoggerLike, label: string, err: unknown): void {
  log.error(`${label}: ${scrubError(err)}`);
}

/**
 * Emit one [track-failed] line. Caller passes `cause` already-scrubbed;
 * we still call scrubError defensively in case the caller forgot.
 */
export function logTrackFailed(
  log: LoggerLike,
  args: Parameters<typeof formatTrackFailed>[0],
): void {
  // Defensive: scrub cause again so an accidental non-string from the
  // pipeline (e.g. a thrown object) cannot leak the original error.
  const safe = { ...args, cause: scrubError(args.cause) };
  log.info(formatTrackFailed(safe));
}
