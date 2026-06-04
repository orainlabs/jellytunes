import type { Artist, Album, Playlist, Genre, AlbumArtist } from '../appTypes';

export const PAGE_SIZE = 50;

export function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    'X-MediaBrowser-Token': apiKey,
    'X-Emby-Token': apiKey,
    'Content-Type': 'application/json',
  };
}

export function buildUrl(base: string, path: string): string {
  const cleanBase = base.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Format Jellyfin RunTimeTicks into a human-readable duration string.
 * Jellyfin uses 100-nanosecond ticks: 1 tick = 100ns.
 * @param ticks - RunTimeTicks value (1 tick = 100 nanoseconds)
 * @returns null if ticks is 0/null/undefined, "< 1m" if < 60s, "Xm" if < 1h,
 *          "Xh Ym" if >= 1h. All values are floor-rounded.
 */
export function formatRunTimeTicks(ticks: number | undefined): string | null {
  if (!ticks) return null;

  const totalSeconds = Math.floor(ticks / 10_000_000);
  const remainderSeconds = totalSeconds % 60;
  const roundedMinutes = Math.floor(totalSeconds / 60) + (remainderSeconds >= 30 ? 1 : 0);

  if (roundedMinutes === 0) return '< 1m';

  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;

  if (hours === 0) return `${minutes}m`;

  if (minutes === 0) return `${hours}h`;

  return `${hours}h ${minutes}m`;
}

/**
 * Normalize a raw Jellyfin artist item from /Artists endpoint.
 * Note: Jellyfin requires `Fields=AlbumCount` in the API request to return AlbumCount.
 * Without that parameter, the field will be undefined in the response.
 * See: https://typescript-sdk.jellyfin.org/interfaces/generated-client.BaseItemDto.html
 */
export function normalizeArtist(raw: Record<string, unknown>): Artist {
  return {
    Id: String(raw.Id ?? ''),
    Name: String(raw.Name ?? ''),
    AlbumCount: (raw.AlbumCount as number) ?? 0,
    ChildCount: (raw.ChildCount as number) ?? undefined,
    RunTimeTicks: (raw.RunTimeTicks as number) ?? undefined,
    ImageTags: (raw.ImageTags as Artist['ImageTags']) ?? undefined,
  };
}

/**
 * Normalize a raw Jellyfin album item from /Items?IncludeItemTypes=MusicAlbum endpoint.
 * Resolves AlbumArtist across versions:
 *   modern  → raw.AlbumArtist         (preferred)
 *   older   → raw.AlbumArtists?.[0]?.Name (fallback)
 *   oldest → undefined
 */
export function normalizeAlbum(raw: Record<string, unknown>): Album {
  return {
    Id: String(raw.Id ?? ''),
    Name: String(raw.Name ?? ''),
    AlbumArtist:
      (raw.AlbumArtist as string) ??
      (((raw.AlbumArtists as Array<{ Name?: string }>) ?? [])[0]?.Name as string) ??
      undefined,
    ProductionYear: (raw.ProductionYear as number) ?? undefined,
    PremiereDate: (raw.PremiereDate as string) ?? undefined,
    ChildCount: (raw.ChildCount as number) ?? undefined,
    RunTimeTicks: (raw.RunTimeTicks as number) ?? undefined,
    ImageTags: (raw.ImageTags as Album['ImageTags']) ?? undefined,
  };
}

/**
 * Normalize a raw Jellyfin playlist item from /Items?IncludeItemTypes=Playlist endpoint.
 * Resolves track count across versions:
 *   modern  → raw.ChildCount  (preferred)
 *   older   → raw.ItemCount   (fallback)
 *   oldest → undefined (allows LibraryItem to degrade gracefully without showing "0")
 */
export function normalizePlaylist(raw: Record<string, unknown>): Playlist {
  return {
    Id: String(raw.Id ?? ''),
    Name: String(raw.Name ?? ''),
    // undefined when absent lets LibraryItem hide subtitle instead of showing "0 tracks"
    ChildCount: (raw.ChildCount as number) ?? (raw.ItemCount as number) ?? undefined,
    RunTimeTicks: (raw.RunTimeTicks as number) ?? undefined,
    ImageTags: (raw.ImageTags as Playlist['ImageTags']) ?? undefined,
  };
}

/**
 * Normalize a raw Jellyfin genre item from /MusicGenres endpoint.
 * LibraryItems indicates how many items belong to this genre in Jellyfin's library.
 * Count is resolved as: modern `ItemCount` → older `ChildCount` → 0.
 */
export function normalizeGenre(raw: Record<string, unknown>): Genre {
  return {
    Id: String(raw.Id ?? ''),
    Name: String(raw.Name ?? ''),
    LibraryItems: (raw.ItemCount as number) ?? (raw.ChildCount as number) ?? 0,
  };
}

/**
 * Normalize a raw Jellyfin album artist item from /Artists/AlbumArtists endpoint.
 * Album Artists are distinct from Artists (performing artists at track level).
 * Jellyfin endpoint: GET /Artists/AlbumArtists
 * Note: Jellyfin requires `Fields=AlbumCount` in the API request to return AlbumCount.
 */
export function normalizeAlbumArtist(raw: Record<string, unknown>): AlbumArtist {
  return {
    Id: String(raw.Id ?? ''),
    Name: String(raw.Name ?? ''),
    AlbumCount: (raw.AlbumCount as number) ?? 0,
    ChildCount: (raw.ChildCount as number) ?? undefined,
    RunTimeTicks: (raw.RunTimeTicks as number) ?? undefined,
    ImageTags: (raw.ImageTags as AlbumArtist['ImageTags']) ?? undefined,
  };
}
