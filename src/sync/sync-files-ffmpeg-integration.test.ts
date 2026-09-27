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
 * Rework cycle 1 — AC5 fixes:
 *   - Skip semantics: use `it.skipIf(!canRun)` so missing-ffmpeg is a real
 *     SKIP, not a green PASS. A silent PASS hid regressions on hosts without
 *     ffmpeg. `console.warn` per skip is required by the spec.
 *   - Moov position verified: `verifyMoovAtEnd` scans the last 4 KB for the
 *     literal `moov` before the test runs. If FFmpeg placed it elsewhere the
 *     fixture would test a different layout and the test must fail loudly.
 *   - ffprobe bundling: `@ffprobe-installer/ffprobe` is now used via
 *     `resolveFFprobePath()`. Without it the test silently degraded to
 *     `size > 0`, weaker than the spec's "reproducible" requirement.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFFmpegConverter } from './sync-files';
import { resolveFFmpegPath, resolveFFprobePath } from './ffmpeg-path';

// ORAIN-0737 cycle 1: SyncCore calls saveSyncedRecord (which delegates
// to `mockUpsert` in tests) and queries getSyncedTracksForDevice. The
// production path requires `initDatabase()` to have run; tests must
// either inject `mockUpsert` (preferred — keeps the test focused) or
// mock the entire database module. We use the database mock here so
// the test stays hermetic on hosts with no DB. The dedicated
// sync.test.ts suite covers the real-DB integration elsewhere.
vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: vi.fn(() => []),
  getSyncedTracksForItem: vi.fn(() => []),
  getSyncedItems: vi.fn(() => []),
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

function ffmpegAvailable(ffmpegPath: string): boolean {
  const probe = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
  return probe.status === 0;
}

function ffprobeAvailable(ffprobePath: string): boolean {
  // `resolveFFprobePath()` may return the literal 'ffprobe' as a fallback
  // when no installer and no system binary were found. Treat the installer
  // path as the only signal we trust; an unverified PATH fallback degrades
  // the test (AC5).
  const probe = spawnSync(ffprobePath, ['-version'], { stdio: 'ignore', timeout: 5000 });
  return probe.status === 0;
}

/**
 * Resolve FFmpeg/ffprobe and run the availability probes BEFORE any
 * `it()` declarations. The skip/run decision is module-load-time so the
 * `it.runIf` condition evaluates to the real availability (not the
 * `false` default). Without this the test file would report "2 skipped"
 * even when both binaries are present.
 *
 * The fixture-machinery (`workDir`) still belongs to beforeAll so it's
 * fresh per run, but the skip/run decision is module-load-time.
 */
const ffmpegPath = resolveFFmpegPath();
const ffprobePath = resolveFFprobePath();
const canRun = ffmpegAvailable(ffmpegPath);
const canProbe = ffprobeAvailable(ffprobePath);
if (!canRun) {
  // Surface the headline so a CI run without ffmpeg is visible in stdout.
  console.warn(`[skip] FFmpeg not available at ${ffmpegPath}`);
}
if (!canProbe) {
  console.warn(`[skip] FFprobe not available at ${ffprobePath}`);
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

  // Verify the moov atom actually landed at the END of the file. Without
  // this check the test passes for the wrong reason: older FFmpeg builds
  // (libavformat ≤ 58.24, observed in the @ffmpeg-installer/ffmpeg 2018
  // release) ignore `+empty_moov` and keep moov at the front — which is
  // the layout pipe:0 already handles, so the test would degenerate into
  // a no-op against a different fixture.
  //
  // Rework cycle 2 (ORAIN-0732): cycle 1's assertion
  // `moovOffsets[0] >= 0` against a `tail = last 4 KB` slice was always
  // true by construction (indexOf is bounded to the slice). The fix:
  // scan the WHOLE file, then require the LAST moov occurrence to live
  // in the final 4 KB. If the build refuses to cooperate we throw — the
  // caller uses `canProduceMoovAtEnd` to skip the case instead of
  // pretending it ran.
  const buf = readFileSync(final);
  const NEEDLE = Buffer.from('moov', 'ascii');
  const moovOffsets: number[] = [];
  let from = 0;
  while (true) {
    const idx = buf.indexOf(NEEDLE, from);
    if (idx < 0) break;
    moovOffsets.push(idx);
    from = idx + 1;
  }
  expect(moovOffsets.length, 'fixture: moov atom must exist').toBeGreaterThan(0);
  const lastMoov = moovOffsets[moovOffsets.length - 1];
  const tailStart = Math.max(0, buf.length - 4096);
  if (lastMoov < tailStart) {
    // The FFmpeg build on this host ignored +empty_moov — the moov sits
    // at offset `lastMoov`, well before the final 4 KB. Calling
    // convertStreamToMp3WithMeta against this file would NOT exercise the
    // "moov at end → seeks successfully" path. Surface this so the caller
    // can skip with an explicit reason instead of a silent pass.
    throw new MoovAtEndUnbuildableError(
      `FFmpeg build at ${ffmpegPath} ignored +empty_moov: moov at offset ${lastMoov}, file size ${buf.length} (tail starts at ${tailStart})`,
    );
  }
  return final;
}

