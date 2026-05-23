import { describe, it, expect } from 'vitest';
import { sanitizeMetadataField, sanitizeNumericField, sanitizeLyricsField } from './sync-files';

/**
 * These tests verify the sanitizeMetadataField and sanitizeNumericField helpers
 * used to clean metadata before passing to FFmpeg -metadata arguments.
 * Tests live here so the helper can live in sync-files.ts alongside its users.
 */

describe('sanitizeMetadataField', () => {
  it('removes control characters from string (preserves newlines)', () => {
    // Newlines (LF=0x0A, CR=0x0D) are preserved — ID3v2 supports multi-line content
    expect(sanitizeMetadataField('foo\nbar')).toBe('foo\nbar');
    expect(sanitizeMetadataField('foo\rbar')).toBe('foo\rbar');
    // Other control characters are removed
    expect(sanitizeMetadataField('foo\x00bar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\x1Fbar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\x7Fbar')).toBe('foobar');
    // Mix of newlines and control chars
    expect(sanitizeMetadataField('foo\n\x00bar\r\x7Fbaz')).toBe('foo\nbar\rbaz');
  });

  it('trims whitespace', () => {
    expect(sanitizeMetadataField('  hello  ')).toBe('hello');
  });

  it('truncates to maxLength (default 500)', () => {
    expect(sanitizeMetadataField('a'.repeat(1000))).toHaveLength(500);
    expect(sanitizeMetadataField('a'.repeat(500))).toHaveLength(500);
    expect(sanitizeMetadataField('a'.repeat(499))).toHaveLength(499);
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeMetadataField('')).toBe('');
    expect(sanitizeMetadataField(undefined as unknown as string)).toBe('');
  });

  it('accepts custom maxLength', () => {
    expect(sanitizeMetadataField('a'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('sanitizeNumericField', () => {
  it('returns value if it matches digit-only regex', () => {
    expect(sanitizeNumericField('123')).toBe('123');
    expect(sanitizeNumericField('0')).toBe('0');
    expect(sanitizeNumericField('999999')).toBe('999999');
  });

  it('returns empty string for non-numeric values', () => {
    expect(sanitizeNumericField('abc')).toBe('');
    expect(sanitizeNumericField('12a')).toBe('');
    expect(sanitizeNumericField('')).toBe('');
    expect(sanitizeNumericField('2024a')).toBe('');
    expect(sanitizeNumericField('12.5')).toBe('');
  });
});

describe('sanitizeLyricsField', () => {
  it('preserves newlines for LRC multi-line content', () => {
    // LRC timestamps: each line has a timestamp prefix
    const lrcContent = '[00:00.00]Hello world\n[00:05.00]This is a test\n[00:10.00]Third line';
    expect(sanitizeLyricsField(lrcContent)).toBe(lrcContent);
    // Carriage returns also preserved
    const withCR = '[00:00]Line1\r[00:05]Line2';
    expect(sanitizeLyricsField(withCR)).toBe(withCR);
  });

  it('removes control characters except newlines', () => {
    expect(sanitizeLyricsField('foo\x00bar')).toBe('foobar');
    expect(sanitizeLyricsField('foo\x1Fbar')).toBe('foobar');
    expect(sanitizeLyricsField('foo\x7Fbar')).toBe('foobar');
    // Tab (0x09) removed
    expect(sanitizeLyricsField('foo\tbar')).toBe('foobar');
    // Vertical tab (0x0B) removed
    expect(sanitizeLyricsField('foo\x0Bbar')).toBe('foobar');
    // Form feed (0x0C) removed
    expect(sanitizeLyricsField('foo\x0Cbar')).toBe('foobar');
  });

  it('trims whitespace and truncates to maxLength (default 500)', () => {
    expect(sanitizeLyricsField('  hello  ')).toBe('hello');
    expect(sanitizeLyricsField('a'.repeat(1000))).toHaveLength(500);
  });

  it('accepts custom maxLength', () => {
    expect(sanitizeLyricsField('a'.repeat(100), 10)).toHaveLength(10);
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeLyricsField('')).toBe('');
    expect(sanitizeLyricsField(undefined as unknown as string)).toBe('');
  });
});
