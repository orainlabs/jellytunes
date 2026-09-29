// ORAIN-0757 AC6: extracted from src/main/index.ts so we can guard the
// sync:start2 destination path BEFORE mkdirSync runs. The fsutil regression
// surfaced in the device listing; this guard prevents a separate failure
// mode where a renderer-supplied path bypasses validation entirely and
// mkdirSync blows up on a relative or null-byte path.

import { describe, it, expect } from 'vitest';
import { isValidPath } from './path-validation';

describe('isValidPath — POSIX absolute', () => {
  it('accepts a leading-slash path', () => {
    expect(isValidPath('/mnt/usb/music')).toBe(true);
  });
  it('accepts a long POSIX path', () => {
    expect(isValidPath('/media/obi/JellyfinSync/Album/01 Track.mp3')).toBe(true);
  });
  it('rejects empty string', () => {
    expect(isValidPath('')).toBe(false);
  });
  it('rejects relative path', () => {
    expect(isValidPath('mnt/usb')).toBe(false);
  });
  it('rejects null byte', () => {
    expect(isValidPath('/mnt/usb\0/etc/passwd')).toBe(false);
  });
});

describe('isValidPath — Windows absolute', () => {
  it('accepts X:\\ form', () => {
    expect(isValidPath('G:\\music')).toBe(true);
  });
  it('accepts X:/ form', () => {
    expect(isValidPath('G:/music')).toBe(true);
  });
  it('accepts UNC \\\\server\\share form', () => {
    expect(isValidPath('\\\\nas\\music\\album')).toBe(true);
  });
  it('rejects bare drive letter without colon', () => {
    // The regression we are guarding against: 'G\\' (or 'G:') without
    // the trailing slash/backslash passes extractDriveLetter as
    // ambiguous and fs.statfsSync throws. isValidPath must reject.
    expect(isValidPath('G\\')).toBe(false);
    expect(isValidPath('G:')).toBe(false);
  });
});

describe('isValidPath — type guards', () => {
  it('rejects non-string inputs', () => {
    expect(isValidPath(null)).toBe(false);
    expect(isValidPath(undefined)).toBe(false);
    expect(isValidPath(123)).toBe(false);
    expect(isValidPath({})).toBe(false);
    expect(isValidPath(['/mnt/usb'])).toBe(false);
  });
});
