# E2E Testing

JellyTunes uses Playwright to drive the real Electron app against a containerised Jellyfin server. The suite runs locally on the developer's machine and is not a CI gate.

## Quick Start

**First time only in a fresh checkout / worktree** — build the native addons for
the Electron ABI, then bake the two provisioned Jellyfin images (this also
generates ~46 MB of fixtures per version):

```bash
pnpm install                           # runs electron-builder install-app-deps
                                       # (better-sqlite3 etc. against Electron 33)
bash tests/e2e/docker/rebuild.sh v11   # jellytunes-e2e:1-v11 from jellyfin/jellyfin:10.10.3
bash tests/e2e/docker/rebuild.sh v12   # jellytunes-e2e:1-v12 from jellyfin/jellyfin:12.0-rc7.20260831-232051
```

If a run fails at `firstWindow()` / "Target page … has been closed", the native
addons were not rebuilt for this working copy — run `pnpm run postinstall`.

**Every day:**

```bash
# Run the full matrix — both jellyfin-v11 and jellyfin-v12 in one invocation
pnpm test:e2e

# Run only one version (note: no `--` — pnpm 11 does not forward args past it)
pnpm test:e2e --project=jellyfin-v11
pnpm test:e2e --project=jellyfin-v12

# After you're done, stop the containers. Keep `-v`: the images declare anonymous
# /config and /cache volumes, and a plain `down` leaves them behind. After the next
# rebuild.sh they shadow the freshly baked config, so the API key in .server.*.json
# no longer exists in the container and every check fails with HTTP 401.
docker compose -f tests/e2e/docker-compose.v11.yml down -v
docker compose -f tests/e2e/docker-compose.v12.yml down -v
```

> **Note on version naming**: The project labels jellyfin-v11 and jellyfin-v12 are colloquial — they refer to Jellyfin major lineages (10.10.x → 10.11.x is "v11", 12.0.x → 12.1.x is "v12"). The actual images pinned are 10.10.3 and 12.0-rc7.20260831-232051 (immutable timestamped tag).

Jellyfin needs roughly 22 seconds from a cold up -d to answer HTTP requests. The test suite's global setup polls for up to 60 seconds before giving up with an actionable error message.

## Compatibility matrix (v11 / v12 — permanent dual gate)

JellyTunes must work against Jellyfin **v10.10–v11** (legacy auth included) **and**
against **v12** with hardened auth (`EnableLegacyAuthorization=false`). The two
Playwright projects are the standing gate for both ends of that range:

| Project        | Image                                        | Auth posture                                                                 |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `jellyfin-v11` | `jellyfin/jellyfin:10.10.3`                  | legacy `X-Emby-Token` still accepted                                         |
| `jellyfin-v12` | `jellyfin/jellyfin:12.0-rc7.20260831-232051` | `EnableLegacyAuthorization=false`, modern `Authorization: MediaBrowser` only |

`rebuild.sh v12` injects the hardening flag into `system.xml` before baking the
image. Both suites run the same 10 scenarios and are expected to end **13 passed /
1 skipped** (E5 is the parked `fixme`; E10 is the new password-mode spec added
in ORAIN-0564 SO-3). Audited green end-to-end against real containers in
ORAIN-0599 (see `docs/JELLYFIN_API.md` → "Authentication header").

## Test Status

The suite runs 10 scenarios (14 Playwright tests):

| Scenario                   | Status     | Notes                                                                                                                                                                                   |
| -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** Connection          | ✅ Passing | Verifies the Electron app connects to Jellyfin via the apikey form (default mode)                                                                                                       |
| **E2** Sync & disk tree    | ✅ Passing | Downloads tracks and validates folder structure on disk                                                                                                                                 |
| **E3** Re-sync no-op       | ✅ Passing | Historically flaked ~1 in 8. ORAIN-0599 traced it to the post-sync "Sync complete" modal painting after `listTree` sees the files; `dismissSyncSuccessModal()` now waits the modal out. |
| **E4** FLAC→MP3 conversion | ✅ Passing | Converts FLAC to MP3 and validates output                                                                                                                                               |
| **E5** Cancellation        | 🚧 Parked  | Full scenario body and assertions intact. Tracked by ORAIN-0671.                                                                                                                        |
| **E6** Playlist sync       | ✅ Passing | Asserts the tracks and the generated .m3u8 index, including that its entries resolve on disk                                                                                            |
| **E7** Deselect & remove   | ✅ Passing | Exercises the delete-only preview branch and asserts the destination ends empty                                                                                                         |
| **E8** Metadata layout     | ✅ Passing | Untagged album (AlbumId→MusicAlbum) and compilation folder placement — 2 tests                                                                                                          |
| **E9** Navigation          | ✅ Passing | Tabs, server-side search and select-all — 4 tests, no sync, fastest in the suite                                                                                                        |
| **E10** Password auth      | ✅ Passing | Same library assertion as E1 but drives `login()` in `'password'` mode. Both projects run it. (ORAIN-0564 SO-3)                                                                         |

The dual-project matrix exercises **both** auth flows against both Jellyfin
majors:

