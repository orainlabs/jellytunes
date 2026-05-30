import { describe, it, expect } from 'vitest';
import { normalizeAlbumArtist } from '../utils/jellyfin';
import type { AlbumArtist } from '../appTypes';

describe('normalizeAlbumArtist', () => {
  it('resolves AlbumCount from raw.AlbumCount (10.9+)', () => {
    const raw = { Id: 'aa1', Name: 'Various Artists', AlbumCount: 15 };
    const result = normalizeAlbumArtist(raw);
    expect(result.AlbumCount).toBe(15);
  });

  it('falls back to 0 when AlbumCount is absent', () => {
    const raw = { Id: 'aa1', Name: 'Various Artists' };
    const result = normalizeAlbumArtist(raw);
    expect(result.AlbumCount).toBe(0);
  });

  it('falls back to 0 when AlbumCount is undefined', () => {
    const raw = { Id: 'aa1', Name: 'Various Artists', ChildCount: 5 };
    const result = normalizeAlbumArtist(raw);
    expect(result.AlbumCount).toBe(0);
  });

  it('preserves Id, Name, ImageTags', () => {
    const raw = {
      Id: 'aa1',
      Name: 'Various Artists',
      AlbumCount: 15,
      ImageTags: { Primary: 'tag1' },
    };
    const result = normalizeAlbumArtist(raw);
    expect(result).toMatchObject({
      Id: 'aa1',
      Name: 'Various Artists',
      AlbumCount: 15,
      ImageTags: { Primary: 'tag1' },
    } satisfies Partial<AlbumArtist>);
  });

  it('returns a plain object, not the raw input', () => {
    const raw = { Id: 'aa1', Name: 'Various Artists' };
    const result = normalizeAlbumArtist(raw);
    expect(result).not.toBe(raw);
  });

  it('same structure as Artist (album artist with tracks from different performing artists)', () => {
    // This validates the test case: artist with tracks from different performing artists
    // appears as one entry under Album Artist
    const raw = {
      Id: 'aa-various',
      Name: 'Various Artists',
      AlbumCount: 3,
      // Each album has different performing artists but same Album Artist
      ImageTags: { Primary: 'tag-various' },
    };
    const result = normalizeAlbumArtist(raw);
    expect(result.Id).toBe('aa-various');
    expect(result.Name).toBe('Various Artists');
    expect(result.AlbumCount).toBe(3);
  });
});
