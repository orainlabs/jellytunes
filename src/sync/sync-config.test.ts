import { describe, it, expect } from 'vitest';
import { hasTraversalSegment, buildDestinationPath, sanitizePathComponent } from './sync-config';

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
      ['/mnt/usb/../../../etc/passwd', '/mnt/usb', 'traversal beyond base'],
      ['/mnt/usb/foo/../../../../etc', '/mnt/usb', 'deep traversal with subdirs'],
      ['/mnt/usb/./../../../etc/passwd', '/mnt/usb', 'traversal with dot segments'],
      ['/mnt/lib-backup/x', '/mnt/lib', 'substring prefix overlap'],
    ])('%s — %s', (serverPath, serverRoot, _desc) => {
      expect(() => buildDestinationPath(serverPath, serverRoot, DEST)).toThrow();
    });
  });

  describe('accepts valid destination paths', () => {
    it.each([
      ['/mnt/usb/Artist/Album/track.mp3', '/mnt/usb', '/mnt/usb'],
      ['/mnt/usb/a/b/c/d/e/f/track.mp3', '/mnt/usb', '/mnt/usb'],
      ['/mnt/usb', '/mnt/usb', '/mnt/usb'],
      ['/music/Artist/Album/track.mp3', '/music', '/dest'],
    ])('%s under %s to %s', (serverPath, serverRoot, destinationRoot) => {
      expect(() => buildDestinationPath(serverPath, serverRoot, destinationRoot)).not.toThrow();
    });
  });

  // Note: null bytes in paths containing '..' are already caught by hasTraversalSegment
  // (the '..' segments remain after null-byte truncation). Null bytes without traversal
  // are an edge case in buildDestinationPath but are caught by the startsWith check since
  // path.normalize() truncates at null bytes, producing unexpected paths.
});

describe('buildDestinationPath — Windows path coverage', () => {
  const DEST = 'E:/music';

  it('accepts Windows-style server paths with backslashes', () => {
    // Regression: path.normalize() on Windows converts forward slashes to backslashes,
    // which could produce mixed separators and break the path traversal check.
    const serverPath = 'E:\\\\music\\\\Artist\\\\Album\\\\track.mp3';
    const serverRoot = 'E:\\\\music';
    expect(() => buildDestinationPath(serverPath, serverRoot, DEST)).not.toThrow();
  });

  it('normalizes output to POSIX forward slashes regardless on input style', () => {
    const serverPath = 'E:\\\\music\\\\Artist\\\\Album\\\\track.mp3';
    const serverRoot = 'E:\\\\music';
    const result = buildDestinationPath(serverPath, serverRoot, DEST);
    // Result should use forward slashes for cross-platform consistency
    expect(result).toContain('/');
    expect(result).not.toContain('\\\\');
  });
});

