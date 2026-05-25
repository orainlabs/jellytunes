// tests/unit/utils/format.test.ts

import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration } from '../../../src/renderer/src/utils/format';

describe('formatBytes', () => {
  it('returns 0 B for zero bytes', () => {
    expect(formatBytes(0)).toBe('0 KB');
  });

  it('returns KB for bytes >= 1e3 and < 1e6', () => {
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(500000)).toBe('500 KB');
  });

  it('returns MB for bytes >= 1e6 and < 1e9', () => {
    expect(formatBytes(1e6)).toBe('1 MB');
    expect(formatBytes(2.5e6)).toBe('3 MB');
  });

  it('returns GB for bytes >= 1e9', () => {
    expect(formatBytes(1e9)).toBe('1.0 GB');
    expect(formatBytes(2.5e9)).toBe('2.5 GB');
  });

  it('handles negative bytes gracefully', () => {
    expect(formatBytes(-100)).toBe('-0 KB');
  });
});

describe('formatDuration', () => {
  it('returns "0:00" for zero seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('returns "0:00" for null/undefined', () => {
    expect(formatDuration(null as unknown as number)).toBe('0:00');
    expect(formatDuration(undefined as unknown as number)).toBe('0:00');
  });

  it('formats minutes and seconds when under 1 hour', () => {
    // 3 minutes 45 seconds = 225 seconds
    expect(formatDuration(225)).toBe('3:45');
    // 59 seconds
    expect(formatDuration(59)).toBe('0:59');
    // 1 minute = 60 seconds
    expect(formatDuration(60)).toBe('1:00');
    // 59 minutes 59 seconds = 3599 seconds (just under 1 hour)
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats hours, minutes, seconds when >= 1 hour', () => {
    // 1 hour exactly = 3600 seconds
    expect(formatDuration(3600)).toBe('1:00:00');
    // 1 hour 5 minutes 30 seconds = 3930 seconds
    expect(formatDuration(3930)).toBe('1:05:30');
    // 2 hours 30 minutes = 9000 seconds
    expect(formatDuration(9000)).toBe('2:30:00');
    // 10 hours 15 minutes 45 seconds = 36945 seconds
    expect(formatDuration(36945)).toBe('10:15:45');
  });
});
