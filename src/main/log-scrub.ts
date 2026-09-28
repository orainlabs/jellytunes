/**
 * ORAIN-0740 — log scrubber for support-friendly main.log.
 *
 * Three responsibilities:
 * 1. Redact the user home directory out of any path before it reaches the logger.
 * 2. Flatten error objects to their `.message` — never leak bodies, headers, or
 *    stack frames with the user's name in them.
 * 3. Format the three support-friendly sync log lines ([sync-start], [sync-end],
 *    [track-failed]) into single lines that a grep can parse and a paste into a
 *    public issue does not leak.
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
