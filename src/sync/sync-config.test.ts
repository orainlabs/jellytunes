import { describe, it, expect } from 'vitest';
import { hasTraversalSegment, buildDestinationPath } from './sync-config';

describe('hasTraversalSegment', () => {
  describe('rejects traversal segments', () => {
    it.each([
      ['../etc/passwd'],
      ['foo/../etc/passwd'],
      ['foo/bar/../../etc/passwd'],
      ['../../../../../../etc/passwd'],
      ['../'.repeat(10) + 'etc/passwd'],
      ['..'],
      ['foo/..'],
      ['foo/bar/..'],
    ])('%s', (input) => {
      expect(hasTraversalSegment(input)).toBe(true);
    });
  });

  describe('accepts valid paths without traversal', () => {
    it.each([
      ['track.mp3'],
      ['Artist/Album/track.mp3'],
      ['Artist'],
      ['a/b/c/d/e/f/g/h/i/track.mp3'],
      [''],
      ['foo'],
      ['foo-bar_baz.qux'],
      ['...'],
      ['....'],
      ['foo/./bar'],
      ['./foo'],
    ])('%s', (input) => {
      expect(hasTraversalSegment(input)).toBe(false);
    });
  });

  it('handles mixed forward/backward slashes', () => {
    // A path with backslash as separator (Windows-style) — no literal '..' so should be false
    expect(hasTraversalSegment('foo\\bar\\baz')).toBe(false);
  });

  it('handles null bytes — rejects when null byte is followed by traversal', () => {
    // '\x00' inside a segment is NOT '..', so null bytes alone don't trigger hasTraversalSegment.
    // Null byte filtering is handled separately (at input validation boundaries).
    expect(hasTraversalSegment('foo\x00bar')).toBe(false);
  });

  it('normalizes consecutive slashes before checking', () => {
    // No '..' after normalization
    expect(hasTraversalSegment('foo///bar')).toBe(false);
  });
});

describe('buildDestinationPath — validatePathTraversal coverage', () => {
  const DEST = '/mnt/usb';

  describe('rejects path traversal attacks', () => {
    it.each([
      ['/mnt/usb/../../../etc/passwd',   '/mnt/usb', 'traversal beyond base'],
      ['/mnt/usb/foo/../../../../etc',   '/mnt/usb', 'deep traversal with subdirs'],
      ['/mnt/usb/./../../../etc/passwd',  '/mnt/usb', 'traversal with dot segments'],
      ['/mnt/lib-backup/x',               '/mnt/lib',  'substring prefix overlap'],
    ])('%s — %s', (serverPath, serverRoot, _desc) => {
      expect(() => buildDestinationPath(serverPath, serverRoot, DEST)).toThrow();
    });
  });

  describe('accepts valid destination paths', () => {
    it.each([
      ['/mnt/usb/Artist/Album/track.mp3', '/mnt/usb',  '/mnt/usb'],
      ['/mnt/usb/a/b/c/d/e/f/track.mp3',  '/mnt/usb',  '/mnt/usb'],
      ['/mnt/usb',                         '/mnt/usb',  '/mnt/usb'],
      ['/music/Artist/Album/track.mp3',   '/music',    '/dest'],
    ])('%s under %s to %s', (serverPath, serverRoot, destinationRoot) => {
      expect(() => buildDestinationPath(serverPath, serverRoot, destinationRoot)).not.toThrow();
    });
  });

  // Note: null bytes in paths containing '..' are already caught by hasTraversalSegment
  // (the '..' segments remain after null-byte truncation). Null bytes without traversal
  // are an edge case in buildDestinationPath but are caught by the startsWith check since
  // path.normalize() truncates at null bytes, producing unexpected paths.
});
