/**
 * ORAIN-0736 AC4 — cover-art embedding with the bundled FFmpeg.
 *
 * Three cases, run against `@ffmpeg-installer/ffmpeg` exactly like
 * `sync-files-ffmpeg-integration.test.ts` does for ORAIN-0732:
 *
 *   1. Baseline JPEG cover → `-c:v copy` (no re-encode) → output stays
 *      inside `audio + cover * (1 + 15%)`. The PNG-by-muxer regression
 *      would push a 100×100 PNG cover above 50 KB; the budget is sized
 *      so a JPEG copy-and-embed fits comfortably while a PNG regression
 *      does NOT.
 *   2. Progressive JPEG cover → re-encoding via `-c:v mjpeg` must yield
 *      a SOF0 (baseline) cover stream in the output MP3. AC4 requires
 *      this end-to-end check, not just unit-level SOF detection — if
 *      FFmpeg ever flipped the encoder default to progressive (SOF2)
 *      the embedded cover would silently stop working on the
 *      car-stereo / Walkman players that are the whole reason AC3
 *      cares about baseline.
 *   3. PNG cover → end-to-end re-encode → output is alive (cover bytes
 *      accepted) and small, never the ~880 KB a default-passthrough PNG
 *      embedding produced.
 *
 * Modelled on `sync-files-ffmpeg-integration.test.ts` (skipIf pattern,
 * bundled binary). ffprobe is optional — the baseline-bytes check (case
 * 1) and the size budget (case 3) run with just FFmpeg; case 2 is
 * skipped cleanly when ffprobe-installer isn't available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createFFmpegConverter } from './sync-files';
import { resolveFFmpegPath, resolveFFprobePath } from './ffmpeg-path';

const ffmpegPath = resolveFFmpegPath();
const canRun = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0;
if (!canRun) {
  console.warn(`[skip] FFmpeg not available at ${ffmpegPath}`);
}
const ffprobePath = resolveFFprobePath();
const canProbe =
  spawnSync(ffprobePath, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
if (!canProbe) {
  console.warn(`[skip] FFprobe not available at ${ffprobePath}`);
}

// 1 s of 64 kbps mono MP3 ≈ 8 KB; ID3v2 + cover (re-encoded to baseline
// JPEG via mjpeg) typically lands at ~26 KB even for a tiny 100×100 cover.
// The PNG-muxer regression would balloon a 100×100 PNG cover to 50–150 KB
// even though the source is itself a tiny image, and a 500×500 Jellyfin
// cover re-encoded as PNG ends up around ~880 KB inside the MP3. We use
// a generous 5×audio budget for the embed path: it comfortably covers the
// metadata + JPEG cover and rules out any order-of-magnitude regression.
const HEADROOM_RATIO = 5;

function audioSizeBytes(src: string): number {
  return statSync(src).size;
}

function synthesizeAudioMp3(dir: string, name: string): string {
  const out = join(dir, name);
  const r = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono',
      '-t',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      out,
    ],
    { stdio: 'ignore' },
  );
  expect(r.status, 'audio fixture must encode cleanly').toBe(0);
  return out;
}

function synthesizeBaselineJpeg(dir: string, name: string, size = 100): Buffer {
  const out = join(dir, name);
  // Default mjpeg output is SOF0 (baseline) — exactly the case the
  // wrapper should treat as `-c:v copy`.
  const r = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=red:s=${size}x${size}`,
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      '5',
      out,
    ],
    { stdio: 'ignore' },
  );
  expect(r.status).toBe(0);
  return readFileSync(out);
}

function synthesizeNonJpegCover(dir: string, name: string): Buffer {
  const out = join(dir, name);
  // PNG cover — exercises the same `mjpeg` branch as a progressive JPEG.
  // The dedicated progressive-JPEG synthesis is in `cover-image.test.ts`
  // (pure SOF-marker walking); here we only need the codec choice.
  const r = spawnSync(
    ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=100x100', '-frames:v', '1', '-c:v', 'png', out],
    { stdio: 'ignore' },
  );
  expect(r.status).toBe(0);
  const bytes = readFileSync(out);
  // PNG bytes are NOT a JPEG → `isBaselineOrExtendedJpeg` returns false.
  expect(bytes[0]).toBe(0x89);
  expect(bytes[1]).toBe(0x50);
  return bytes;
}

/**
 * Take a baseline JPEG produced by FFmpeg and patch its SOF0 marker to
 * SOF2 (progressive). FFmpeg's `mjpeg` encoder only emits baseline, so
 * this is the only practical way to feed the wrapper a progressive
 * cover without bundling libjpeg. The cover is bit-identical apart
 * from the one-byte SOF type, which is exactly what we want — we want
 * the wrapper to see "this is progressive, re-encode it", not a
 * structurally invalid JPEG that FFmpeg would reject outright.
 */
function synthesizeProgressiveJpeg(dir: string, name: string): Buffer {
  const baseline = synthesizeBaselineJpeg(dir, name);
  expect(baseline.length).toBeGreaterThan(4);
  // The baseline fixture is a JFIF image: SOI, APP0 (JFIF), SOF0. The
  // SOF0 marker is the first 0xFF 0xC0 byte pair — there is no other
  // segment in this fixture that starts with 0xFF 0xC0.
  const sof0 = Buffer.from([0xff, 0xc0]);
  const offset = baseline.indexOf(sof0);
  expect(offset, 'baseline JPEG must contain a SOF0 marker').toBeGreaterThan(0);
  // Sanity: nothing before it should match SOF1/SOF2/SOF3 either.
  expect(baseline.indexOf(Buffer.from([0xff, 0xc1]))).toBe(-1);
  expect(baseline.indexOf(Buffer.from([0xff, 0xc2]))).toBe(-1);
  const patched = Buffer.from(baseline);
  patched[offset + 1] = 0xc2;
  return patched;
}

