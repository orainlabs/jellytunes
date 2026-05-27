/**
 * Tests for path validation in sync-files (issue ORAIN-0227)
 *
 * Verifies that tagFile rejects paths with FFmpeg protocols or path traversal
 * as defense-in-depth validation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFFmpegConverter } from './sync-files';

// Mock the ffmpeg-path module to avoid actual FFmpeg dependency in tests
vi.mock('./ffmpeg-path', () => ({
  resolveFFmpegPath: () => '/usr/local/bin/ffmpeg',
  resolveFFprobePath: () => '/usr/local/bin/ffprobe',
}));

describe('assertFilesystemPath (via tagFile)', () => {
  // We test the validation indirectly through tagFile since assertFilesystemPath
  // is a private function. tagFile is the public interface that uses it.

  const converter = createFFmpegConverter();

  // Minimal valid metadata
  const validMeta = {
    title: 'Test',
    artist: 'Artist',
    album: 'Album',
    year: '2024',
    trackNumber: '1',
    discNumber: '1',
  };

  describe('rejects FFmpeg protocol paths', () => {
    it('rejects pipe input protocol', async () => {
      await expect(converter.tagFile('pipe:0', '/tmp/output.mp3', validMeta)).rejects.toThrow(
        /FFmpeg protocol URIs are not allowed/,
      );
    });

    it('rejects file protocol with double slash', async () => {
      await expect(
        converter.tagFile('file:///tmp/input.mp3', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/FFmpeg protocol URIs are not allowed/);
    });

    it('rejects data: protocol', async () => {
      await expect(
        converter.tagFile('data:image/png;base64,xxxx', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/FFmpeg protocol URIs are not allowed/);
    });

    it('rejects http:// protocol', async () => {
      await expect(
        converter.tagFile('http://evil.com/input.mp3', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/FFmpeg protocol URIs are not allowed/);
    });

    it('rejects output path with protocol too', async () => {
      await expect(converter.tagFile('/tmp/input.mp3', 'pipe:1', validMeta)).rejects.toThrow(
        /FFmpeg protocol URIs are not allowed/,
      );
    });
  });

  describe('rejects path traversal', () => {
    it('rejects input path with ../ traversal', async () => {
      await expect(
        converter.tagFile('/tmp/../../../etc/passwd', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/local filesystem path/);
    });

    it('rejects output path with ../ traversal', async () => {
      await expect(
        converter.tagFile('/tmp/input.mp3', '/tmp/../../../etc/passwd', validMeta),
      ).rejects.toThrow(/local filesystem path/);
    });

    it('rejects input path with .. in middle of path', async () => {
      await expect(
        converter.tagFile('/tmp/../home/user/file.mp3', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/local filesystem path/);
    });

    it('rejects empty string input path', async () => {
      await expect(converter.tagFile('', '/tmp/output.mp3', validMeta)).rejects.toThrow(
        /non-empty string/,
      );
    });
  });

  describe('rejects non-absolute paths', () => {
    it('rejects relative input path', async () => {
      await expect(
        converter.tagFile('relative/path.mp3', '/tmp/output.mp3', validMeta),
      ).rejects.toThrow(/must be absolute/);
    });
  });
});

describe('stripCoverArt (AC-2 implementation guards)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves without throwing when ffmpeg spawn emits error', async () => {
    const { EventEmitter } = require('events');

    vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('error', new Error('spawn ENOENT')), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/input.mp3', '/tmp/output.mp3');
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('FFmpeg strip error'),
    });
  });

  it('uses a temp file and renames atomically when inputPath === outputPath', async () => {
    const { EventEmitter } = require('events');
    const fs = require('fs');
    const os = require('os');

    const renameSyncSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    });

    const conv = createFFmpegConverter();
    const result = await conv.stripCoverArt('/tmp/track.mp3', '/tmp/track.mp3');

    expect(result.success).toBe(true);
    // renameSync must be called to atomically replace the original
    expect(renameSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining(os.tmpdir()),
      '/tmp/track.mp3',
    );
  });
});
