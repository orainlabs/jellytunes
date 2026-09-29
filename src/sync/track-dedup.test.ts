import { describe, it, expect } from 'vitest';
import { deduplicateByKey, deduplicateTracks } from './track-dedup';

describe('deduplicateByKey', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateByKey([], (x) => x)).toEqual([]);
  });

  it('preserves order of first occurrence (first-wins)', () => {
    expect(deduplicateByKey(['a', 'b', 'a', 'c', 'b'], (x) => x)).toEqual(['a', 'b', 'c']);
  });

  it('leaves input with no duplicates unchanged', () => {
    expect(deduplicateByKey([1, 2, 3], (x) => String(x))).toEqual([1, 2, 3]);
  });

  it('uses the getKey function, not identity', () => {
    const items = [
      { id: 1, tag: 'a' },
      { id: 2, tag: 'b' },
      { id: 3, tag: 'a' },
    ];
    expect(deduplicateByKey(items, (x) => x.tag)).toEqual([
      { id: 1, tag: 'a' },
      { id: 2, tag: 'b' },
    ]);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'a'];
    const copy = [...input];
    deduplicateByKey(input, (x) => x);
    expect(input).toEqual(copy);
  });
});

describe('deduplicateTracks', () => {
  it('keeps the first occurrence of each track.id (parentItemId preserved)', () => {
    const tracks = [
      { id: 't1', parentItemId: 'artist-1' },
      { id: 't2', parentItemId: 'album-1' },
      { id: 't1', parentItemId: 'playlist-1' }, // same id, different parent — must be dropped
    ];
    expect(deduplicateTracks(tracks)).toEqual([
      { id: 't1', parentItemId: 'artist-1' },
      { id: 't2', parentItemId: 'album-1' },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(deduplicateTracks([])).toEqual([]);
  });

  it('returns input unchanged when there are no duplicates', () => {
    const tracks = [{ id: 't1' }, { id: 't2' }];
    expect(deduplicateTracks(tracks)).toEqual(tracks);
  });
});
