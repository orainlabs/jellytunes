/**
 * ORAIN-0755: single shared track-by-id deduplication.
 *
 * Replaces three independent copies that drifted (sync-core, the renderer's
 * useSync preview loop, and the renderer's calculateSize / calculateDuration).
 * Pure module — no Node, no Electron — so it can be imported by both the
 * sync engine and the renderer.
 *
 * Semantics: FIRST OCCURRENCE WINS. Subsequent appearances of the same key
 * are dropped. ORAIN-0709 relies on this to preserve `parentItemId` for
 * `analyzeDiff` grouping (the first item to claim a trackId defines which
 * parent diff bucket the track lands in).
 */

/**
 * Generic key-based deduplication. Returns a new array with only the first
 * occurrence of each unique `getKey(item)` value.
 *
 * @param items  Source array. Not mutated.
 * @param getKey Function returning the deduplication key for each item.
 */
export function deduplicateByKey<T>(items: readonly T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Typed wrapper over `deduplicateByKey` for items with an `id` field
 * (TrackInfo, SyncedTrackRecord, etc.). Preserves the ORAIN-0709
 * first-occurrence-wins semantic so callers that need the first item's
 * other fields (notably `parentItemId`) keep them.
 */
export function deduplicateTracks<T extends { id: string }>(tracks: readonly T[]): T[] {
  return deduplicateByKey(tracks, (t) => t.id);
}
