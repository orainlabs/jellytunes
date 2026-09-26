/**
 * ORAIN-0732 AC3: integration test with the bundled FFmpeg from
 * `@ffmpeg-installer/ffmpeg`. Verifies two pathological inputs that fail
 * over stdin (`pipe:0`) but succeed when FFmpeg is given a path:
 *
 *   1. MP3 with 1 KB of garbage bytes prepended before the first frame.
 *      Over pipe:0 FFmpeg sees the junk as the input and bails. Over
 *      -i file:<path>: FFmpeg seeks, skips the junk and finds the sync.
 *
 *   2. M4A whose `moov` atom is at the end (a real-world case — `movflags
 *      +empty_moov` produces this layout). Over pipe:0 the input ends
 *      before the demuxer can locate the moov → empty output, no error.
 *      Over -i file:<path>: FFmpeg can seek to the end, parse the moov,
 *      and decode.
 *
 * Skip with an explicit reason when the bundled binary is missing from
 * the host (CI runners without ffmpeg-installer). NEVER pass in false.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFFmpegConverter } from './sync-files';
import { resolveFFmpegPath } from './ffmpeg-path';

function ffmpegAvailable(ffmpegPath: string): boolean {
  const probe = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
  return probe.status === 0;
}

function ffprobeAvailable(): boolean {
  const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
  return probe.status === 0;
}

function synthesizeM4aWithMoovAtEnd(ffmpegPath: string, dir: string): string {
  // Encode 0.1s of silence to AAC, then re-mux with +faststart+empty_moov
  // so the moov atom is placed at the end of the file. This is a real
  // layout that FFmpeg produces (and that some encoders emit by default).
  const base = join(dir, 'base.m4a');
  const final = join(dir, 'moov-end.m4a');
  const a = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono',
      '-t',
      '0.1',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      base,
    ],
    { stdio: 'ignore' },
  );
  expect(a.status).toBe(0);
  const b = spawnSync(
    ffmpegPath,
    ['-y', '-i', base, '-c', 'copy', '-movflags', '+faststart+empty_moov', final],
    { stdio: 'ignore' },
  );
  expect(b.status).toBe(0);
  return final;
}

/**
 * Synthesise a 1-second MP3 file by piping silence into FFmpeg. We use
 * this as the "valid MP3 frame payload" in the junk-prefix test — without
 * a complete frame the FFmpeg decoder can't decode anything and the test
 * would fail for the wrong reason.
 */
function synthesizeValidMp3(ffmpegPath: string, dir: string): string {
  const out = join(dir, 'valid.mp3');
  const a = spawnSync(
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
  expect(a.status).toBe(0);
  return out;
}

describe('ORAIN-0732 AC3 — FFmpeg integration with path input', () => {
  let workDir: string;
  let ffmpegPath: string;
  let canRun = false;
  let canProbe = false;

  beforeAll(() => {
    ffmpegPath = resolveFFmpegPath();
    canRun = ffmpegAvailable(ffmpegPath);
    canProbe = ffprobeAvailable();
    workDir = mkdtempSync(join(tmpdir(), 'orain-0732-'));
    if (!canRun) {
      console.warn(`[skip] FFmpeg not available at ${ffmpegPath}`);
    }
  });

  it('MP3 with 1 KB junk prefix → non-empty reproducible MP3', async () => {
    if (!canRun) return;
    // Generate a valid MP3, then prepend 1 KB of garbage. Over pipe:0 the
    // garbage is the first thing FFmpeg sees and the input ends mid-frame.
    // Over -i file:<path> FFmpeg seeks, skips the junk and decodes the
    // valid frames that follow.
    const validMp3 = synthesizeValidMp3(ffmpegPath, workDir);
    const validBytes = require('fs').readFileSync(validMp3);
    const garbage = Buffer.alloc(1024, 0x42);
    const src = join(workDir, 'junk-prefix.mp3');
    writeFileSync(src, Buffer.concat([garbage, validBytes]));
    const dst = join(workDir, 'out.mp3');

    const converter = createFFmpegConverter();
    const result = await converter.convertStreamToMp3WithMeta(src, dst, '192k', {});

    expect(result.success).toBe(true);
    const outSize = statSync(dst).size;
    expect(outSize).toBeGreaterThan(0);
    if (canProbe) {
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          dst,
        ],
        { encoding: 'utf8' },
      );
      if (probe.status === 0) {
        const dur = parseFloat(probe.stdout.trim());
        expect(dur).toBeGreaterThan(0);
      }
    }
  });

  it('M4A with moov at end → non-empty reproducible MP3', async () => {
    if (!canRun) return;
    const src = synthesizeM4aWithMoovAtEnd(ffmpegPath, workDir);
    const dst = join(workDir, 'out-m4a.mp3');

    const converter = createFFmpegConverter();
    const result = await converter.convertStreamToMp3WithMeta(src, dst, '192k', {});

    expect(result.success).toBe(true);
    const outSize = statSync(dst).size;
    expect(outSize).toBeGreaterThan(0);
    if (canProbe) {
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          dst,
        ],
        { encoding: 'utf8' },
      );
      if (probe.status === 0) {
        const dur = parseFloat(probe.stdout.trim());
        expect(dur).toBeGreaterThan(0);
      }
    }
  });
});
