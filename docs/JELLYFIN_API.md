# Jellyfin API Notes

This document collects hard-won facts about the Jellyfin HTTP API that the
JellyTunes sync engine relies on. Each section explains the endpoint, the
query parameters we use, and the semantic traps the API does NOT document
clearly.

## Artist vs AlbumArtist queries

Jellyfin distinguishes three different relationships between a `Person` and a
track. Each one is a separate filter parameter on `/Users/{userId}/Items`:

| Param | Semantic |
|---|---|
| `ArtistIds`        | Match the `Artists` array on the track OR the `AlbumArtists` on its album. Broadest. |
| `AlbumArtistIds`   | Match the `AlbumArtists` field on the track's album. Album-level. |
| `ContributingArtistIds` | Match the `Artists` array on the track only (excluding album-level credit). |

The `ArtistIds` vs `AlbumArtistIds` distinction was the source of ORAIN-0534
("artists and albumArtists are separate entities") and the source of the
label/routing bugs fixed in ORAIN-0554 ("shared id is typed as the last
list registered, not the tab the user clicked").

### Which one does JellyTunes use, and why

`getArtistTracks(itemId, type)` in `src/sync/sync-api.ts` selects the endpoint
based on the **caller's intent** (the tab the user clicked):

- `type === 'albumArtist'` → `/Users/{userId}/Items?AlbumArtistIds={id}&includeItemTypes=MusicAlbum&Recursive=true&...`
  then expand to tracks via `getAlbumTracks(albumId)`. This returns
  "every track on every album this person is the album artist of" — the
  natural semantic for the **Album Artists** tab.

- `type === 'artist'` → `/Users/{userId}/Items?ArtistIds={id}&includeItemTypes=Audio&Recursive=true&...`
  **directly on Audio items**. This returns "every track where this person
  has any credit", including contributions on albums owned by other
  artists. This is the natural semantic for the **Artists** tab: a user
  selecting an artist from the Artists tab expects their collaborations
  on other artists' records to be synced too.

### Why this matters

The pre-ORAIN-0554 flow for the `artist` case did `AlbumArtistIds=` on
**MusicAlbum** items and then expanded to tracks. Two problems:

1. **Missed contributions.** Tracks on albums owned by another artist
   (e.g. a guest vocal on someone else's record) were never returned,
   because the album-level filter did not match them. A user syncing
   "Radiohead" as an artist did not get Thom Yorke's guest vocal on
   other artists' tracks.

2. **Possible double counting in adjacent cases.** If the same artist id
   appeared as both a regular `Artist` and an `AlbumArtist` on the same
   album, the old album→tracks flow could include the same track twice
   under two different parent ids.

The new direct-Audio query also returns the contribution track, exactly
once.

### `contributingArtistIds` — the narrower alternative

`ContributingArtistIds=` would be a tighter "performer-only" semantic
(only matches the `Artists` array, never the album-level credit). We
chose `ArtistIds=` because it matches the user mental model: when you
select "The Beatles" as an artist you almost certainly want every track
where any Beatle has credit, including Paul McCartney's Wings work that
Jellyfin might list under a different `AlbumArtist`.

**Status: pending manual verification.** The exact match semantics of
`ArtistIds=` vs `ContributingArtistIds=` on a real Jellyfin server with
real metadata edge cases (e.g. compilation albums, `Various Artists`
albums) have not been exhaustively tested. If a user reports missing or
unexpected tracks in the Artists tab, the first thing to try is
swapping `ArtistIds=` for `ContributingArtistIds=` and re-running the
sync, then updating this section with the observed behavior.

### Related fix: routing by tab, not by registry

The fix is half-wired without the corresponding routing fix in the
renderer. `getArtistTracks` is given a `type` argument; that argument
must reflect the tab the user clicked, not the type Jellyfin's
`getItemType` registry has cached for the id. Otherwise a shared id
(present in both the Artists and AlbumArtists lists on the Jellyfin
server) is always routed through the album-artist code path because the
album-artist list is registered second (`last-write-wins`).

`LibraryContent.handleToggle` (`src/renderer/src/components/LibraryContent.tsx`)
forwards the active tab as `viewType` to `deviceSelections.toggleItem`,
and `useDeviceSelections.toggleItem` prefers the caller-supplied
`viewType` over the registry fallback.

`App.tsx` builds the `itemTypes` map for device activation through
`buildItemTypes` in `src/renderer/src/utils/selectionTypes.ts`, which
overrides the registry type with the typed set (`selectedArtists` /
`selectedAlbumArtists`) when an id is present in either. This is what
makes the DeviceSyncPanel label and the sync-engine type both reflect
the user's intent.

## Path handling

`buildDestinationPath()` in `src/sync/sync-config.ts` strips the
auto-detected `serverRootPath` from each track's path before joining
with `destinationPath`. Path traversal (`..`) is explicitly blocked.

`serverRootPath` is computed as the longest common path prefix of all
the track paths returned for the current sync. It is re-detected on
every sync so it follows the user's library layout without manual
configuration.

## Track downloads

`/Items/{id}/Download` returns the actual audio bytes. We stream
straight to the destination device rather than caching to disk first.
This keeps the temp-dir footprint bounded by the size of one track, not
the size of the whole sync.

## Playlists

`/Playlists/{id}/Items` does NOT require `UserId` to be passed when the
caller is authenticated with an API key that has library access, but
passing `UserId={this.userId}` is harmless and explicit. `Fields=Path`
is required — without it, `MediaSources[0].Path` is null and the
tracks are filtered out as un-syncable.

## Albums

`/Items?parentId={albumId}&includeItemTypes=Audio&Recursive=true` is
the most reliable way to fetch all tracks under an album. The
alternative `albumIds=` is unreliable when the track's `Album` field is
NULL (a data-quality edge case we've observed in real Jellyfin
libraries).
