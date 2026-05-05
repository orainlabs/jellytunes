// tests/unit/utils/format.test.ts

import { describe, it, expect } from 'vitest'
import { formatBytes } from '../../../src/renderer/src/utils/format'

describe('formatBytes', () => {
  it('returns 0 B for zero bytes', () => {
    expect(formatBytes(0)).toBe('0 KB')
  })

  it('returns KB for bytes >= 1e3 and < 1e6', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(500000)).toBe('500 KB')
  })

  it('returns MB for bytes >= 1e6 and < 1e9', () => {
    expect(formatBytes(1e6)).toBe('1 MB')
    expect(formatBytes(2.5e6)).toBe('3 MB')
  })

  it('returns GB for bytes >= 1e9', () => {
    expect(formatBytes(1e9)).toBe('1.0 GB')
    expect(formatBytes(2.5e9)).toBe('2.5 GB')
  })

  it('handles negative bytes gracefully', () => {
    expect(formatBytes(-100)).toBe('-0 KB')
  })
})