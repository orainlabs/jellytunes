import { describe, it, expect } from 'vitest';
import {
  normalizeArtist,
  normalizeAlbum,
  normalizePlaylist,
  normalizeGenre,
  formatRunTimeTicks,
} from '../utils/jellyfin';
import type { Artist, Album, Playlist } from '../appTypes';

describe('formatRunTimeTicks', () => {
  it('returns null when ticks is undefined', () => {
    expect(formatRunTimeTicks(undefined)).toBeNull();
  });

  it('returns null when ticks is null', () => {
    expect(formatRunTimeTicks(null as unknown as number)).toBeNull();
  });

  it('returns null when ticks is 0', () => {
    expect(formatRunTimeTicks(0)).toBeNull();
  });

  it('returns "< 1m" when ticks < 30 seconds (rounds down to 0 min)', () => {
    // 29s → 0 rounded minutes → "< 1m"
    expect(formatRunTimeTicks(29 * 10_000_000)).toBe('< 1m');
  });

  it('returns "1m" when ticks is exactly 30 seconds (rounds up to 1 min)', () => {
    // 30s → remainder 30 >= 30 → rounds up to 1m
    expect(formatRunTimeTicks(30 * 10_000_000)).toBe('1m');
  });

  it('returns "44m" when ticks is 44m 29s (rounds down)', () => {
    expect(formatRunTimeTicks((44 * 60 + 29) * 10_000_000)).toBe('44m');
  });

  it('returns "45m" when ticks is 44m 30s (rounds up)', () => {
    expect(formatRunTimeTicks((44 * 60 + 30) * 10_000_000)).toBe('45m');
  });

  it('returns "1h" when ticks is 59m 30s (rounds up to next hour)', () => {
    expect(formatRunTimeTicks((59 * 60 + 30) * 10_000_000)).toBe('1h');
  });

  it('returns "1h" when ticks represents exactly 1 hour', () => {
    expect(formatRunTimeTicks(60 * 60 * 10_000_000)).toBe('1h');
  });

  it('returns "5h 32m" when ticks represents exactly 5 hours 32 minutes', () => {
    expect(formatRunTimeTicks((5 * 60 + 32) * 60 * 10_000_000)).toBe('5h 32m');
  });

  it('returns "5h 33m" when ticks is 5h 32m 45s (rounds up last minute)', () => {
    // 5h 32m 45s → remainder 45 >= 30 → rounds to 5h 33m
    expect(formatRunTimeTicks((5 * 3600 + 32 * 60 + 45) * 10_000_000)).toBe('5h 33m');
  });
});

