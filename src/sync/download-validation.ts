/**
 * ORAIN-0739 — pure post-download body and size validation.
 *
 * Two checks live here, kept pure (no fs, no network, no timers) so
 * they can be unit-tested cheaply:
 *
 *   - validateAudioBody(buf)
 *       Does the buffered body fingerprint as one of the audio
 *       containers JellyTunes accepts? Implemented as a fixed table of
 *       magic bytes (ID3, MPEG sync, fLaC, OggS, RIFF/WAVE, MP4 ftyp,
 *       FORM/AIFF, WavPack, Monkey's Audio, ASF/WMA).
 *
 *   - validateDownloadSize({ contentLength, contentEncoding,
 *                              declaredSize, receivedBytes,
 *                              previousReceivedBytes })
 *       AC2 — is the body length coherent with what the proxy
 *       declared? Content-Length is honored when the transport is
 *       identity; Content-Encoding != identity skips the comparison.
 *       Without Content-Length the only signal left is track.size,
 *       which Jellyfin can leave stale (AC2(c)): the function asks
 *       the caller for the previous attempt's byte count and accepts
 *       when both attempts agree on a stable, different size.
 *
 *   - validateDownloadSize also enforces AC6 (2 GiB upper bound).
 *
 * SyncCore wires this together with the disk + retry loop. See
 * sync-core.ts::_downloadWithValidation.
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const TEXT_BYTE_THRESHOLD = 0.95;

interface Signature {
  readonly name: string;
  readonly match: (b: Buffer) => boolean;
}

const TABLE: readonly Signature[] = [
  { name: 'ID3v2', match: (b) => b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
  { name: 'MPEG sync', match: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
  {
    name: 'fLaC',
    match: (b) => b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43,
  },
  {
    name: 'OggS',
    match: (b) => b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53,
  },
  {
    name: 'RIFF/WAVE',
    match: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x41 &&
      b[10] === 0x56 &&
      b[11] === 0x45,
  },
  {
    name: 'MP4 ftyp',
    match: (b) => b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  },
  {
    name: 'FORM/AIFF',
    match: (b) =>
      b.length >= 12 &&
      b[0] === 0x46 &&
      b[1] === 0x4f &&
      b[2] === 0x52 &&
      b[3] === 0x4d &&
      b[8] === 0x41 &&
      b[9] === 0x49 &&
      b[10] === 0x46 &&
      b[11] === 0x46,
  },
  {
    name: 'WavPack',
    match: (b) => b.length >= 4 && b[0] === 0x77 && b[1] === 0x76 && b[2] === 0x70 && b[3] === 0x6b,
  },
  // "MAC " has a trailing 0x20 — do NOT fold into the table's length-only check.
  {
    name: 'Monkey',
    match: (b) => b.length >= 4 && b[0] === 0x4d && b[1] === 0x41 && b[2] === 0x43 && b[3] === 0x20,
  },
  {
    name: 'ASF/WMA',
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x30 &&
      b[1] === 0x26 &&
      b[2] === 0xb2 &&
      b[3] === 0x75 &&
      b[4] === 0x8e &&
      b[5] === 0x66 &&
      b[6] === 0xcf &&
      b[7] === 0x11,
  },
];

/**
 * Detect "the first 64 bytes are mostly printable ASCII" — a strong
 * signal for HTML, JSON and plain text responses. Empty buffers are
 * treated as textual (no audio signature fits in zero bytes).
 */
export function isProbablyTextual(buf: Buffer, n = 64): boolean {
  if (buf.length === 0) return true;
  const win = Math.min(n, buf.length);
  let printable = 0;
  for (let i = 0; i < win; i++) {
    const c = buf[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d) printable++;
    else if (c >= 0x20 && c <= 0x7e) printable++;
  }
  return printable / win >= TEXT_BYTE_THRESHOLD;
}

/**
 * AC3 — accept the body as audio if any signature matches; reject
 * empty payloads and bodies that look textual; otherwise (binary but
 * unknown) hand off to FFmpeg.
 */
export function validateAudioBody(buf: Buffer): ValidationResult {
  if (buf.length === 0) {
    return { ok: false, reason: 'Server returned 0 B (empty body)' };
  }
  for (const sig of TABLE) {
    if (sig.match(buf)) return { ok: true };
  }
  if (isProbablyTextual(buf)) {
    const preview = buf
      .subarray(0, Math.min(40, buf.length))
      .toString('utf8')
      .replace(/[^\x20-\x7e]/g, '.');
    return { ok: false, reason: `Body looks like text, not audio (preview: "${preview}")` };
  }
  return { ok: true };
}

