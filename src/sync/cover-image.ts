/**
 * Cover-art helpers (ORAIN-0736).
 *
 * Two responsibilities:
 *
 *  1. **SOF detection** — peek at the first SOF marker in a JPEG and tell
 *     whether the file is baseline (`SOF0`, 0xFFC0), extended (`SOF1`,
 *     0xFFC1), progressive (`SOF2`, 0xFFC2) or not a JPEG at all. The MP3
 *     muxer in FFmpeg would otherwise default to PNG when given a JPEG
 *     cover, re-encoding and bloating the output by ~40 %.
 *
 *  2. **Jellyfin URL builder** — the Primary cover URL with `maxWidth`,
 *     `maxHeight`, `quality` and `format=Jpg` query parameters. This is the
 *     canonical "give me a small, baseline JPEG already" request measured on
 *     a Jellyfin 12.1.0 server on 2026-09-27.
 *
 * No runtime imports beyond `Buffer` — every consumer is a unit test.
 */

export const COVER_MAX_DIM = 500;
export const COVER_QUALITY = 85;
export const COVER_FORMAT = 'Jpg';

/**
 * Upper bound for the size of an embedded or companion cover on the destination.
 * Measured by ORAIN-0736: a typical 500px @ quality 85 baseline JPEG weighs
 * ~50 KB (48,781 B for the *Biscuits* test cover). The 150 KB bound leaves
 * ~3× headroom for harder content without inflating the storage estimate.
 *
 * ORAIN-0738: imported (not duplicated) by sync-core.ts for its single
 * `estimateOutputBytes` estimator, used by both the storage bar and the
 * progress bar. Together with the bounded cover pipeline in ORAIN-0736,
 * the actual cover bytes written to disk stay under this cap.
 */
export const COVER_MAX_BYTES = 150 * 1024;

/** SOI marker (start-of-image). A real JPEG starts with FFD8 FF. */
export function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export type JpegFrameType = 'baseline' | 'extended' | 'progressive' | 'non-jpeg';

/**
 * Walk JPEG markers until a SOFn (start-of-frame) is found. Each
 * variable-length segment begins `FF xx LL LL` where the LL field is the
 * big-endian length of the segment body including itself.
 *
 * Standalone markers (no payload) we care about: SOI (D8) — only valid
 * at the very start of the stream, EOI (D9), TEM (01, ITU-T T.81
 * §B.1.1.4), and RSTn (D0..D7). Anything else with a body — APPn
 * (E0..EF), DQT (DB), DHT (C4), COM (FE), etc. — uses the length field.
 *
 * Per ITU-T T.81 §B.1.1.2 any number of `0xFF` bytes may appear
 * between markers as fill (padding); the marker type is identified by
 * the first non-`0xFF` byte following any run of FFs.
 */
export function getJpegFrameType(bytes: Buffer): JpegFrameType {
  if (!isJpeg(bytes)) return 'non-jpeg';

  let offset = 2; // skip SOI
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return 'non-jpeg';

    // Skip any number of 0xFF fill bytes (JPEG §B.1.1.2). The marker
    // type is the first non-FF byte after the run.
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset++;
    }
    if (markerOffset >= bytes.length) return 'non-jpeg';
    const marker = bytes[markerOffset];
    const segmentStart = markerOffset - 1; // the last 0xFF before it

    if (marker === 0xc0) return 'baseline';
    if (marker === 0xc1) return 'extended';
    if (marker === 0xc2) return 'progressive';

    // Standalone markers: SOI (D8) is only valid at offset 0 — anywhere
    // else it indicates a corrupt or nested stream and we treat the
    // image as invalid rather than restarting from the spurious SOI.
    if (marker === 0xd8) return 'non-jpeg';
    if (marker === 0x01 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = segmentStart + 2;
      continue;
    }

    // Variable-length segment — need 2 more bytes for the length header.
    if (segmentStart + 3 >= bytes.length) return 'non-jpeg';
    const len = (bytes[segmentStart + 2] << 8) | bytes[segmentStart + 3];
    if (len < 2) return 'non-jpeg';
    offset = segmentStart + 2 + len;
  }

  return 'non-jpeg';
}

/**
 * Jellyfin Image API: request a downsized, recompressed JPEG.
 *
 * 500 px and quality 85 come from the ORAIN-0736 measurement:
 *   - 500 px is what every documented car-radio / Walkman / iPod / Sansa
 *     guide recommends as a hard upper bound.
 *   - quality 85 reproduces a smaller-than-original file for the typical
 *     106 KB Jellyfin cover. Below 85 the size keeps dropping without a
 *     perceptible quality change for an embedded thumbnail; above 85 the
 *     file can grow past the original size when the source is already a
 *     high-quality JPEG.
 *
 * ORAIN-0749: the user-scoped path (`/Users/{userId}/Items/{id}/Images/Primary`)
 * returns 404 with an empty body on Jellyfin 10.10.3 and 12.0.0. Only the
 * unscoped `/Items/{id}/Images/Primary` variant is accepted. `userId` is kept
 * in the signature for back-compat with existing callers but is no longer
 * embedded in the URL.
 */
export function buildCoverArtUrl(baseUrl: string, userId: string, itemId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  // Path-segments come from an untrusted source (API responses, third-party
  // URLs); encode them so a caller that later parses this URL won't inherit
  // a path-injection bug if `itemId` ever carries `#`, `?`, or `/`.
  // `userId` is unused on the wire (see JSDoc) but accepted in the signature
  // so existing call sites compile unchanged.
  void userId;
  return (
    `${base}/Items/${encodeURIComponent(itemId)}/Images/Primary` +
    `?maxWidth=${COVER_MAX_DIM}&maxHeight=${COVER_MAX_DIM}` +
    `&quality=${COVER_QUALITY}&format=${COVER_FORMAT}`
  );
}
