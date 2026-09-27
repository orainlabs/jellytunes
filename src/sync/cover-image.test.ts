/**
 * ORAIN-0736: pure helpers for cover art — JPEG SOF detection and the
 * Jellyfin URL builder. No Node-side dependencies beyond `Buffer`.
 *
 * SOF marker bytes (start-of-frame, the first image-data marker):
 *   - 0xFFC0 (SOF0) = baseline, the only variant car radios reliably read
 *   - 0xFFC1 (SOF1) = extended sequential, Huffman
 *   - 0xFFC2 (SOF2) = progressive, the variant many readers reject
 */

import { describe, it, expect } from 'vitest';
import { isJpeg, getJpegFrameType, buildCoverArtUrl } from './cover-image';

/**
 * Build a JPEG-like buffer with an arbitrary segment chain. Each segment is
 * `[FF, marker_hi, marker_lo, len_hi, len_lo, body...]`. The SOFn marker
 * bit is encoded in the high byte (0xC0/0xC1/0xC2).
 */
function buildJpegLike(sofMarkerHi: number, paddingBefore: number[] = []): Buffer {
  const segments: number[] = [0xff, 0xd8]; // SOI
  for (const b of paddingBefore) segments.push(b);
  // APP0 segment (JFIF) — variable-length, 16 bytes
  segments.push(
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
  );
  // SOFn segment — minimum body, length includes itself
  segments.push(
    0xff,
    sofMarkerHi,
    0x00,
    0x11,
    0x08,
    0x00,
    0x10,
    0x00,
    0x20,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x01,
  );
  return Buffer.from(segments);
}

describe('isJpeg', () => {
  it('returns true for a JPEG SOI marker (FFD8 FF)', () => {
    expect(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('returns false for PNG bytes (89504E47)', () => {
    expect(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isJpeg(Buffer.alloc(0))).toBe(false);
  });

  it('returns false when the third byte is not 0xFF (random data starting with FFD8)', () => {
    expect(isJpeg(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBe(false);
  });

  it('returns false for an under-3-byte buffer', () => {
    expect(isJpeg(Buffer.from([0xff, 0xd8]))).toBe(false);
  });
});

describe('getJpegFrameType', () => {
  it('returns "baseline" for SOF0', () => {
    expect(getJpegFrameType(buildJpegLike(0xc0))).toBe('baseline');
  });

  it('returns "extended" for SOF1', () => {
    expect(getJpegFrameType(buildJpegLike(0xc1))).toBe('extended');
  });

  it('returns "progressive" for SOF2', () => {
    expect(getJpegFrameType(buildJpegLike(0xc2))).toBe('progressive');
  });

  it('skips a variable-length APP marker preceding the SOF marker', () => {
    // Padding APP segment before our SOF0 — baseline must still be detected
    expect(
      getJpegFrameType(buildJpegLike(0xc0, [0xff, 0xe1, 0x00, 0x06, 0xaa, 0xbb, 0xcc, 0xdd])),
    ).toBe('baseline');
  });

  it('returns "non-jpeg" when bytes do not start with FFD8', () => {
    expect(getJpegFrameType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'non-jpeg',
    );
  });

  it('returns "non-jpeg" when the SOF marker is missing entirely', () => {
    // SOI + one short APP segment, then EOF — no SOFn
    const bytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xd9,
    ]);
    expect(getJpegFrameType(bytes)).toBe('non-jpeg');
  });

  it('skips FF padding (fill bytes) between markers per ITU-T T.81 §B.1.1.2', () => {
    // SOI, then a stray 0xFF fill byte (allowed as padding between
    // markers), then a normal APP segment, then SOF0. JPEG permits any
    // number of 0xFF bytes as padding between markers — the marker
    // type is identified by the first non-FF byte following any
    // run of FFs.
    const bytes = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff, // fill byte (padding)
      0xff, // another fill byte
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // APP0
      0xff,
      0xff,
      0xff,
      0xc0, // 3 fill bytes, then SOF0
      0x00,
      0x11,
      0x08,
      0x00,
      0x10,
      0x00,
      0x20,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x01,
    ]);
    expect(getJpegFrameType(bytes)).toBe('baseline');
  });

  it('treats TEM (FF 01) as a standalone marker with no payload', () => {
    // ITU-T T.81 §B.1.1.4: TEM (0x01) is a standalone marker that takes
    // no segment body. After a TEM, the next marker must come
    // immediately. If the walker treats it as variable-length, it reads
    // the next two bytes as a length field and skips to an arbitrary
    // offset, missing SOF0 entirely.
    const bytes = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0x01, // TEM — standalone, no payload
      0xff,
      0xc0, // SOF0 — baseline
      0x00,
      0x11,
      0x08,
      0x00,
      0x10,
      0x00,
      0x20,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x01,
    ]);
    expect(getJpegFrameType(bytes)).toBe('baseline');
  });

  it('returns "non-jpeg" when a stray SOI marker (FF D8) appears inside the stream', () => {
    // A stray FF D8 embedded inside a segment (e.g. an APP0 whose body
    // happens to contain SOI bytes by accident, or a corrupt JPEG) is
    // structurally invalid. The walker must not silently restart from
    // the spurious SOI and find a downstream SOF that does not actually
    // describe the image.
    const bytes = Buffer.from([
      0xff,
      0xd8, // real SOI
      0xff,
      0xe0,
      0x00,
      0x10, // APP0 length 16 (header counted)
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // APP0 body
      // End of APP0 — the byte sequence below continues the stream but
      // does NOT contain a real SOF marker; the spurious 0xFF 0xD8 here
      // would (before the fix) trick the walker into "restarting" and
      // then reading the next 0xFF 0xC0 as a SOF0 of a "new" image.
      0xff,
      0xd8, // spurious SOI
      0xff,
      0xc0, // fake SOF0 (would have been picked up before fix)
      0x00,
      0x11,
      0x08,
      0x00,
      0x10,
      0x00,
      0x20,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x01,
    ]);
    expect(getJpegFrameType(bytes)).toBe('non-jpeg');
  });
});

describe('buildCoverArtUrl', () => {
  it('appends maxWidth, maxHeight, quality, format to the Primary URL', () => {
    const u = buildCoverArtUrl('https://jellyfin.test', 'user-1', 'abc-123');
    // Pin each query parameter individually — HTTP does not depend on
    // param order, so this test would break for harmless reordering.
    expect(u).toContain('maxWidth=500');
    expect(u).toContain('maxHeight=500');
    expect(u).toContain('quality=85');
    expect(u).toContain('format=Jpg');
  });

  it('matches Jellyfin path conventions: Users/{userId}/Items/{id}/Images/Primary', () => {
    expect(buildCoverArtUrl('https://x', 'u9', 'i1')).toContain('/Items/i1/Images/Primary');
  });

  it('preserves user-id (Jellyfin requires the user in the path)', () => {
    expect(buildCoverArtUrl('https://x', 'u9', 'i1')).toContain('/Users/u9/');
  });

  it('strips a trailing slash from the base URL', () => {
    expect(buildCoverArtUrl('https://x/', 'u', 'i')).toContain(
      'https://x/Users/u/Items/i/Images/Primary',
    );
  });
});
