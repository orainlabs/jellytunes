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
 * Standalone markers (no payload) we care about: SOI (D8), EOI (D9), and
 * RSTn (D0..D7). Anything else with a body — APPn (E0..EF), DQT (DB),
 * DHT (C4), COM (FE), etc. — uses the length field.
 */
export function getJpegFrameType(bytes: Buffer): JpegFrameType {
  if (!isJpeg(bytes)) return 'non-jpeg';

  let offset = 2; // skip SOI
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return 'non-jpeg';

    const marker = bytes[offset + 1];
    if (marker === 0xc0) return 'baseline';
    if (marker === 0xc1) return 'extended';
    if (marker === 0xc2) return 'progressive';

    // Standalone markers
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // Variable-length segment — need 2 more bytes for the length header.
    if (offset + 3 >= bytes.length) return 'non-jpeg';
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (len < 2) return 'non-jpeg';
    offset += 2 + len;
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
 */
export function buildCoverArtUrl(baseUrl: string, userId: string, itemId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return (
    `${base}/Users/${userId}/Items/${itemId}/Images/Primary` +
    `?maxWidth=${COVER_MAX_DIM}&maxHeight=${COVER_MAX_DIM}` +
    `&quality=${COVER_QUALITY}&format=${COVER_FORMAT}`
  );
}