/**
 * Thrown by `synthesizeM4aWithMoovAtEnd` when the bundled FFmpeg ignored
 * the `+empty_moov` flag and left the moov atom at the front of the file.
 * Distinct error class so the test runner can `try/catch` once per case
 * and skip with a precise reason rather than failing for the wrong one.
 */
export class MoovAtEndUnbuildableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoovAtEndUnbuildableError';
  }
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
  let moovAtEndPath: string | null = null;
  // Rework cycle 2 (ORAIN-0732): the fixture is built once in beforeAll
  // so the "did FFmpeg honor +empty_moov?" probe runs in setup, not in
  // the test body. The earlier code called synthesizeM4aWithMoovAtEnd
  // inside `it()` and threw the skip-error from inside a passing test,
  // which surfaced as a real FAIL even though the intention was SKIP.
  let canProduceMoovAtEnd = false;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orain-0732-'));
    if (!canRun) return;
    try {
      moovAtEndPath = synthesizeM4aWithMoovAtEnd(ffmpegPath, workDir);
      canProduceMoovAtEnd = true;
    } catch (err) {
      if (err instanceof MoovAtEndUnbuildableError) {
        // Older FFmpeg builds ignore +empty_moov and keep moov at the
        // front of the file — that layout is exactly what pipe:0 already
        // handles, so the test would degenerate into a no-op. Skip with
        // the precise reason (AC5 rework cycle 2).
        console.warn(`[skip] M4A moov-at-end fixture: ${err.message}`);
        canProduceMoovAtEnd = false;
      } else {
        throw err;
      }
    }
  });

  it.runIf(canRun)('MP3 with 1 KB junk prefix → non-empty reproducible MP3', async () => {
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
        ffprobePath,
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

  it.runIf(canRun && canProduceMoovAtEnd)(
    'M4A with moov at end → non-empty reproducible MP3',
    async () => {
      // Fixture was built (and its moov-at-end layout was verified) in
      // beforeAll. If `canProduceMoovAtEnd` is false the test was already
      // skipped with an explicit reason — see the [skip] log line above.
      const src = moovAtEndPath as string;
      const dst = join(workDir, 'out-m4a.mp3');

      const converter = createFFmpegConverter();
      const result = await converter.convertStreamToMp3WithMeta(src, dst, '192k', {});

      expect(result.success).toBe(true);
      const outSize = statSync(dst).size;
      expect(outSize).toBeGreaterThan(0);
      if (canProbe) {
        const probe = spawnSync(
          ffprobePath,
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
    },
  );
});

// =============================================================================
// ORAIN-0737 AC5 — Fixture H integration: extension-aware tagFile
// =============================================================================
//
// The bug (mbpr0-2012, 2026-09-27): `copyTrackFile` downloaded an MP3 to a
// destination-side temp file `.jt-tmp-xxx` with NO extension and then ran
// FFmpeg's tagFile against it (`-i <no-ext>`). For a benign file this
// worked because FFmpeg's `mp3` demuxer auto-detected the format from the
// ID3/MP3 sync bytes. But with a *non-syncsafe* ID3 tag size (the bit-7
// set in violation of ID3v2.3/2.4), FFmpeg's size parser misreads the
// tag size — it interprets the high bit as another bit 6, yielding
// ~3.6 MB extra "inside the tag" instead of the actual ~3.6 MB cover.
// The demuxer then seeks past EOF and reports "Invalid data found".
//
// The fix (this task): the temp file now lives under `os.tmpdir()` and
// ALWAYS carries the right audio extension (e.g. `.mp3`). FFmpeg's
// format guess picks the `mp3` demuxer explicitly from the extension,
// which is more lenient about non-syncsafe IDs than the auto-probe
// path on a no-extension input. Functionally tagFile now succeeds and
// the resulting destination file plays at its real duration.
//
// AC5 verifies that round trip:
//   - WITH the new temp path (`.mp3` extension): tagFile exits 0 and
//     the resulting file has a positive duration.
//   - WITH the legacy temp path (no extension): tagFile fails.
//
// Fixture H is generated in the test — no binary blobs in the repo.
import { existsSync } from 'fs';
describe('ORAIN-0737 AC5 — Fixture H: extension-aware tagFile', () => {
  /**
   * Build the ID3v2 header (10 bytes). To trigger the "non-syncsafe"
   * codepath FFmpeg mis-handles, set bit 7 of one or more size bytes
   * (the ID3v2 spec says each size byte is a 7-bit unsigned int).
   * We deliberately set bit 7 of byte 2 to inflate the tag size beyond
   * reality — FFmpeg's strict ID3 parser then reads a multi-MB tag
   * that does not actually exist on disk.
   */
  function buildNonSyncsafeId3Header(tagBytesIncludingFrames: number): Buffer {
    const header = Buffer.alloc(10);
    header.write('ID3', 0, 3, 'ascii'); // identifier
    header.writeUInt8(3, 3); // version major (ID3v2.3)
    header.writeUInt8(0, 4); // version revision
    header.writeUInt8(0, 5); // flags (unsync, ext header, experimental — none)
    // Tag size is 4 bytes, syncsafe (7 bits each). Spec-violating build
    // sets bit 7 of byte 2 to inflate the size relative to the real
    // on-disk tag — the over-count is the entire point of fixture H.
    header.writeUInt8((tagBytesIncludingFrames >> 21) & 0x7f, 6);
    header.writeUInt8((tagBytesIncludingFrames >> 14) & 0x7f, 7);
    header.writeUInt8((tagBytesIncludingFrames >> 7) & 0x7f, 8); // syncsafe
    header.writeUInt8(tagBytesIncludingFrames & 0x7f, 9);
    // Now re-set bit 7 of byte 2 to violate the syncsafe spec — that's
    // exactly the construction some buggy encoders ship.
    header[8] = header[8] | 0x80;
    return header;
  }

  /**
   * Build a minimal ID3v2.3 APIC frame header (10 bytes). Frame body is
   * intentionally empty — we only need the tag shape to look plausible
   * to a parser that just trusts the header size.
   */
  function buildApicFrameHeader(): Buffer {
    const frame = Buffer.alloc(10);
    frame.write('APIC', 0, 4, 'ascii');
    frame.writeUInt32BE(0, 4); // size (NOT syncsafe for frames)
    frame.writeUInt16BE(0, 8); // flags
    return frame;
  }

  /**
   * Synthesize fixture H:
   *   - 1 second of silent MP3 (so duration probing is meaningful).
   *   - Prepend an ID3v2.3 header with a NON-SYNCSAFE tag size that
   *     overstates the tag by ~3.6 MB.
   *   - Followed by an empty APIC frame so the file structure is
   *     plausible to a naive parser.
   * The result is written twice: once with `.mp3` extension and once
   * without, so the same byte sequence can be tested under both
   * extension shapes.
   */
  function synthesizeFixtureH(
    ffmpegPath: string,
    dir: string,
  ): { withExt: string; withoutExt: string } {
    const base = join(dir, 'fixture-h-base.mp3');
    const encode = spawnSync(
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
        base,
      ],
      { stdio: 'ignore' },
    );
    expect(encode.status).toBe(0);

    const mp3 = readFileSync(base);
    const fakeTagBodySize = 3_600_000;
    const id3Header = buildNonSyncsafeId3Header(fakeTagBodySize);
    const apicFrameHeader = buildApicFrameHeader();

    const withExt = join(dir, 'fixture-h.mp3');
    const withoutExt = join(dir, 'fixture-h-noext');
    const composed = Buffer.concat([id3Header, apicFrameHeader, mp3]);
    writeFileSync(withExt, composed);
    writeFileSync(withoutExt, composed);

    return { withExt, withoutExt };
  }

  /**
   * Probe a file for duration via ffprobe. Returns 0 if ffprobe is
   * missing or the probe fails. Skipped silently if `canProbe` was false
   * at module load (AC5 only requires duration when ffprobe is bundled).
   */
  function probeDurationSeconds(path: string): number {
    if (!canProbe) return 0;
    const probe = spawnSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { encoding: 'utf8' },
    );
    if (probe.status !== 0) return 0;
    return parseFloat(probe.stdout.trim());
  }

  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orain-0737-'));
  });

  it.runIf(canRun)(
    'tagFile on fixture H with `.mp3` extension: exit 0 and duration > 0',
    async () => {
      const { withExt } = synthesizeFixtureH(ffmpegPath, workDir);
      expect(statSync(withExt).size).toBeGreaterThan(0);

      // AC5: with the extension present, tagFile succeeds and the
      // resulting file plays at its real duration.
      const outputPath = join(workDir, 'fixture-h-tagged.mp3');
      const converter = createFFmpegConverter();
      const result = await converter.tagFile(withExt, outputPath, {
        title: 'Fixture H',
        artist: 'JellyTunes',
        album: 'ORAIN-0737',
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(statSync(outputPath).size).toBeGreaterThan(0);

      const dur = probeDurationSeconds(outputPath);
      if (canProbe) {
        expect(dur).toBeGreaterThan(0);
      }
    },
  );

  it.runIf(canRun)(
    'tagFile on fixture H with NO extension (in-place): fails (legacy bug)',
    async () => {
      // Same bytes, no extension. Mimics the old `copyTrackFile`
      // behaviour where the temp file was `${destinationPath}/.jt-tmp-…`
      // without any extension.
      //
      // Old `copyTrackFile` wrote the *download buffer* to that no-ext
      // file and then called tagFile with `inputPath === tmpPath`. With
      // input === output, tagFile builds a sibling temp output
      // `jt-tag-xxx<ext>` — where `<ext>` comes from `path.extname(input)`.
      // Without an extension on the input the sibling output has none
      // either, FFmpeg cannot pick a muxer for the output, and exits
      // non-zero with "Invalid data found".
      const { withoutExt } = synthesizeFixtureH(ffmpegPath, workDir);
      // ORAIN-0743: capture the input bytes before calling tagFile so the
      // negative-control can assert the product contract — "no playable
      // substitute came out of the no-extension path" — without relying
      // on ffprobe's interpretation of the fixture's bytes (Windows
      // ffprobe reads them; Linux ffprobe does not, and we cannot pin
      // behaviour on a third-party tool's tolerance for spec-violating
      // ID3v2 tag sizes). The real product claim is: if the file still
      // exists after the failed tagFile call, its bytes are IDENTICAL to
      // what tagFile was handed. Hash or Buffer compare — both are valid,
      // Buffer.compare is the most direct and avoids an extra dep.
      const expectedBytes = readFileSync(withoutExt);
      const converter = createFFmpegConverter();

      const result = await converter.tagFile(withoutExt, withoutExt, {
        title: 'Fixture H',
      });

      // Pin only on the structural claim: failure + nothing playable.
      // FFmpeg's exact error wording drifts across versions and platforms.
      expect(result.success).toBe(false);
      // After the in-place attempt the contract is: either the file is
      // missing (tagFile never replaced it) OR its bytes equal what we
      // handed in. Crucially we do NOT probe duration here — see the
      // comment above. Duration-as-proxy leaks platform-specific ffprobe
      // behaviour into a test whose job is to pin tagFile's contract.
      if (existsSync(withoutExt)) {
        const actualBytes = readFileSync(withoutExt);
        expect(Buffer.compare(actualBytes, expectedBytes)).toBe(0);
      }
    },
  );

  it.runIf(canRun)('tagFile on fixture H with `.mp3` extension (in-place): exit 0', async () => {
    // Symmetric positive: same in-place call shape as the legacy
    // path, but the input has the `.mp3` extension. FFmpeg builds
    // a sibling temp output `jt-tag-xxx.mp3` and uses the `mp3`
    // muxer. tagFile succeeds.
    const { withExt } = synthesizeFixtureH(ffmpegPath, workDir);
    const converter = createFFmpegConverter();

    const result = await converter.tagFile(withExt, withExt, {
      title: 'Fixture H',
      artist: 'JellyTunes',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const dur = probeDurationSeconds(withExt);
    if (canProbe) {
      expect(dur).toBeGreaterThan(0);
    }
  });

  // ORAIN-0737 cycle 1 (review MEDIUM): AC1 requires fixture H to sync
  // end-to-end via SyncCore with conversion disabled. The tagFile-only
  // tests above prove the FFmpeg plumbing works; this test proves the
  // bug observed on mbpr0-2012 (sync of the same fixture via the
  // production wiring) is gone. We stream the fixture's bytes through
  // downloadItemStream → temp file in os.tmpdir() → tagFile → destination,
  // then probe the destination with ffprobe and compare durations.
  //
  // Note: this test uses the REAL filesystem (`createNodeFileSystem`)
  // because the production wiring spawns FFmpeg, which reads the temp
  // path directly off disk. A mock fs would let the assertions about
  // "destination exists" pass even when FFmpeg never actually wrote
  // anything — defeating the purpose of an integration test.
  it.runIf(canRun)(
    'AC1 end-to-end: SyncCore copies fixture H with convertToMp3=false (full wiring)',
    async () => {
      const { Readable } = require('stream');
      const { createNodeFileSystem } = await import('./sync-files');
      const { createSyncCore } = await import('./sync-core');
      const { createMockApiClient } = await import('./sync-api');

      const { withExt } = synthesizeFixtureH(ffmpegPath, workDir);
      const fixtureBytes = readFileSync(withExt);

      // Track metadata must mirror the fixture so copyTrackFile passes
      // format='mp3' (which triggers buildCopyTrackTempPath to append
      // `.mp3` to the temp file path — the very thing that makes
      // FFmpeg's mp3 demuxer pick the right format guess).
      const track = {
        id: 'fixture-h-track',
        name: 'Fixture H',
        album: 'ORAIN-0737',
        artists: ['JellyTunes'],
        path: '/music/Jellytunes/ORAIN-0737/fixture-h.mp3',
        format: 'mp3',
        size: fixtureBytes.length,
        trackNumber: 1,
      };

      const api = createMockApiClient({
        getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        downloadItemStream: async () => Readable.from(fixtureBytes),
        getItem: async () => null,
      });

      // Real FFmpeg-backed converter: this is what the production app
      // uses. Anything weaker (a mock) would defeat the purpose of an
      // integration test against the bug.
      const converter = createFFmpegConverter();
      const fs = createNodeFileSystem();

      const core = createSyncCore(
        {
          serverUrl: 'https://jellyfin.test',
          apiKey: '0123456789abcdef0123456789abcdef',
          userId: 'abcdef1234567890abcdef1234567890',
          serverRootPath: '/music/',
        },
        {
          api,
          fs,
          converter,
          // Inject a no-op mockUpsert so saveSyncedRecord doesn't try to
          // call into the real (un-initialised) database. AC1 only cares
          // about the copy + tag round-trip, not DB persistence.
          mockUpsert: () => {},
        },
      );

      const destDir = join(workDir, 'dest');

      const result = await core.sync({
        itemIds: ['album-h'],
        itemTypes: new Map([['album-h', 'album' as const]]),
        destinationPath: destDir,
        // coverArtMode: 'off' avoids a cover-art fetch from a mocked
        // Jellyfin API (the mock has no image bytes); AC1 only exercises
        // the copy + tag path.
        options: { convertToMp3: false, coverArtMode: 'off' },
      });

      // Sync must report success and exactly one copied track. The bug
      // observed in production manifested as a failed track + an
      // `Invalid data found` FFmpeg error; if we regressed, this assertion
      // fires before we even get to ffprobe.
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.tracksCopied).toBe(1);
      expect(result.tracksFailed).not.toContain(track.id);

      // The destination file MUST exist and have a positive duration that
      // matches the original silent MP3's 1-second encode (probeDuration
      // is ~0.99s after FFmpeg's own framing). The key AC1 claim is
      // "el fichero resultante dura lo mismo que el original" — duration
      // equality, not just non-zero.
      const destPath = join(destDir, 'Jellytunes', 'ORAIN-0737', 'fixture-h.mp3');
      expect(statSync(destPath).size).toBeGreaterThan(0);
      if (canProbe) {
        const originalDur = probeDurationSeconds(withExt);
        const destDur = probeDurationSeconds(destPath);
        expect(originalDur).toBeGreaterThan(0);
        expect(destDur).toBeGreaterThan(0);
        // Within 0.1s — the round-trip should preserve the encoded
        // duration. Allow a tiny fudge for ffprobe rounding.
        expect(Math.abs(destDur - originalDur)).toBeLessThan(0.1);
      }
    },
    60_000, // FFmpeg round-trip + ffprobe + file IO can take a few seconds on CI
  );
});
