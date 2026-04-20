import { describe, it, expect } from 'vitest';
import { sanitizeMetadataField, sanitizeNumericField } from './sync-files';

/**
 * These tests verify the sanitizeMetadataField and sanitizeNumericField helpers
 * used to clean metadata before passing to FFmpeg -metadata arguments.
 * Tests live here so the helper can live in sync-files.ts alongside its users.
 */

describe('sanitizeMetadataField', () => {
  it('removes control characters from string', () => {
    expect(sanitizeMetadataField('foo\nbar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\rbar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\x00bar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\x1Fbar')).toBe('foobar');
    expect(sanitizeMetadataField('foo\x7Fbar')).toBe('foobar');
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
