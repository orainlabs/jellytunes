/**
 * ORAIN-0732 — AC1/AC2: convertStreamToMp3WithMeta and convertStreamToMp3
 * accept an input PATH (not a stream) and pass it to FFmpeg as
 * -i file:<absolute path>. No createReadStream in the hot path. The temp
 * file extension is derived from track.format.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createFFmpegConverter } from './sync-files';
import { buildConvertTempPath } from './temp-path';
import type { SyncLogger } from './types';

interface SpawnCall {
  args: string[];
  stdio: unknown;
}

function captureSpawn() {
  const calls: SpawnCall[] = [];
  const cp = require('child_process');
  const originalSpawn = cp.spawn;
  cp.spawn = function (_cmd: string, args: string[], opts: unknown) {
    calls.push({ args, stdio: (opts as { stdio?: unknown })?.stdio });
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const proc = {
      on: function (event: string, cb: (arg: number | Error) => void) {
        if (event === 'close') setTimeout(() => cb(0), 0);
        return proc;
      },
      stdin,
      stdout: new PassThrough(),
      stderr,
      kill: () => stdin.destroy(),
    };
    return proc;
  };
  return {
    calls,
    restore: () => {
      cp.spawn = originalSpawn;
    },
  };
}

describe('ORAIN-0732 AC1 — convert*ToMp3 reads input by path', () => {
  afterEach(() => {
    // Best-effort: nothing to restore here, captureSpawn already restores
    // explicitly in each test via the returned .restore() handle.
  });

  it('convertStreamToMp3WithMeta passes -i file:<path> (not pipe:0) and skips stdin pipe', async () => {
    const spawn = captureSpawn();
    try {
      const converter = createFFmpegConverter({} as SyncLogger);
      const tmpPath = '/tmp/jt-tmp-12345.flac';
      const outPath = '/tmp/out.mp3';
      const result = await converter.convertStreamToMp3WithMeta(tmpPath, outPath, '192k', {
        title: 'T',
      });
      expect(result.success).toBe(true);

      const last = spawn.calls[spawn.calls.length - 1];
      const inputIdx = last.args.indexOf('-i');
      expect(inputIdx).toBeGreaterThanOrEqual(0);
      expect(last.args[inputIdx + 1]).toBe(`file:${tmpPath}`);
      expect(last.args).not.toContain('pipe:0');
      // stdin no longer needs to be writable — stdio[0] should be 'ignore'
      expect((last.stdio as string[])[0]).toBe('ignore');
    } finally {
      spawn.restore();
    }
  });

  it('convertStreamToMp3 (no meta) passes -i file:<path>', async () => {
    const spawn = captureSpawn();
    try {
      const converter = createFFmpegConverter({} as SyncLogger);
      const tmpPath = '/tmp/jt-tmp-12345.flac';
      const outPath = '/tmp/out.mp3';
      const result = await converter.convertStreamToMp3(tmpPath, outPath, '192k');
      expect(result.success).toBe(true);

      const last = spawn.calls[spawn.calls.length - 1];
      const inputIdx = last.args.indexOf('-i');
      expect(last.args[inputIdx + 1]).toBe(`file:${tmpPath}`);
      expect((last.stdio as string[])[0]).toBe('ignore');
    } finally {
      spawn.restore();
    }
  });
});

describe('ORAIN-0732 AC2/AC4 — temp path extension helper', () => {
  // The contract is now expressed via `buildConvertTempPath` from
  // ./temp-path (the production helper), so the AC2/AC4 invariants are
  // exercised against the real implementation rather than a regex
  // duplicate that drift apart from sync-core.
  function deriveTempExt(format: string | undefined): string | undefined {
    const result = buildConvertTempPath(format, 1) as string;
    const dot = result.lastIndexOf('.');
    // No extension at all → undefined.
    if (dot < 0 || dot === result.length - 1) return undefined;
    const ext = result.slice(dot + 1);
    return /^[a-z0-9]+$/.test(ext) ? `.${ext}` : undefined;
  }

  it('lowercases and strips leading dot', () => {
    expect(deriveTempExt('flac')).toBe('.flac');
    expect(deriveTempExt('M4A')).toBe('.m4a');
    expect(deriveTempExt('.mp3')).toBe('.mp3');
    expect(deriveTempExt('  ogg  ')).toBe('.ogg');
  });

  it('returns undefined for empty / unsafe values', () => {
    expect(deriveTempExt(undefined)).toBeUndefined();
    expect(deriveTempExt('')).toBeUndefined();
    expect(deriveTempExt('..')).toBeUndefined();
    expect(deriveTempExt('not a format')).toBeUndefined();
    expect(deriveTempExt('../etc/passwd')).toBeUndefined();
  });

  // AC4 rework cycle 1 — membership check against ALL_AUDIO_EXTENSIONS.
  // The old regex-only form accepted any [a-z0-9]+ value; the new helper
  // must drop unknown formats even when well-formed so FFmpeg falls back
  // to content-sniffing rather than mis-sniffing the temp file.
  it('AC4: drops unknown / well-formed formats not in ALL_AUDIO_EXTENSIONS', () => {
    expect(deriveTempExt('xyz')).toBeUndefined();
    expect(deriveTempExt('unknown')).toBeUndefined();
    expect(deriveTempExt('foobar')).toBeUndefined();
    // Path-traversal-shaped strings: still rejected, and now also by the
    // membership check (not just the regex).
    expect(deriveTempExt('../../etc/passwd')).toBeUndefined();
  });

  // AC4 rework cycle 1 — comma-separated lists. Spec: take the first value.
  it('AC4: comma-separated lists use only the first value', () => {
    // 'mp3,mp4' — first is known (mp3), second unknown; spec says keep .mp3
    expect(deriveTempExt('mp3,mp4')).toBe('.mp3');
    // 'unknown,flac' — first is unknown → drop entirely
    expect(deriveTempExt('unknown,flac')).toBeUndefined();
  });
});