| Auth flow → / Jellyfin project | `jellyfin-v11` | `jellyfin-v12` |
| ------------------------------ | -------------- | -------------- |
| API key (default mode)         | E1             | E1             |
| Username + password            | E10            | E10            |

`provision.mjs` writes `username: 'e2e'` and `password: 'e2e-password'` into
`.server.<version>.json`; the E10 spec pulls them through `login()`'s
`serverConfig` to switch the LoginScreen into password mode.

Password auth normally refuses a plain-`http://` server URL (credentials must
not cross the wire in the clear). The containers are served at
`http://127.0.0.1:809{6,7}`, so `isSecureAuthUrl()` exempts loopback hosts
(`localhost`, `127.0.0.0/8`, `[::1]`) — the browser "potentially trustworthy
origin" rule. E10 therefore exercises the real password flow without a TLS
terminator; the non-loopback `http://` block stays covered by
`useJellyfinConnection.test.tsx`.

The select-all confirmation dialog (select-all-confirm-dialog) is not covered: it only opens above 500 items and the fixture library has four. Covering it would require a fixture library two orders of magnitude larger, which is not worth the runtime.

## Known Issues

### E5: Sync Cancellation (Parked)

Clicking the cancel button mid-sync does not reliably prevent all tracks from being written. This is not a narrow timing race:

- **Observed behavior**: With 600-second fixtures, a sync runs roughly 30 seconds. The cancel button was clicked approximately 1 second into the sync, and all three tracks were written anyway.
- **Wiring is correct**: The cancel path is wired end-to-end and has been traced through:
  - useSync.ts:529 handleCancelSync
  - → window.api.cancelSync()
  - → ipcMain.handle('sync:cancel') at src/main/index.ts:1209
  - → cancelSync() at src/main/index.ts:587
  - → activeSyncCore.cancel()

  There is no guard that swallows the click, so "the click goes nowhere" is ruled out.

- **Unresolved question**: The next diagnostic step is to run the app with a fixed --user-data-dir, capture the logs with electron-log, and check whether the line "Sync cancellation requested" appears. If the line is present and all three tracks were still written, the app received the cancellation request and ignored it — a genuine defect in activeSyncCore.cancel(). If the line is absent, the IPC message never arrived — a test-side problem.

- **Unit tests don't catch it either**: The existing unit test at src/sync/sync.test.ts:899 accepts either outcome ("should either cancel or complete (race condition)"), so the unit layer would not catch a broken cancellation.

- **What remains intact**: The full scenario body and all assertions, including the guard that fails when the sync completes before it can be cancelled, are in tests/e2e/specs/e5-cancel.spec.ts. Nothing was weakened or omitted — only parked pending the diagnostic result.

### v12 provisioning — resolved (ORAIN-0678 + ORAIN-0599)

`bash tests/e2e/docker/rebuild.sh v12` and `pnpm test:e2e --project=jellyfin-v12`
both work. History, for the record:

- ORAIN-0678 migrated `provision.mjs` to the `Authorization: MediaBrowser`
  header. The `{ Username, Pw }` body to `/Users/AuthenticateByName` is fine on
  Jellyfin 12.0 — that part was never the problem.
- ORAIN-0599 fixed what actually remained:
  1. `rebuild.sh` hardcoded the moving `jellyfin/jellyfin:12.0-rc7` rc tag →
     now pinned to the immutable `12.0-rc7.20260831-232051`.
  2. `rebuild.sh` ran `docker cp` against the _live_ throwaway container, baking
     an inconsistent SQLite snapshot (uncheckpointed WAL) that crashed Jellyfin
     12's migration service on boot (exit 139). It now `docker stop`s the
     container first.
  3. Both compose files derived the same Compose project name (`e2e`), so
     `pnpm test:e2e` (both projects) evicted one container while starting the
     other. Each file now declares a unique `name:`.

## Test Library

The suite tests against a Jellyfin library with:

- 3 artists
- 4 albums (including one compilation and one with untagged tracks)
- 10 tracks total
- 1 playlist
- FLAC, MP3, and untagged audio formats

The music library and test fixtures are generated in tests/e2e/fixtures/music/ by running bash tests/e2e/docker/rebuild.sh. They are byte-reproducible via shasum and are gitignored (never committed).

## Selector Naming Convention

Test selectors use the data-testid attribute for locating UI elements. These conventions ensure consistent, maintainable test code.

### Authentication Screen

The auth screen renders one of two forms. The default (apikey) form is what
E1 drives; the password form is what E10 drives (ORAIN-0564 SO-3).

```tsx
// apikey mode (default — E1)
<div data-testid="auth-screen">
  <input data-testid="server-url-input" type="url" />
  <input data-testid="api-key-input" type="password" />
  <button data-testid="connect-button">Conectar</button>
  <button data-testid="mode-toggle-password">Use username + password</button>
  {error && <div data-testid="error-message">{error}</div>}
</div>

// password mode (E10)
<div data-testid="auth-screen">
  <input data-testid="server-url-input" type="url" />
  <input data-testid="username-input" type="text" />
  <input data-testid="password-input" type="password" />
  <button data-testid="connect-button">Sign in</button>
  <button data-testid="mode-toggle-apikey">Use an API key instead</button>
  {error && <div data-testid="error-message">{error}</div>}
</div>
```

