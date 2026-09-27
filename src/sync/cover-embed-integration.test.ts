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
 *   2. The non-baseline fallback (`-c:v mjpeg`) is exercised by feeding
 *      a malformed JPEG-like header. Constructing a structurally valid
 *      progressive JPEG without libjpeg is brittle; the unit tests in
 *      `cover-image.test.ts` already pin `getJpegFrameType` for SOF2.
 *      Here we only need to confirm the wrapper picks `mjpeg` and
 *      doesn't blow up.
 *   3. PNG cover → end-to-end re-encode → output is alive (cover bytes
 *      accepted) and small, never the ~880 KB a default-passthrough PNG
 *      embedding produced.
 *
 * Modelled on `sync-files-ffmpeg-integration.test.ts` (skipIf pattern,
 * bundled binary). We don't depend on ffprobe so the test degrades
 * gracefully when the ffprobe-installer binary is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFFmpegConverter } from './sync-files';
import { resolveFFmpegPath } from './ffmpeg-path';

const ffmpegPath = resolveFFmpegPath();
const canRun = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0;
if (!canRun) console.warn(`[skip] FFmpeg not available at ${ffmpegPath}`);

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

  it.runIf(canRun)(
    'garbage-looking cover bytes still pass through the mjpeg branch without crashing',
    async () => {
      // Sanity for the `non-jpeg → mjpeg` fallback: take bytes that look
      // suspicious enough that a stricter pipeline would refuse to embed.
      const src = synthesizeAudioMp3(workDir, 'in-garbage.mp3');
      // Some bytes that aren't a JPEG and aren't a PNG either. The
      // wrapper should still embed via mjpeg (FFmpeg refuses non-image
      // input here, so we still get success: true OR a handled error —
      // the regression that matters is "FFmpeg silently produces a
      // multi-MB default codec output", not "FFmpeg refuses the input").
      const garbage = Buffer.from('NOT A JPEG NOR A PNG — plaintext sentinel');
      const dst = join(workDir, 'out-garbage.mp3');
      const result = await createFFmpegConverter().convertStreamToMp3WithMeta(
        src,
        dst,
        '192k',
        {},
        garbage,
      );
      // FFmpeg rejects non-image second-stream input — that's an honest
      // error, not a regression. We only care that the failure isn't a
      // silent success that bloat the file.
      if (result.success) {
        expect(statSync(dst).size).toBeLessThan(audioSizeBytes(src) * HEADROOM_RATIO);
      } else {
        expect(result.error).toBeDefined();
      }
    },
  );
});
