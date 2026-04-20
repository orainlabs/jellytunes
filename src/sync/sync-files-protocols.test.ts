import { describe, it, expect } from 'vitest';
import { assertFilesystemPath } from './sync-files';

describe('assertFilesystemPath', () => {
  it('throws on FFmpeg pipe: protocol', () => {
    expect(() => assertFilesystemPath('pipe:1')).toThrow();
    expect(() => assertFilesystemPath('pipe:0')).toThrow();
  });

  it('throws on FFmpeg concat: protocol', () => {
    expect(() => assertFilesystemPath('concat:list.txt')).toThrow();
    expect(() => assertFilesystemPath('CONCAT:file.mp3')).toThrow();
  });

  it('throws on other FFmpeg URI protocols', () => {
    expect(() => assertFilesystemPath('http://evil.com/output.mp3')).toThrow();
    expect(() => assertFilesystemPath('https://evil.com/output.mp3')).toThrow();
    expect(() => assertFilesystemPath('ftp://files.server/output.mp3')).toThrow();
    expect(() => assertFilesystemPath('rtmp://stream.server/live')).toThrow();
    expect(() => assertFilesystemPath('data:image/png;base64,ABC123')).toThrow();
    expect(() => assertFilesystemPath('crypto:plaintext')).toThrow();
    expect(() => assertFilesystemPath('fd:0')).toThrow();
  });

  it('throws on relative paths', () => {
    expect(() => assertFilesystemPath('relative/path.mp3')).toThrow();
    expect(() => assertFilesystemPath('output.mp3')).toThrow();
  });

  it('accepts absolute filesystem paths', () => {
    expect(() => assertFilesystemPath('/tmp/output.mp3')).not.toThrow();
    expect(() => assertFilesystemPath('/Users/jellytunes/music/track.mp3')).not.toThrow();
  });
});