### Library Screen

```tsx
<div data-testid="library-screen">
  <div data-testid="library-content">
    <button data-testid="tab-artists">Artistas</button>
    <button data-testid="tab-albums">Albums</button>
    <button data-testid="tab-playlists">Playlists</button>

    <div data-testid="artists-list">
      {artists.map((artist) => (
        <div key={artist.id} data-testid="artist-item">
          <span data-testid="artist-name">{artist.name}</span>
          <span data-testid="album-count">{artist.albumCount}</span>
        </div>
      ))}
    </div>

    <div data-testid="albums-list">
      {albums.map((album) => (
        <div key={album.id} data-testid="album-item">
          <img data-testid="album-cover" src={album.coverUrl} />
        </div>
      ))}
    </div>
  </div>
</div>
```

### Tracks List

```tsx
<div data-testid="tracks-list">
  {tracks.map((track) => (
    <div key={track.id} data-testid="track-item">
      <input data-testid="track-checkbox" type="checkbox" />
      <span data-testid="track-number">{track.number}</span>
      <span data-testid="track-title">{track.title}</span>
      <span data-testid="track-duration">{track.duration}</span>
    </div>
  ))}
</div>
```

### USB Device & Synchronization

```tsx
{deviceConnected && (
  <div data-testid="usb-device-connected">
    <span data-testid="device-name">{device.name}</span>
    <span data-testid="available-space">{formatBytes(device.space)}</span>
  </div>
)}

<button data-testid="sync-button" disabled={!deviceConnected}>
  Sincronizar
</button>

<span data-testid="selected-count">{selectedCount}</span>
<span data-testid="required-space">{formatBytes(requiredSpace)}</span>

{syncing && (
  <div data-testid="sync-progress">
    <progress data-testid="sync-progress-bar" value={progress} max={100} />
  </div>
)}

{syncComplete && <div data-testid="sync-complete">Sync complete</div>}
{syncCancelled && <div data-testid="sync-cancelled">Sync cancelled</div>}
```

### Search & Filters

```tsx
<input data-testid="search-input" type="search" />

<button data-testid="filter-button">Filtros</button>

{activeFilters.map(filter => (
  <span key={filter.id} data-testid="active-filter">{filter.label}</span>
))}

<div data-testid="search-results">
  {results.map(result => (
    <div key={result.id} data-testid="search-item">
      <span data-testid="result-type">{result.type}</span>
    </div>
  ))}
</div>

<button data-testid="clear-filters-button">Limpiar filtros</button>
```

### Breadcrumbs & Navigation

```tsx
<nav data-testid="breadcrumb">
  {breadcrumbs.map((crumb, index) => (
    <span key={index}>{crumb.label}</span>
  ))}
</nav>
```

### Offline & Error States

```tsx
{
  isOffline && <div data-testid="offline-status">Modo offline</div>;
}

<div data-testid="cached-content">{/* Cached content */}</div>;

{
  error && (
    <div data-testid="generic-error-message">
      {userFriendlyMessage}
      <button onClick={showTechnicalDetails}>Show technical details</button>
    </div>
  );
}

{
  technicalDetails && <pre data-testid="technical-details">{JSON.stringify(details, null, 2)}</pre>;
}
```

### Selector Guidelines

1. All data-testid values must be unique within their context
2. Dynamic lists (artists, albums, tracks) should use consistent data-testid values across iterations
3. Conditional elements should have data-testid for both true and false states when relevant
4. Prefer data-testid over CSS classes for test selectors
5. Do not remove data-testid from production builds — they have minimal impact and enable real-user debugging

## Server Configuration

The test suite reads server connection details from tests/e2e/.server.v11.json or .server.v12.json (one per version), gitignored files generated by rebuild.sh:

```json
{
  "url": "http://localhost:8096",
  "apiKey": "YOUR_JELLYFIN_API_KEY",
  "userId": "...",
  "username": "e2e",
  "password": "e2e-password"
}
```

The `username` / `password` fields are used by **E10 only** (password-mode
login). They are written by `provision.mjs` so every scenario matrix entry
above can run without extra setup. This file is generated (never committed)
to avoid leaking credentials in a public repository.

## Fixtures & Generated Data

Music fixtures are generated in tests/e2e/fixtures/music/ by the rebuild script and are byte-reproducible. They are gitignored and regenerated on each rebuild.sh run.

## Why the Suite Never Skips

The test suite's globalSetup hook explicitly fails (with an actionable error message) if the Jellyfin server is unavailable. There is no silent skip. This ensures that developers catch connectivity issues immediately instead of getting a false green.

## Local Development Only

The E2E suite is designed for local development. It is:

- Not a CI gate
- Not run in workflows
- Requires Docker to be running
- Requires manual docker compose management

For CI-gated testing, the suite relies on unit tests and critical user flow assertions in the Playwright config.
