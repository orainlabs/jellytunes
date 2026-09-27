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
});

describe('buildCoverArtUrl', () => {
  it('appends maxWidth, maxHeight, quality, format to the Primary URL', () => {
    const u = buildCoverArtUrl('https://jellyfin.test', 'user-1', 'abc-123');
    expect(u).toBe(
      'https://jellyfin.test/Users/user-1/Items/abc-123/Images/Primary' +
        '?maxWidth=500&maxHeight=500&quality=85&format=Jpg',
    );
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
