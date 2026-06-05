import type { Artist, AlbumArtist, Album, Playlist } from '../appTypes';

export type ItemType = 'artist' | 'albumArtist' | 'album' | 'playlist';

export interface BuildItemTypesInput {
  selectedArtists: Set<string>;
  selectedAlbumArtists: Set<string>;
  extArtists: Artist[];
  extAlbumArtists: AlbumArtist[];
  extAlbums: Album[];
  extPlaylists: Playlist[];
}

/**
 * Build the `itemTypes` map sent to the device activation IPC.
 *
 * ORAIN-0554: for a given id, the type must reflect the *tab it was selected from*,
 * not the order the artist/albumArtist lists were registered. When a Jellyfin id
 * appears in BOTH the artists and albumArtists lists (an album-artist that the
 * server also surfaces as a regular artist), the previous last-write-wins spread
 * always typed it as `albumArtist` — that broke the label in DeviceSyncPanel and
 * the sync-engine type.
 *
 * Resolution: for ids the user has actively selected, the type is taken from the
 * typed set that contains it. For un-selected ids (the registry fallback), the
 * spread order is preserved.
 */
export function buildItemTypes({
  selectedArtists,
  selectedAlbumArtists,
  extArtists,
  extAlbumArtists,
  extAlbums,
  extPlaylists,
}: BuildItemTypesInput): Record<string, ItemType> {
  const itemTypes: Record<string, ItemType> = {
    ...Object.fromEntries(extArtists.map((a) => [a.Id, 'artist' as const])),
    ...Object.fromEntries(extAlbumArtists.map((a) => [a.Id, 'albumArtist' as const])),
    ...Object.fromEntries(extAlbums.map((a) => [a.Id, 'album' as const])),
    ...Object.fromEntries(extPlaylists.map((p) => [p.Id, 'playlist' as const])),
  };

  // For selected ids, the typed set is the source of truth — override the
  // registry-derived type so the active tab is what reaches the sync engine.
  // The sets are mutually exclusive for shared ids (toggleItem enforces this),
  // so iteration order does not matter here.
  for (const id of selectedArtists) itemTypes[id] = 'artist';
  for (const id of selectedAlbumArtists) itemTypes[id] = 'albumArtist';

  return itemTypes;
}

/**
 * Build the ordered `itemIds` array passed to the device activation IPC.
 *
 * The order matters: artists first (typed via `selectedArtists`), then
 * albumArtists (typed via `selectedAlbumArtists`), then un-typed
 * albums/playlists. This matches the loop body in `handleDestinationClick` and
 * exists here so the selection-typing rule (Defect 2) and the id-ordering rule
 * stay in lockstep.
 */
export function buildItemIds({
  selectedArtists,
  selectedAlbumArtists,
  selectedOthers,
  extArtists,
  extAlbumArtists,
  extAlbums,
  extPlaylists,
}: BuildItemTypesInput & { selectedOthers: Set<string> }): string[] {
  const itemIds: string[] = [];
  for (const a of extArtists) {
    if (selectedArtists.has(a.Id)) itemIds.push(a.Id);
  }
  for (const a of extAlbumArtists) {
    if (selectedAlbumArtists.has(a.Id)) itemIds.push(a.Id);
  }
  for (const a of extAlbums) {
    if (selectedOthers.has(a.Id)) itemIds.push(a.Id);
  }
  for (const p of extPlaylists) {
    if (selectedOthers.has(p.Id)) itemIds.push(p.Id);
  }
  return itemIds;
}
