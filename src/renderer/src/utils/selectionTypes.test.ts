import { describe, it, expect } from 'vitest';
import { buildItemTypes, buildItemIds } from './selectionTypes';
import type { Artist, AlbumArtist, Album, Playlist } from '../appTypes';

const sharedId = 'shared-1'; // present in BOTH artists and albumArtists

const extArtists: Artist[] = [
  { Id: sharedId, Name: 'A1 (Artist)', ChildCount: 1 },
  { Id: 'artist-only-1', Name: 'A2', ChildCount: 1 },
];
const extAlbumArtists: AlbumArtist[] = [
  { Id: sharedId, Name: 'A1 (AlbumArtist)' },
  { Id: 'aa-only-1', Name: 'AA1' },
];
const extAlbums: Album[] = [{ Id: 'album-1', Name: 'Album 1' }];
const extPlaylists: Playlist[] = [{ Id: 'playlist-1', Name: 'Playlist 1' }];

describe('buildItemTypes (ORAIN-0554 Defect 2)', () => {
  it('selects artist type for an id selected from the Artists tab (even if also in albumArtists)', () => {
    const result = buildItemTypes({
      selectedArtists: new Set([sharedId]),
      selectedAlbumArtists: new Set(),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    expect(result[sharedId]).toBe('artist');
  });

  it('selects albumArtist type for an id selected from the AlbumArtists tab', () => {
    const result = buildItemTypes({
      selectedArtists: new Set(),
      selectedAlbumArtists: new Set([sharedId]),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    expect(result[sharedId]).toBe('albumArtist');
  });

  it('albums and playlists retain their registry-derived type regardless of selection', () => {
    const result = buildItemTypes({
      selectedArtists: new Set(),
      selectedAlbumArtists: new Set(),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    expect(result['album-1']).toBe('album');
    expect(result['playlist-1']).toBe('playlist');
  });

  it('does not mutate the registry fallback for non-shared ids', () => {
    const result = buildItemTypes({
      selectedArtists: new Set(),
      selectedAlbumArtists: new Set(),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    // Unselected shared id keeps the albumArtist fallback (last-write-wins
    // of the spread) — this is the documented registry fallback for items
    // not actively selected.
    expect(result[sharedId]).toBe('albumArtist');
    expect(result['artist-only-1']).toBe('artist');
    expect(result['aa-only-1']).toBe('albumArtist');
  });

  it('defensive: when an id is in BOTH selected sets, the later iteration wins', () => {
    // In practice the toggle handler keeps these sets mutually exclusive
    // (toggleItem removes from the other set on add). This test pins the
    // documented behavior for the unreachable "both contain id" case: the
    // last-iterated set (selectedAlbumArtists) wins, matching the historical
    // last-write-wins order.
    const result = buildItemTypes({
      selectedArtists: new Set([sharedId]),
      selectedAlbumArtists: new Set([sharedId]),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    expect(result[sharedId]).toBe('albumArtist');
  });
});

describe('buildItemIds (ORAIN-0554 Defect 2)', () => {
  it('preserves the original iteration order (artists → albumArtists → albums → playlists)', () => {
    const result = buildItemIds({
      selectedArtists: new Set(['artist-only-1']),
      selectedAlbumArtists: new Set(['aa-only-1']),
      selectedOthers: new Set(['album-1', 'playlist-1']),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    expect(result).toEqual(['artist-only-1', 'aa-only-1', 'album-1', 'playlist-1']);
  });

  it('includes the shared id once under its selected tab', () => {
    const result = buildItemIds({
      selectedArtists: new Set([sharedId]),
      selectedAlbumArtists: new Set(),
      selectedOthers: new Set(),
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    // The shared id appears via the artists loop only; the albumArtists loop
    // doesn't push it because selectedAlbumArtists is empty.
    expect(result).toEqual([sharedId]);
  });
});
