/**
 * Tests for stripCoverArt fix (ORAIN-0476)
 *
 * The probe step in stripCoverArt was broken: ffmpeg was called with ffprobe
 * flags (-select_streams, -show_entries, -of csv=p=0), returning empty stdout
 * and causing hadCover=false, early return without stripping.
 *
 * Fix: remove probe step and always run ffmpeg -vn -c copy (no-op for files
 * without cover art).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFFmpegConverter } from './sync-files';

// Mock the ffmpeg-path module
vi.mock('./ffmpeg-path', () => ({
  resolveFFmpegPath: () => '/usr/local/bin/ffmpeg',
  resolveFFprobePath: () => '/usr/local/bin/ffprobe',
}));

describe('stripCoverArt (ORAIN-0476 fix)', () => {
  let spawnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock spawn to track calls
    spawnMock = vi.spyOn(require('child_process'), 'spawn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs ffmpeg -vn -c copy without a probe step', async () => {
    const { EventEmitter } = require('events');

    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/input.mp3', '/tmp/output.mp3');

    expect(result.success).toBe(true);
    // Should have exactly ONE spawn call (ffmpeg strip, no probe)
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Verify the single call uses ffmpeg with -vn -c copy (no ffprobe flags)
    const [[exe, args]] = spawnMock.mock.calls;
    expect(exe).toBe('/usr/local/bin/ffmpeg');
    expect(args).toContain('-vn');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    // Should NOT contain ffprobe-specific flags
    expect(args).not.toContain('-select_streams');
    expect(args).not.toContain('-show_entries');
    expect(args).not.toContain('-of');
  });

  it('returns success=true for file without cover art (no-op succeeds)', async () => {
    const { EventEmitter } = require('events');

    // ffmpeg -vn -c copy on a file without cover is a no-op that succeeds
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/no-cover.mp3', '/tmp/output.mp3');

    // The fix ensures no early return — ffmpeg runs and succeeds
    expect(result.success).toBe(true);
    // Result no longer has hadCover field — not useful since probe was removed
    expect(result).not.toHaveProperty('hadCover');
  });

  it('returns success=false when ffmpeg fails with error', async () => {
    const { EventEmitter } = require('events');

    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('error', new Error('ENOENT')), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/input.mp3', '/tmp/output.mp3');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FFmpeg strip error/);
  });

  it('returns success=false when ffmpeg exits with non-zero code', async () => {
    const { EventEmitter } = require('events');

    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('close', 1), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/input.mp3', '/tmp/output.mp3');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FFmpeg exited with code 1/);
  });
});
