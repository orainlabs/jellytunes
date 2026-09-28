/**
 * FFmpeg error reporting — ORAIN-0726.
 *
 * When FFmpeg exits with a non-zero code, the `error` field returned to the
 * renderer must include the real cause from FFmpeg's stderr, not just the
 * exit code. This lets the "Sync failed" popup tell the user something
 * actionable (e.g. "No such file or directory", "Invalid data found when
 * processing input") instead of just "FFmpeg exited with code 1".
 *
 * The full stderr is still logged via the logger for diagnostics.
 * If stderr is empty, the error falls back to the previous wording.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createFFmpegConverter, lastFFmpegError, ffmpegErrorMessage } from './sync-files';
import type { SyncLogger } from './types';

/**
 * Spawn mock that emits the given stderr chunks and then closes with the
 * given code. stdin is a real PassThrough so `inputStream.pipe(proc.stdin)`
 * works. The mock does NOT emit 'error' on its own — only 'close' with the
 * configured exit code, so tests can exercise the close-time error path.
 */
function mockSpawnWithStderr(stderrChunks: string[], closeCode: number) {
  const calls: { args: string[]; stdio: unknown; stderrChunks: string[] }[] = [];
  const cp = require('child_process');
  const originalSpawn = cp.spawn;
  cp.spawn = function (_cmd: string, args: string[], opts: unknown) {
    calls.push({ args, stdio: (opts as { stdio?: unknown })?.stdio, stderrChunks });
    const stderrHandlers: Array<(chunk: Buffer) => void> = [];
    const stdin = new PassThrough();
    const mockProc = {
      on: function (event: string, cb: (arg: number | Error) => void) {
        if (event === 'close') {
          // Emit stderr first, then close
          for (const chunk of stderrChunks) {
            for (const h of stderrHandlers) h(Buffer.from(chunk));
          }
          setTimeout(() => cb(closeCode), 0);
        }
        return mockProc;
      },
      emit: () => mockProc,
      removeAllListeners: () => mockProc,
      kill: () => {
        stdin.destroy();
      },
      stdin,
      stdout: { on: () => {} },
      stderr: {
        on: function (event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data') stderrHandlers.push(cb);
          return mockProc.stderr;
        },
      },
    };
    return mockProc;
  } as typeof cp.spawn;
  return {
    calls,
    restore: () => {
      cp.spawn = originalSpawn;
    },
  };
}

