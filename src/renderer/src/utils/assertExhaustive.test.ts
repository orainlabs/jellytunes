// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { assertExhaustive } from './assertExhaustive';
import type { LibraryTab } from '../appTypes';

/**
 * Tests for the assertExhaustive utility.
 *
 * This utility provides compile-time safety for exhaustive switches.
 * When a new value is added to a union type without updating all switch statements,
 * TypeScript will report a compile error at the call site.
 */

describe('assertExhaustive utility', () => {
  it('returns never when switch is exhaustive (allows compilation)', () => {
    // This verifies the pattern works with a real exhaustive switch.
    // If LibraryTab has all cases handled, the default case receives `never`.
    // assertExhaustive accepts `never` without compile error.

    function getItemType(tab: LibraryTab): string {
      switch (tab) {
        case 'artists':
          return 'artist';
        case 'albums':
          return 'album';
        case 'playlists':
          return 'playlist';
        default:
          // When exhaustive, `tab` is `never` here — compile error if not handled
          return assertExhaustive(tab);
      }
    }

    expect(getItemType('artists')).toBe('artist');
    expect(getItemType('albums')).toBe('album');
    expect(getItemType('playlists')).toBe('playlist');
  });

  it('throws with default message for unhandled value', () => {
    // Cast an unknown value to LibraryTab to simulate an unhandled case
    const unknownTab = 'genres' as unknown as LibraryTab;

    expect(() => {
      // Simulate a switch that doesn't handle 'genres'
      switch (unknownTab) {
        case 'artists':
        case 'albums':
        case 'playlists':
          break;
        default:
          assertExhaustive(unknownTab);
      }
    }).toThrow('Unhandled case: "genres"');
  });

  it('throws with custom message when provided', () => {
    const unknownTab = 'genres' as unknown as LibraryTab;

    expect(() => {
      switch (unknownTab) {
        case 'artists':
        case 'albums':
        case 'playlists':
          break;
        default:
          assertExhaustive(unknownTab, `Unsupported library tab: ${unknownTab}`);
      }
    }).toThrow('Unsupported library tab: genres');
  });
});