describe('jellyfin normalizers', () => {
  describe('normalizeArtist', () => {
    it('resolves AlbumCount from raw.AlbumCount (10.9+)', () => {
      const raw = { Id: 'a1', Name: 'Radiohead', AlbumCount: 9 };
      const result = normalizeArtist(raw);
      expect(result.AlbumCount).toBe(9);
    });

    it('falls back to 0 when AlbumCount is absent (API without Fields=AlbumCount)', () => {
      const raw = { Id: 'a1', Name: 'Radiohead' };
      const result = normalizeArtist(raw);
      expect(result.AlbumCount).toBe(0);
    });

    it('falls back to 0 when AlbumCount is undefined (API without Fields=AlbumCount)', () => {
      const raw = { Id: 'a1', Name: 'Radiohead', ChildCount: 5 };
      const result = normalizeArtist(raw);
      expect(result.AlbumCount).toBe(0);
    });

    it('preserves Id, Name, ImageTags', () => {
      const raw = { Id: 'a1', Name: 'Radiohead', AlbumCount: 9, ImageTags: { Primary: 'tag1' } };
      const result = normalizeArtist(raw);
      expect(result).toMatchObject({
        Id: 'a1',
        Name: 'Radiohead',
        AlbumCount: 9,
        ImageTags: { Primary: 'tag1' },
      } satisfies Partial<Artist>);
    });

    it('returns a plain object, not the raw input', () => {
      const raw = { Id: 'a1', Name: 'Radiohead' };
      const result = normalizeArtist(raw);
      expect(result).not.toBe(raw);
    });
  });

  describe('normalizeAlbum', () => {
    it('resolves AlbumArtist from raw.AlbumArtist', () => {
      const raw = { Id: 'b1', Name: 'OK Computer', AlbumArtist: 'Radiohead' };
      const result = normalizeAlbum(raw);
      expect(result.AlbumArtist).toBe('Radiohead');
    });

    it('falls back to raw.AlbumArtists[0].Name when AlbumArtist absent', () => {
      const raw = {
        Id: 'b1',
        Name: 'OK Computer',
        AlbumArtists: [{ Name: 'Radiohead' }],
      };
      const result = normalizeAlbum(raw);
      expect(result.AlbumArtist).toBe('Radiohead');
    });

    it('returns undefined AlbumArtist when neither field exists', () => {
      const raw = { Id: 'b1', Name: 'OK Computer' };
      const result = normalizeAlbum(raw);
      expect(result.AlbumArtist).toBeUndefined();
    });

    it('preserves Id, Name, ProductionYear, PremiereDate, ImageTags', () => {
      const raw = {
        Id: 'b1',
        Name: 'OK Computer',
        AlbumArtist: 'Radiohead',
        ProductionYear: 1997,
        PremiereDate: '1997-06-16',
        ImageTags: { Primary: 'tag2' },
      };
      const result = normalizeAlbum(raw);
      expect(result).toMatchObject({
        Id: 'b1',
        Name: 'OK Computer',
        AlbumArtist: 'Radiohead',
        ProductionYear: 1997,
        PremiereDate: '1997-06-16',
        ImageTags: { Primary: 'tag2' },
      } satisfies Partial<Album>);
    });

    it('returns a plain object, not the raw input', () => {
      const raw = { Id: 'b1', Name: 'OK Computer' };
      const result = normalizeAlbum(raw);
      expect(result).not.toBe(raw);
    });
  });

  describe('normalizePlaylist', () => {
    it('resolves ChildCount from raw.ChildCount', () => {
      const raw = { Id: 'p1', Name: 'My Favorites', ChildCount: 42 };
      const result = normalizePlaylist(raw);
      expect(result.ChildCount).toBe(42);
    });

    it('falls back to ItemCount when ChildCount is absent', () => {
      const raw = { Id: 'p1', Name: 'My Favorites', ItemCount: 42 };
      const result = normalizePlaylist(raw);
      expect(result.ChildCount).toBe(42);
    });

    it('falls back to undefined when neither ChildCount nor ItemCount exists', () => {
      // This lets LibraryItem hide the subtitle instead of showing "0 tracks"
      const raw = { Id: 'p1', Name: 'My Favorites' };
      const result = normalizePlaylist(raw);
      expect(result.ChildCount).toBeUndefined();
    });

    it('preserves Id, Name, ImageTags', () => {
      const raw = {
        Id: 'p1',
        Name: 'My Favorites',
        ChildCount: 42,
        ImageTags: { Primary: 'tag3' },
      };
      const result = normalizePlaylist(raw);
      expect(result).toMatchObject({
        Id: 'p1',
        Name: 'My Favorites',
        ChildCount: 42,
        ImageTags: { Primary: 'tag3' },
      } satisfies Partial<Playlist>);
    });

    it('returns a plain object, not the raw input', () => {
      const raw = { Id: 'p1', Name: 'My Favorites' };
      const result = normalizePlaylist(raw);
      expect(result).not.toBe(raw);
    });
  });

  describe('normalizeGenre', () => {
    it('extracts Id, Name and ItemCount from raw genre', () => {
      const raw = { Id: 'g-rock', Name: 'Rock', ItemCount: 42 };
      const result = normalizeGenre(raw);
      expect(result.Id).toBe('g-rock');
      expect(result.Name).toBe('Rock');
      expect(result.LibraryItems).toBe(42);
    });

    it('falls back to ChildCount when ItemCount is absent (older Jellyfin)', () => {
      const raw = { Id: 'g-jazz', Name: 'Jazz', ChildCount: 17 };
      const result = normalizeGenre(raw);
      expect(result.Id).toBe('g-jazz');
      expect(result.LibraryItems).toBe(17);
    });

    it('prefers ItemCount over ChildCount when both are present', () => {
      const raw = { Id: 'g-pop', Name: 'Pop', ItemCount: 30, ChildCount: 5 };
      const result = normalizeGenre(raw);
      expect(result.LibraryItems).toBe(30);
    });

    it('prefers SongCount (from /Genres Fields=ItemCounts) over legacy counts', () => {
      const raw = { Id: 'g-metal', Name: 'Metal', SongCount: 12, ItemCount: 99, ChildCount: 4 };
      const result = normalizeGenre(raw);
      expect(result.LibraryItems).toBe(12);
    });

    it('returns 0 when neither ItemCount nor ChildCount is present', () => {
      const raw = { Id: 'g-1', Name: 'Classical' };
      const result = normalizeGenre(raw);
      expect(result.LibraryItems).toBe(0);
    });

    it('extracts Name from raw genre with default LibraryItems', () => {
      const raw = { Id: 'g-2', Name: 'Jazz' };
      const result = normalizeGenre(raw);
      expect(result.Name).toBe('Jazz');
      expect(result.LibraryItems).toBe(0);
    });

    it('handles empty Name gracefully', () => {
      const raw = { Id: 'g-3', Name: '' };
      const result = normalizeGenre(raw);
      expect(result.Name).toBe('');
      expect(result.LibraryItems).toBe(0);
    });

    it('handles missing Name gracefully', () => {
      const raw = { Id: 'g-4', ItemCount: 5 };
      const result = normalizeGenre(raw);
      expect(result.Name).toBe('');
      expect(result.LibraryItems).toBe(5);
    });

    it('handles missing Id gracefully (empty string fallback)', () => {
      const raw = { Name: 'Reggae', ItemCount: 7 };
      const result = normalizeGenre(raw);
      expect(result.Id).toBe('');
      expect(result.Name).toBe('Reggae');
    });

    it('returns a plain object, not the raw input', () => {
      const raw = { Id: 'g-5', Name: 'Pop', ItemCount: 10 };
      const result = normalizeGenre(raw);
      expect(result).not.toBe(raw);
    });
  });
});