describe('createFFmpegConverter error reporting — ORAIN-0726', () => {
  beforeEach(() => {
    // Silence stderr from logger during tests
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Pure helper unit tests — easiest way to cover every branch of
  // lastFFmpegError without faking the whole spawn pipeline.
  // ---------------------------------------------------------------------------

  describe('lastFFmpegError', () => {
    it('returns undefined when stderr is empty', () => {
      expect(lastFFmpegError('')).toBeUndefined();
    });

    it('returns undefined when stderr contains only whitespace and newlines', () => {
      expect(lastFFmpegError('\n\n   \n')).toBeUndefined();
    });

    it('returns the last non-empty line when stderr has multiple lines', () => {
      expect(lastFFmpegError('first\nsecond\nthird')).toBe('third');
    });

    it('trims trailing whitespace from the last line', () => {
      expect(lastFFmpegError('first\nthird   \n')).toBe('third');
    });

    it('handles CRLF line endings', () => {
      expect(lastFFmpegError('first\r\nsecond\r\nthird\r\n')).toBe('third');
    });

    it('truncates the last line to maxLength (default 200)', () => {
      const long = 'A'.repeat(500);
      expect(lastFFmpegError(long)).toBe('A'.repeat(200));
    });

    it('accepts a custom maxLength', () => {
      expect(lastFFmpegError('abcdefghij', 3)).toBe('abc');
    });
  });

  describe('ffmpegErrorMessage', () => {
    it('returns plain "FFmpeg exited with code N" when stderr has no tail', () => {
      expect(ffmpegErrorMessage(1, '')).toBe('FFmpeg exited with code 1');
    });

    it('appends the stderr tail after a colon when present', () => {
      expect(ffmpegErrorMessage(2, 'No such file or directory')).toBe(
        'FFmpeg exited with code 2: No such file or directory',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // AC2 + AC4: every method that sync-core calls must surface stderr
  // ---------------------------------------------------------------------------

  describe('convertToMp3', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\nNo such file or directory\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const errorLogs: string[] = [];
      const logger: SyncLogger = {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (msg: string) => {
          errorLogs.push(msg);
        },
        trackFailed: () => {},
      };
      const converter = createFFmpegConverter(logger);

      try {
        const result = await converter.convertToMp3('/abs/in.flac', '/abs/out.mp3', '192k');
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1: No such file or directory');
        // AC3: full stderr reaches the logger
        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0]).toContain(stderrText);
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      try {
        const result = await converter.convertToMp3('/abs/in.flac', '/abs/out.mp3', '192k');
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  describe('convertStreamToMp3WithMeta', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\n  Stream #0:0: Audio\nNo such file or directory\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const errorLogs: string[] = [];
      const logger: SyncLogger = {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (msg: string) => {
          errorLogs.push(msg);
        },
        trackFailed: () => {},
      };
      const converter = createFFmpegConverter(logger);
      // ORAIN-0732: signature switched from Readable to path. We pass a
      // fake absolute path because the test mocks spawn and never opens it.
      const inputPath = '/abs/fake-input.mp3';

      try {
        const result = await converter.convertStreamToMp3WithMeta(
          inputPath,
          '/abs/out.mp3',
          '192k',
          { title: 'T' },
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1: No such file or directory');
        // AC3: logger still gets the FULL stderr untruncated
        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0]).toContain(stderrText);
        // Stderr was piped (otherwise we wouldn't have captured it).
        // stdin is now 'ignore' because we read input by path — ORAIN-0732.
        const lastCall = mock.calls[mock.calls.length - 1];
        expect(lastCall.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      const inputPath = '/abs/fake-input.mp3';

      try {
        const result = await converter.convertStreamToMp3WithMeta(
          inputPath,
          '/abs/out.mp3',
          '192k',
          { title: 'T' },
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  describe('tagFile', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\nInvalid data found when processing input\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const errorLogs: string[] = [];
      const logger: SyncLogger = {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (msg: string) => {
          errorLogs.push(msg);
        },
        trackFailed: () => {},
      };
      const converter = createFFmpegConverter(logger);

      try {
        const result = await converter.tagFile('/abs/in.mp3', '/abs/out.mp3', { title: 'T' });
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          'FFmpeg exited with code 1: Invalid data found when processing input',
        );
        // AC3: full stderr reaches the logger
        expect(errorLogs[0]).toContain(stderrText);
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      try {
        const result = await converter.tagFile('/abs/in.mp3', '/abs/out.mp3', { title: 'T' });
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  describe('stripCoverArt', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\nPermission denied\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const errorLogs: string[] = [];
      const logger: SyncLogger = {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (msg: string) => {
          errorLogs.push(msg);
        },
        trackFailed: () => {},
      };
      const converter = createFFmpegConverter(logger);

      try {
        const result = await converter.stripCoverArt('/abs/in.mp3', '/abs/out.mp3');
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1: Permission denied');
        // AC3: full stderr reaches the logger
        expect(errorLogs[0]).toContain(stderrText);
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      try {
        const result = await converter.stripCoverArt('/abs/in.mp3', '/abs/out.mp3');
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  describe('embedLyrics', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\nFormat mp3 detected only loosely\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const errorLogs: string[] = [];
      const logger: SyncLogger = {
        info: () => {},
        warn: (m: string) => {
          errorLogs.push(m);
        },
        debug: () => {},
        error: (m: string) => {
          errorLogs.push(m);
        },
        trackFailed: () => {},
      };
      const converter = createFFmpegConverter(logger);

      try {
        const result = await converter.embedLyrics(
          '/abs/in.mp3',
          '/abs/out.mp3',
          '[00:00]lyrics',
          'mp3',
        );
        expect(result.success).toBe(false);
        // embedLyrics already had its own format; verify the stderr tail is included
        expect(result.error).toContain('FFmpeg exited with code 1');
        expect(result.error).toContain('Format mp3 detected only loosely');
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      try {
        const result = await converter.embedLyrics(
          '/abs/in.mp3',
          '/abs/out.mp3',
          '[00:00]lyrics',
          'mp3',
        );
        expect(result.success).toBe(false);
        // When stderr is empty, must not add the spurious colon
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  describe('embedReplayGain', () => {
    it('AC2: includes last non-empty stderr line in error when FFmpeg exits with code 1', async () => {
      const stderrText = 'ffmpeg version 6.1\nCould not write header\n';
      const mock = mockSpawnWithStderr([stderrText], 1);
      const converter = createFFmpegConverter();

      try {
        const result = await converter.embedReplayGain(
          '/abs/in.flac',
          '/abs/out.flac',
          { trackGain: '-6.50', trackPeak: '0.95' },
          'flac',
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1: Could not write header');
      } finally {
        mock.restore();
      }
    });

    it('AC4: preserves plain "FFmpeg exited with code N" when stderr is empty', async () => {
      const mock = mockSpawnWithStderr([], 1);
      const converter = createFFmpegConverter();
      try {
        const result = await converter.embedReplayGain(
          '/abs/in.flac',
          '/abs/out.flac',
          { trackGain: '-6.50', trackPeak: '0.95' },
          'flac',
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('FFmpeg exited with code 1');
      } finally {
        mock.restore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation: 200-char cap on the stderr tail surfaced in `error`
  // ---------------------------------------------------------------------------

  describe('stderr truncation', () => {
    it('truncates the stderr tail to 200 characters in the error field', async () => {
      const longTail = 'A'.repeat(500);
      const stderrText = `ffmpeg version 6.1\n${longTail}\n`;
      const mock = mockSpawnWithStderr([stderrText], 1);
      const converter = createFFmpegConverter();

      try {
        const result = await converter.convertStreamToMp3WithMeta(
          '/abs/fake-input.mp3',
          '/abs/out.mp3',
          '192k',
          { title: 'T' },
        );
        expect(result.success).toBe(false);
        // Expect error to be `FFmpeg exited with code 1: <first 200 chars of tail>`
        const tail = longTail.slice(0, 200);
        expect(result.error).toBe(`FFmpeg exited with code 1: ${tail}`);
      } finally {
        mock.restore();
      }
    });
  });
});