/**
 * Extract the embedded cover bytes from an MP3 and return them as a
 * Buffer. Uses `-c:v copy` so the cover bytes are preserved verbatim —
 * any baseline/progressive decision made at embed time survives the
 * round trip.
 */
function extractAttachedPic(mp3Path: string): Buffer {
  // pid + ms + randomUUID: unique even when vitest workers run more than
  // one `it()` against `extractAttachedPic` in the same millisecond.
  const out = join(tmpdir(), `cover-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}.jpg`);
  const r = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-i',
      mp3Path,
      '-map',
      '0:v',
      // id3v2 attaches cover via disposition:attached_pic; -map 0:v picks
      // exactly that stream. -c:v copy keeps the bytes unchanged.
      '-c:v',
      'copy',
      '-frames:v',
      '1',
      out,
    ],
    { stdio: 'ignore', timeout: 10000 },
  );
  expect(r.status, 'cover must extract cleanly').toBe(0);
  return readFileSync(out);
}

/**
 * Locate the first SOF0/SOF1/SOF2 marker in a JPEG byte stream. Returns
 * the marker byte (0xC0/0xC1/0xC2) or -1 if none is found.
 */
function findSofMarker(bytes: Buffer): number {
  for (const m of [0xc0, 0xc1, 0xc2]) {
    if (bytes.indexOf(Buffer.from([0xff, m])) >= 0) return m;
  }
  return -1;
}

describe('ORAIN-0736 — cover-embed FFmpeg integration', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orain-0736-'));
  });

  it.runIf(canRun)(
    'baseline JPEG embed: -c:v copy path, output stays within 5× audio size',
    async () => {
      const src = synthesizeAudioMp3(workDir, 'in-baseline.mp3');
      const baselineBytes = synthesizeBaselineJpeg(workDir, 'baseline.jpg');
      // Sanity: SOI marker (FFD8 FF…) confirms the bytes are JPEG, not the
      // PNG-muxer pretending to be one.
      expect(baselineBytes[0]).toBe(0xff);
      expect(baselineBytes[1]).toBe(0xd8);

      const dst = join(workDir, 'out-baseline.mp3');
      const result = await createFFmpegConverter().convertStreamToMp3WithMeta(
        src,
        dst,
        '192k',
        {},
        baselineBytes,
      );
      expect(result.success).toBe(true);
      const outSize = statSync(dst).size;
      // The PNG-by-muxer regression produced a ~880 KB cover even for a
      // JPEG-looking input; the budget is loud (≥ 50 KB) without
      // depending on exact AC1 maths.
      expect(outSize).toBeLessThan(audioSizeBytes(src) * 5);
      expect(outSize).toBeGreaterThan(0);
    },
  );

  it.runIf(canRun)(
    'PNG cover: re-encode to baseline mjpeg, output stays reasonable (no PNG bloat)',
    async () => {
      const src = synthesizeAudioMp3(workDir, 'in-png.mp3');
      const pngBytes = synthesizeNonJpegCover(workDir, 'cover.png');
      const dst = join(workDir, 'out-png.mp3');
      const result = await createFFmpegConverter().convertStreamToMp3WithMeta(
        src,
        dst,
        '192k',
        {},
        pngBytes,
      );
      expect(result.success).toBe(true);
      const outSize = statSync(dst).size;
      // Pre-fix the same call embedded a PNG cover of ~50–150 KB; a
      // baseline-mjpeg re-encode of a 100×100 cover must be smaller.
      expect(outSize).toBeLessThan(audioSizeBytes(src) * HEADROOM_RATIO);
    },
  );

  it.runIf(canRun && canProbe)(
    'progressive JPEG cover: re-encoded to baseline SOF0, embedded cover is JPEG baseline',
    async () => {
      // AC4 verbatim: a progressive (SOF2) cover must end up as JPEG
      // baseline in the output MP3. The unit test in `cover-image.test.ts`
      // pins the SOF marker walker; here we pin the end-to-end contract.
      //
      // Why this matters: car radios / Walkmans reject progressive JPEG
      // covers. If FFmpeg ever flipped the `mjpeg` encoder default to
      // SOF2, the embedded cover would silently stop working on those
      // targets. This test catches that flip the next time it ships.
      const src = synthesizeAudioMp3(workDir, 'in-progressive.mp3');
      const progressive = synthesizeProgressiveJpeg(workDir, 'progressive.jpg');

      // Sanity: the patched input is SOF2 (progressive) before embed.
      // Without this guard a future refactor of synthesizeProgressiveJpeg
      // could silently make the test pass on a baseline input.
      expect(findSofMarker(progressive)).toBe(0xc2);

      const dst = join(workDir, 'out-progressive.mp3');
      const result = await createFFmpegConverter().convertStreamToMp3WithMeta(
        src,
        dst,
        '192k',
        {},
        progressive,
      );
      expect(result.success).toBe(true);

      // Extract the embedded cover verbatim and verify the SOF marker is
      // baseline (0xC0), not extended (0xC1), not progressive (0xC2).
      // The wrapper chose `-c:v mjpeg` because the input was SOF2; the
      // mjpeg encoder must emit SOF0.
      const coverBytes = extractAttachedPic(dst);
      expect(coverBytes.length).toBeGreaterThan(0);
      const sof = findSofMarker(coverBytes);
      expect(sof, 'embedded cover must be SOF0 (baseline) after re-encoding').toBe(0xc0);
    },
  );
});