// =============================================================================
// AC2 + AC6 — size validation
// =============================================================================

/**
 * 2 GiB hard cap on raw downloaded body (AC6). Expressed as BigInt so
 * callers can compare against a Node Buffer length (number) without
 * crossing the 32-bit boundary. The constant 2^31 keeps the cap below
 * 2 GiB + 1 byte by construction.
 */
export const MAX_DOWNLOAD_BYTES = 2n ** 31n; // 2 147 483 648

export interface DownloadSizeInput {
  /** Content-Length parsed in sync-api.ts. `undefined` if missing or not a finite number. */
  contentLength?: number;
  /** As declared by the proxy's Content-Encoding header. Defaults to `'identity'`. */
  contentEncoding?: string;
  /** Jellyfin's track.size — may be stale (AC2(c)). */
  declaredSize?: number;
  /** Actual bytes buffered into the temp file. */
  receivedBytes: number;
  /** Optional previous attempt result, used by AC2(c) for stability check. */
  previousReceivedBytes?: number;
}

export type DownloadSizeResult = { ok: true; warning?: string } | { ok: false; reason: string };

function exceedsCap(receivedBytes: number): boolean {
  return BigInt(receivedBytes) > MAX_DOWNLOAD_BYTES;
}

export function validateDownloadSize(input: DownloadSizeInput): DownloadSizeResult {
  const { contentLength, contentEncoding, declaredSize, receivedBytes } = input;

  // AC2(b): any non-identity encoding — proxy may compress on the wire.
  // The Content-Length reported by the proxy is the encoded length and
  // will not equal the decoded body, so skip the comparison but still
  // apply AC6 to the body we actually buffered.
  const encoding = (contentEncoding ?? 'identity').toLowerCase();
  if (encoding !== 'identity') {
    if (exceedsCap(receivedBytes)) {
      return { ok: false, reason: 'File too large (>2 GiB)' };
    }
    return { ok: true };
  }

  // AC2(a): Content-Length + identity encoding → strict equality.
  if (typeof contentLength === 'number' && Number.isFinite(contentLength)) {
    if (contentLength === 0) {
      // ORAIN-0767 AC3: zero-byte is the case the reporter saw on the
      // `Bomb (1)` track. The previous wording (`Incomplete download (0
      // of 0 bytes)`) was true but useless — the user cannot act on
      // it. Jellyfin returns Content-Length: 0 when the file is gone
      // server-side but the metadata index still serves the track id.
      // JellyTunes cannot fix the server side; we explain what to do.
      return {
        ok: false,
        reason:
          "Server returned an empty file. The file may have been removed from the Jellyfin library — try rescanning the library in Jellyfin, or check the file's status on the server.",
      };
    }
    if (receivedBytes !== contentLength) {
      return {
        ok: false,
        reason: `Incomplete download (${receivedBytes} of ${contentLength} bytes)`,
      };
    }
    if (exceedsCap(receivedBytes)) {
      return { ok: false, reason: 'File too large (>2 GiB)' };
    }
    return { ok: true };
  }

  // AC2(c): declaredSize (track.size) with retry-stability acceptance.
  // Review Focus Edge 5: declaredSize === 0 is treated as "no info".
  if (typeof declaredSize === 'number' && declaredSize > 0 && Number.isFinite(declaredSize)) {
    if (receivedBytes === declaredSize) return { ok: true };
    if (
      typeof input.previousReceivedBytes === 'number' &&
      receivedBytes === input.previousReceivedBytes
    ) {
      return {
        ok: true,
        warning: `size differs from the Jellyfin-declared (${receivedBytes} vs ${declaredSize}); library may need a rescan`,
      };
    }
    if (exceedsCap(receivedBytes)) {
      return { ok: false, reason: 'File too large (>2 GiB)' };
    }
    return {
      ok: false,
      reason: `Incomplete download (${receivedBytes} of ${declaredSize} bytes)`,
    };
  }

  // AC2(d): no size signal at all. Only the AC6 cap still applies.
  if (exceedsCap(receivedBytes)) {
    return { ok: false, reason: 'File too large (>2 GiB)' };
  }
  return { ok: true };
}
