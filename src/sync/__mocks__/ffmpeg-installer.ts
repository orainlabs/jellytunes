/**
 * Mock for @ffmpeg-installer/ffmpeg
 * Returns a fake path so resolveFFmpegPath() doesn't throw during tests.
 * The actual FFmpeg calls are mocked via child_process.spawn override.
 */
module.exports = {
  path: '/usr/local/bin/ffmpeg',
  version: '6.0.0-mock',
};