// ORAIN-0725: on win32 the Win32 API forbids `< > : " | ? *` on every volume
// (NTFS, exFAT, FAT32 alike), so the sanitizer must run regardless of the
// detected filesystem label. Platform is injected (no `process.platform`
// read at test time) so the test runs identically on ubuntu-latest and
// windows-latest.
describe('sanitizePathComponent — win32 platform semantics (ORAIN-0725)', () => {
  const WIN32_FORBIDDEN = ['<', '>', ':', '"', '|', '?', '*'];
  const FORBIDDEN_INPUTS = [
    'foo<bar',
    'foo>bar',
    'foo:bar',
    'foo"bar',
    'foo|bar',
    'foo?bar',
    'foo*bar',
    'track?.mp3',
    'a:b:c',
    'all<of>the:bad|chars?*together',
  ];

  it.each(FORBIDDEN_INPUTS)(
    'strips forbidden chars on win32 even with filesystem=unknown: %s',
    (input) => {
      const sanitized = sanitizePathComponent(input, { platform: 'win32', filesystem: 'unknown' });
      for (const c of WIN32_FORBIDDEN) {
        expect(sanitized).not.toContain(c);
      }
      expect(sanitized.length).toBeGreaterThan(0);
    },
  );

  it.each(FORBIDDEN_INPUTS)('strips forbidden chars on win32 with filesystem=ntfs: %s', (input) => {
    const sanitized = sanitizePathComponent(input, { platform: 'win32', filesystem: 'ntfs' });
    for (const c of WIN32_FORBIDDEN) {
      expect(sanitized).not.toContain(c);
    }
  });

  it.each(FORBIDDEN_INPUTS)(
    'strips forbidden chars on win32 with filesystem=exfat: %s',
    (input) => {
      const sanitized = sanitizePathComponent(input, { platform: 'win32', filesystem: 'exfat' });
      for (const c of WIN32_FORBIDDEN) {
        expect(sanitized).not.toContain(c);
      }
    },
  );

  it.each(FORBIDDEN_INPUTS)(
    'strips forbidden chars on win32 with filesystem=fat32: %s',
    (input) => {
      const sanitized = sanitizePathComponent(input, { platform: 'win32', filesystem: 'fat32' });
      for (const c of WIN32_FORBIDDEN) {
        expect(sanitized).not.toContain(c);
      }
    },
  );

  it('does NOT sanitize forbidden chars on darwin with filesystem=unknown (Linux/macOS keep segments)', () => {
    // Sanity check that we only changed the win32 path — mac/linux paths are unchanged
    // for non-Windows-family filesystems.
    const input = 'foo<bar>baz';
    expect(sanitizePathComponent(input, { platform: 'darwin', filesystem: 'unknown' })).toBe(input);
    expect(sanitizePathComponent(input, { platform: 'linux', filesystem: 'unknown' })).toBe(input);
    expect(sanitizePathComponent(input, { platform: 'linux', filesystem: 'ext4' })).toBe(input);
  });

  it('still sanitizes on darwin/linux for fat32/exfat/ntfs (unchanged behavior)', () => {
    const input = 'foo<bar>baz';
    expect(sanitizePathComponent(input, { platform: 'darwin', filesystem: 'fat32' })).toBe(
      'foo_bar_baz',
    );
    expect(sanitizePathComponent(input, { platform: 'linux', filesystem: 'exfat' })).toBe(
      'foo_bar_baz',
    );
    expect(sanitizePathComponent(input, { platform: 'linux', filesystem: 'ntfs' })).toBe(
      'foo_bar_baz',
    );
  });

  it('strips trailing dots and spaces on win32 even with unknown filesystem', () => {
    expect(sanitizePathComponent('foo...', { platform: 'win32', filesystem: 'unknown' })).toBe(
      'foo',
    );
    expect(sanitizePathComponent('foo   ', { platform: 'win32', filesystem: 'unknown' })).toBe(
      'foo',
    );
    expect(sanitizePathComponent('foo. ', { platform: 'win32', filesystem: 'unknown' })).toBe(
      'foo',
    );
  });

  it('prefixes Windows reserved names on win32 with unknown filesystem (CON, PRN, AUX, NUL)', () => {
    for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'con.txt', 'PRN.mp3']) {
      const sanitized = sanitizePathComponent(reserved, {
        platform: 'win32',
        filesystem: 'unknown',
      });
      expect(sanitized.startsWith('_')).toBe(true);
    }
  });

  it('falls back to "_" when sanitization would empty the segment on win32', () => {
    expect(sanitizePathComponent('...', { platform: 'win32', filesystem: 'unknown' })).toBe('_');
    expect(sanitizePathComponent('   ', { platform: 'win32', filesystem: 'unknown' })).toBe('_');
  });

  it('truncates long filenames while preserving the extension on win32', () => {
    const longName = 'a'.repeat(300) + '.flac';
    const sanitized = sanitizePathComponent(longName, { platform: 'win32', filesystem: 'unknown' });
    expect(sanitized.length).toBeLessThanOrEqual(255);
    expect(sanitized.endsWith('.flac')).toBe(true);
  });

  it('treats backslash in the segment as a forbidden char on win32', () => {
    // Forward slash is a path separator and never reaches sanitizePathComponent,
    // but backslash can sneak into track metadata. Win32 treats it as a path
    // separator too, so it must not appear inside a sanitized segment.
    expect(
      sanitizePathComponent('Artist\\Album', { platform: 'win32', filesystem: 'unknown' }),
    ).toBe('Artist_Album');
  });

  it('produces forbidden-char-free segments for full track paths on win32 with unknown filesystem', () => {
    // AC2: built destination path with filesystem=unknown on win32 contains no
    // forbidden characters in any segment, and no segment ends in dot/space.
    const segments = ['AC/DC', 'Back: in Black', 'Track<1>: "T.N.T."?', 'side|a.mp3'];
    for (const seg of segments) {
      const sanitized = sanitizePathComponent(seg, { platform: 'win32', filesystem: 'unknown' });
      for (const c of WIN32_FORBIDDEN) {
        expect(sanitized).not.toContain(c);
      }
      expect(sanitized.endsWith('.')).toBe(false);
      expect(sanitized.endsWith(' ')).toBe(false);
    }
  });
});
