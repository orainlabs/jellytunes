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
 * Local mirror of `src/sync/types.ts` `ItemType`. Duplicated rather
 * than imported to keep `log-scrub` independent of the sync module
 * (so a future refactor that moves ItemType out of sync/ doesn't
 * create a circular import). The two definitions MUST stay in lock-
 * step — a test in `log-scrub.test.ts` covers the union exhaustively
 * by enumerating a representative shape and asserting it formats.
 */
type ItemType = 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre';

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
  // ORAIN-0740 cycle 2 (LOW): the old `new RegExp(\`^${home}([\\\\/])\`)`
  // shape used four backslashes in the template to mean a single literal
  // backslash in the regex — readable only with a comment. We compute
  // `home` as a regex source string with its own metacharacters escaped,
  // then concatenate it into a regex literal. The `sep` group is now
  // optional so home-as-input (no trailing separator) matches and scrubs
  // to bare `~`. The three shapes:
  //   - home + '/...'   → `~/...`
  //   - home + '\\...'  → `~\...`  (Windows)
  //   - home exactly    → `~`
  //
  // We anchor both branches with a lookahead `(?:[/\\]|$)` so a folder
  // named exactly like home (e.g. `/Users/alice-evil`) does NOT match —
  // the lookahead requires either a separator or end-of-string after
  // `home`, which `/Users/alice` followed by `-evil` does not have.
  const escaped = home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return input.replace(new RegExp(`^${escaped}(?:(?=[/\\\\])|$)`), () => '~');
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
  /**
   * ORAIN-0501 AC7: detected server root path. Rendered as
   * `serverRoot=<scrubbed>` when present (after the same `scrubPath`
   * pass as `dest=`), or `serverRoot=none` when empty/missing — so
   * support can read the bug-report excerpt and tell a real
   * `/media/music/` from a `''` returned when the batch had no tracks.
   */
  serverRootPath?: string;
  /**
   * ORAIN-0770 AC1: per-type breakdown of the items the user picked
   * for this sync. Renders as `itemTypes=albumArtist:3 album:1` —
   * space-separated, deterministic order (sorted by type name). When
   * omitted (legacy callers), the field is skipped from the line; the
   * existing `items=N` total still tells support how many were picked.
   */
  itemTypeBreakdown?: Map<ItemType, number>;
}): string {
  const dest = scrubPath(input.destinationPath);
  const serverRoot =
    input.serverRootPath && input.serverRootPath.length > 0
      ? scrubPath(input.serverRootPath)
      : 'none';
  const parts: string[] = [
    `[sync-start] syncId=${input.syncId}`,
    `appVersion=${input.appVersion}`,
    `platform=${input.platform}`,
    `arch=${input.arch}`,
    `dest=${dest}`,
    `destFs=${input.destinationFilesystem}`,
    `serverRoot=${serverRoot}`,
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
  if (input.itemTypeBreakdown && input.itemTypeBreakdown.size > 0) {
    parts.push(`itemTypes=${formatItemTypeBreakdown(input.itemTypeBreakdown)}`);
  }
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

// =============================================================================
// SERVER INFO (ORAIN-0770)
// =============================================================================

/**
 * Payload for one [server-info] line. Every field is optional; missing
 * values render as `unknown` (never `undefined`, per ORAIN-0740 AC5).
 *
 * Privacy: ONLY counts and a single opaque version string. Never include
 * track names, album names, server names, library names, or any
 * user-identifying token here. The line is what support pastes into
 * a public issue — a leak here defeats the whole purpose.
 */
export interface ServerInfoPayload {
  artists: number | null | undefined;
  albumArtists: number | null | undefined;
  albums: number | null | undefined;
  audioTracks: number | null | undefined;
  jellyfinVersion: string | null | undefined;
}

/**
 * Format one [server-info] line. Output shape (whitespace-separated k=v):
 *   [server-info] artists=N albumArtists=N albums=N audioTracks=N jellyfinVersion=X
 * Missing values render as the literal token `unknown`.
 */
export function formatServerInfo(payload: ServerInfoPayload): string {
  return [
    '[server-info]',
    `artists=${fmtServerInfoValue(payload.artists)}`,
    `albumArtists=${fmtServerInfoValue(payload.albumArtists)}`,
    `albums=${fmtServerInfoValue(payload.albums)}`,
    `audioTracks=${fmtServerInfoValue(payload.audioTracks)}`,
    `jellyfinVersion=${fmtServerInfoValue(payload.jellyfinVersion)}`,
  ].join(' ');
}

/**
 * Render a single field. Numbers stringify as-is; null/undefined/empty
 * string all collapse to `unknown`. The version is a string and never
 * gets scrubbed — it's a server-side public fact.
 */
function fmtServerInfoValue(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'string' && v.length === 0) return 'unknown';
  return String(v);
}

/**
 * Emit a [server-info] line through the supplied logger.
 */
export function logServerInfo(log: LoggerLike, payload: ServerInfoPayload): void {
  log.info(formatServerInfo(payload));
}

/**
 * Stateful dedupe helper. AC2 explicitly requires the [server-info] line
 * to NOT re-emit when no value changed since the last emission. The main
 * process owns one instance per session, captured in module state.
 *
 * `maybeEmit` returns `true` when the line was emitted (and the caller
 * can expect to see it in main.log) and `false` when the payload matched
 * the previous one and the line was suppressed.
 */
export interface ServerInfoDedupe {
  maybeEmit(log: LoggerLike, payload: ServerInfoPayload): boolean;
}

export function createServerInfoDedupe(): ServerInfoDedupe {
  let last: ServerInfoPayload | null = null;
  return {
    maybeEmit(log, payload) {
      if (last !== null && serverInfoPayloadEquals(last, payload)) {
        return false;
      }
      logServerInfo(log, payload);
      last = payload;
      return true;
    },
  };
}

/**
 * Compare two payloads for equality. Order-independent at the field
 * level; every field is compared directly (null === null, undefined
 * === undefined, numbers === numbers, strings === strings).
 */
function serverInfoPayloadEquals(a: ServerInfoPayload, b: ServerInfoPayload): boolean {
  return (
    a.artists === b.artists &&
    a.albumArtists === b.albumArtists &&
    a.albums === b.albums &&
    a.audioTracks === b.audioTracks &&
    a.jellyfinVersion === b.jellyfinVersion
  );
}

/**
 * Render a `Map<ItemType, number>` as a space-separated list of
 * `type:N` tokens. Output order follows the Map's insertion order,
 * which is the order types first appear in `SyncInput.itemTypes`.
 * That ordering is what the test asserts on (`albumArtist` first
 * because the first three items are album-artists, then `album`),
 * and it matches what support reads at a glance: the dominant type
 * comes first.
 *
 * Empty / undefined maps produce an empty string — the caller gates
 * the field on `size > 0` before calling.
 */
export function formatItemTypeBreakdown(breakdown: Map<ItemType, number>): string {
  return [...breakdown.entries()].map(([type, count]) => `${type}:${count}`).join(' ');
}

// =============================================================================
// VOLUME DETECTION DIFF (ORAIN-0740 AC4)
// =============================================================================

/**
 * Mutable state shared across calls to `diffAndLogVolumes`. The
 * device-watcher polls every 15 s; the helper needs to remember the
 * previous set between polls so it can diff.
 */
export interface VolumeLogState {
  /** Set of device paths seen on the previous poll. `null` means "not seeded yet". */
  lastDeviceKeys: Set<string> | null;
  /** Counter state for `oncePerSession` semantics on the error path. */
  errorLogged: { logged: boolean };
}

/**
 * Extract the canonical identity of a device for set membership. macOS /Volumes
 * entries and Windows drive letters use `device`; mountpoint-based entries use
 * the first mountpoint path. Falls back to `displayName`.
 */
export function deviceKey(d: {
  device?: string;
  mountpoints?: Array<{ path: string }>;
  displayName?: string;
}): string {
  if (d.device) return d.device;
  if (d.mountpoints && d.mountpoints.length > 0) return d.mountpoints[0].path;
  return d.displayName ?? '';
}

/**
 * Emit a log line only when the volume set has actually changed since the last
 * poll. Mirrors the `device-watcher.ts:237-245` diff pattern.
 *
 * First call: seeds `lastDeviceKeys`, emits one "initial" line so support has
 * a baseline to read.
 * Subsequent calls with the same set: silent.
 * Calls with additions or removals: one "attached" / "detached" line each.
 *
 * Pure function — no fs, no electron. Cross-platform.
 */
export function diffAndLogVolumes(
  state: VolumeLogState,
  currentDevices: Array<{
    device?: string;
    mountpoints?: Array<{ path: string }>;
    displayName?: string;
  }>,
  log: LoggerLike,
): void {
  const currentKeys = new Set(currentDevices.map(deviceKey));

  if (state.lastDeviceKeys === null) {
    state.lastDeviceKeys = currentKeys;
    log.info(`[volume-detection] initial: ${currentKeys.size} device(s)`);
    return;
  }

  const added = [...currentKeys].filter((k) => !state.lastDeviceKeys!.has(k));
  const removed = [...state.lastDeviceKeys].filter((k) => !currentKeys.has(k));

  if (added.length === 0 && removed.length === 0) return;

  if (added.length > 0) {
    log.info(`[volume-detection] attached: ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    log.info(`[volume-detection] detached: ${removed.join(', ')}`);
  }
  state.lastDeviceKeys = currentKeys;
}
