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
        case 'albumArtists':
          return 'albumArtist';
        case 'albums':
          return 'album';
        case 'playlists':
          return 'playlist';
        case 'genres':
          return 'genre';
        default:
          // When exhaustive, `tab` is `never` here — compile error if not handled
          return assertExhaustive(tab);
      }
    }

    expect(getItemType('artists')).toBe('artist');
    expect(getItemType('albumArtists')).toBe('albumArtist');
    expect(getItemType('albums')).toBe('album');
    expect(getItemType('playlists')).toBe('playlist');
    expect(getItemType('genres')).toBe('genre');
  });

  it('throws with default message for unhandled value', () => {
    // Use a synthetic exhaustive switch over a 3-member type, then
    // cast a runtime value that isn't handled to test the throw behavior.
    type SmallTab = 'x' | 'y' | 'z';

    const unhandled = 'unhandled' as unknown as SmallTab;

    expect(() => {
      switch (unhandled as SmallTab) {
        case 'x':
        case 'y':
        case 'z':
          break;
        default:
          assertExhaustive(unhandled as never);
      }
    }).toThrow(/Unhandled case/);
  });

  it('throws with custom message when provided', () => {
    type SmallTab = 'x' | 'y' | 'z';
    const unhandled = 'unhandled' as unknown as SmallTab;

    expect(() => {
      switch (unhandled as SmallTab) {
        case 'x':
        case 'y':
        case 'z':
          break;
        default:
          assertExhaustive(unhandled as never, `Unsupported tab: ${unhandled}`);
      }
    }).toThrow('Unsupported tab: unhandled');
  });
});
