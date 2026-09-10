# Changelog

## [0.7.0] — 2026-09-10

### Added

- **Log in with your Jellyfin username and password** ([#9](https://github.com/orainlabs/jellytunes/issues/9)). An API key is no longer required to use JellyTunes. Password is now the default mode on the login screen, and the API key route stays one click away behind _Use an API key instead (advanced)_. The mode you used last is remembered, password sessions are stored encrypted and reconnect on launch, and the server URL field is focused when the screen opens.

### Changed

- **Jellyfin 12 support** ([#13](https://github.com/orainlabs/jellytunes/issues/13)). Every request now carries the `Authorization: MediaBrowser` header instead of the legacy `X-Emby-Token`. Jellyfin 12 rejects `X-Emby-Token` with a 401 out of the box, which is why 0.6.0 stopped resolving the library after a server upgrade. The single header covers Jellyfin 10.10 through 12, and a stable per-install device ID is now generated and sent alongside it.
- **HTTPS is required to log in**, for both password and API key. An API key sent over plaintext HTTP is an admin-capable, non-expiring credential, and a password is worse. Loopback addresses (`localhost`, `127.0.0.1`, `::1`) are exempt, since that traffic never leaves the machine. Sessions saved by an earlier version keep reconnecting as before; the gate applies when you log in.
- The library screen title now uses the tab label, so the Album Artists tab reads correctly instead of showing `albumArtists`.
- The About dialog tagline matches the one in the README and `package.json`.
- macOS builds ship unsigned again. The ad-hoc signing added after issue [#12](https://github.com/orainlabs/jellytunes/issues/12) rested on a wrong diagnosis and was reverted after testing 0.5.0 and 0.6.0 on real Apple silicon hardware. The README now explains the "damaged" dialog Apple silicon users actually see and the `xattr -cr` fix.

### Fixed

- A library tab that fails to load shows an empty or error state with a Retry button instead of an endless skeleton, on all five tabs. Retry now really refetches: it used to reset the tab to loading and then hit a guard that skipped the fetch, leaving it spinning forever.
- A login that cannot reach the server reports a readable message instead of `Failed to fetch`. The underlying error still goes to the log.
- "Could not identify user. Please select manually." is replaced by guidance about the API key, which is what that situation actually calls for.
- Genre browsing is scoped to the logged-in Jellyfin user, using the canonical userId query.
- Cancelling a sync stops mid-download instead of finishing the tracks already in flight, and no longer leaves `*.jt-tmp-*` orphans in the destination when the cancel lands during conversion.
- Password sessions refuse to auto-reconnect over plain HTTP, so a stored access token can't leak on restart.
- Login screen polish: focus rings on the mode toggles, no native browser validation bubble, and focus lands in the same place in both modes.

### Internal

- The Cucumber BDD suite is retired in favour of a Playwright E2E suite that runs against provisioned Jellyfin containers on both v11 and v12, with deterministic FFmpeg fixtures, per-version compose stacks and per-version server config. 28 scenarios green on both majors.
- Auth compatibility audit across Jellyfin 10.10 to 12 recorded in `docs/JELLYFIN_API.md`, including the `/Users/Me` 400 upstream quirk.
- Snap-aware analytics: the `linux-snap` platform value and four Snap Store sections in the dashboard.
- `main` is a rebase-only trunk; manual `git merge` is out.
- CI: explicit `permissions` blocks on the checks and worker workflows, `wrangler-action` pinned to a release commit, browserslist database refreshed.

## [0.6.0] — 2026-07-28

### Added

- **Snap package** — JellyTunes is on the Snap Store, so installing on Linux is one command and updates arrive on their own through snapd. If an interface it needs is not connected, the app says which one and gives you the command to connect it.
- **AppArmor profile in the `.deb`** — fixes the package failing to launch on Ubuntu 24.04.

### Changed

- **AppImage is deprecated.** It still runs, but Ubuntu 24.04+ can block Electron's sandbox, so it is no longer the recommended way to install. The [migration guide](docs/INSTALLATION.md) covers moving to Snap or `.deb`.
- `.deb` package metadata completed: multi-size icon set, synopsis, and homepage.

### Fixed

- The devices and folders list in the sidebar scrolls again in short viewports.
- The version update check no longer throws when the server answers with something unexpected.
- FFmpeg binaries are pinned per platform, so conversion behaves the same on every machine.
- USB and SD cards are detected reliably on Linux without shelling out to `df`.

### Internal

- Snap strict confinement work: USB and mount detection reworked to drop the `hardware-observe` and `mount-observe` interfaces, session storage moved to `secret-tool` (libsecret and the Secret portal) behind a provider selector, and interface state probed through `snapctl`.
- Snap builds and publishes from CI via LXD; release publishing is gated behind artifact verification.
- Windows CI fixed, and the logger no longer breaks under bundling.
- Test coverage added for packaging contracts, the secret store, and the Snap permissions mapper.

## [0.5.0] — 2026-06-07

### Added

- **Album Artists tab** — browse the library by album artist, distinct from track artist, with selection, sync, and track fetching fully independent from the Artists tab.
- **Genres** — browse, filter, and sync albums by genre via a dedicated Genres tab. Genre artwork is shown in the library list, the tab is toggleable for sync, and genres load on startup with a footer count.
- **ReplayGain tag embedding** — ReplayGain tags pulled from Jellyfin are embedded into synced tracks for consistent playback volume.
- **Hidden native menu bar** on Windows and macOS for a more focused window.
- **View → Toggle Developer Tools** menu item in dev builds.

### Fixed

- Resolved empty album and track tags when syncing by artist (batched `Ids=` fetch).
- Stopped the same track being repeatedly re-synced when shared across albums, by normalizing track metadata fields across all fetch endpoints.
- Device disk usage refreshes after a sync so the storage bar's "other" segment stays accurate.
- Storage bar audio segment no longer counts items marked WILL REMOVE.
- Hardened library pagination against servers that ignore the `Limit` parameter, guarding against endless loading on large libraries.
- More robust destination path handling using `path.dirname()` instead of brittle string slicing.

### Changed

- Replaced stray `console.warn` / `console.error` calls with the proper logger.
- `check` script aligned with CI and now runs the build in pre-commit.

## [0.4.0] — 2026-05-30

### Added

- **Lyrics sync** — full lyrics support: download `.lrc` sidecar files or embed lyrics directly into tracks. Handles Jellyfin 10.9+ JSON lyrics format and cleans up orphaned LRC files on mode change. Warns when embed mode is selected for FLAC/M4A tracks.
- **Cover art mode selector** — choose between embedded and companion file modes per device; setting is persisted across sessions.
- **Sync preview: three-column layout** — redesigned preview modal with fixed-width columns, total row, and per-category track/size/duration breakdown.
- **Sync preview: selection summary** — shows total tracks, combined duration, and estimated size before syncing.
- **Tick-based size estimation + batch track fetch** — track registry estimates file sizes during selection using tick-based sampling; album tracks are batch-fetched to reduce Jellyfin round-trips.
- **Shared `getTracksForItems` cache** in main process — prevents redundant fetches across concurrent requests.
- **`MAX_UNCACHED_FETCH_COUNT` threshold guard** — aborts selection when uncached track fetches would exceed the configured limit; item types are registered before selection to prevent guard bypass.
- **Select All: pagination and error handling** — dynamic page sizing, freeze on `totalCount` to prevent infinite loops, throttled concurrent fetches to avoid Jellyfin 500 errors, error notification, and tab-change cancellation.
- **Per-tab search state** — each library tab (Artists / Albums / Playlists) keeps an independent search query that persists when switching tabs.
- **Lazy image loading via `IntersectionObserver`** — library cover art loads on demand as rows enter the viewport.
- **Filter controls always visible** — filter/sort controls remain visible with a disabled state when they are not applicable, instead of being hidden.
- **`SyncSuccessModal`** replaces native `alert()` in all sync completion flows.

### Fixed

- Fixed stale `cover.jpg` and `.lrc` files not cleaned up when switching cover art mode or removing an item from selection.
- Fixed false "out of sync" detection when `coverArtMode` changes between activations.
- Fixed missing dot in LRC orphan path detection in `sync-core.ts`.
- Fixed sync v2 tech debt: disk-full hangs, ghost rows in `synced_tracks`, and concurrent temp file collisions.
- Fixed Select All race condition on large libraries; added visual feedback during bulk selection.
- Fixed Select All pagination infinite loop caused by a changing `totalCount`; now uses max page size and freezes the count.
- Fixed `EXDEV` error when moving temp files across device boundaries during sync (sync-files).
- Fixed race condition when companion cover directories were modified during sync loop — directories are now snapshotted before the loop begins.
- Fixed `willRemoveCount` in sync preview reflecting item count instead of track count.
- Fixed storage bar showing stale `~` prefix for artists with no indexed albums.
- Fixed storage bar not showing `~` while track sizes are still loading.
- Fixed library cover art disappearing on `onLoad` event.
- Fixed `dirPath` extraction in `sync-core.ts` using `lastIndexOf` instead of `path.dirname()`.
- Fixed lyrics not being processed for unchanged files when `lyricsMode` changes between syncs.
- Fixed non-404 lyrics fetch errors logged at error level on pre-10.9 servers; demoted to warn.
- Fixed sync preview per-category counts defaulting to `undefined`; now fall back to `0`. `formatDuration` now floors seconds correctly.
- Fixed UI regression: `setSyncSuccessData()` modal calls were accidentally removed.
- Fixed selection label showing cumulative count across all tabs instead of the active tab only.
- Fixed LoginScreen labels that were inadvertently translated to Spanish.
- Fixed cover art safety issues: temp file handling, error propagation, and `writeCompanionCover`.
- Fixed `syncedTracks` not being awaited before the uncached fetch threshold check.
- Fixed tick-based size estimation being too high (~500 kbps → ~280 kbps); suppressed unreliable track counts when size is tick-estimated.

### Changed

- Sync preview modal: removed per-item breakdown rows; shows aggregated totals only.
- Selection header layout: controls on the left, selection label on the right.
- Lyrics toggle order standardized to `off → embed → lrc`.
- Artist subtitles no longer show album count.
- Album subtitles no longer show `undefined` when track count is unavailable.

### Internal

- ESLint + Prettier activated across `src/` and `tests/`; security plugin rules enabled.
- Pre-commit hooks migrated from Husky to `.hooks`; includes typecheck and lint-staged.
- CI workflows unified into a single `checks` job; Windows smoke test removed.
- Vitest unit and sync tests switched to `node` environment for faster execution.
- Album track fetches in `getTracksForItems` are now batched rather than sequential.
- Stale cover path deduplication switched to `Set` for O(n) complexity.
- `formatBytes` extracted to `utils/format.ts`.

## [0.3.2] — 2026-04-27

### Changed

- Rebranded to **Orain Labs** — updated all repository links, emails, and API endpoints to `orainlabs.dev`
- Ko-fi and author references updated
- Legacy `oriaflow.dev` routes kept active for backwards compatibility

## [0.3.1] — 2026-04-17

### Fixed

- Fixed v0.2.x→v0.3.0 upgrade: synced items showed 0KB audio size and an empty "already synced" section in the sync preview. Tracks are now eagerly fetched for auto-selected synced items on device activation.
- Fixed the skip+convert heal path writing `null` file size to `synced_tracks` — the existing MP3 is now stat'd so the storage bar reflects accurate sizes after the first post-upgrade sync.
- Fixed cold-start crash (React error #311) on first launch — `createTrackRegistry` singleton no longer calls `useCallback` internally, which violated the Rules of Hooks.

## [0.3.0] — 2026-04-17

### Added

- **Sync preview modal** — before starting a sync, a modal shows a full breakdown of tracks to add, update, and remove, with color-coded rows (violet/yellow/green/red) and total size.
- **Out-of-sync detection** — the engine now detects tracks that have changed on the server since the last sync and marks them as "will update", not just new.
- **Storage bar redesign** — new visual indicator breaks down device space into synced music / selected / other files / free. Turns red when over capacity.
- **Estimated sizes with `~` prefix** — when MP3 conversion is active, sizes in the storage bar and preview modal are marked as approximate (`~120 MB (estimated)`).
- **Format-aware bitrate fallback** — size estimation picks a sensible default bitrate depending on the source format (FLAC vs existing MP3).
- **Persistent convert settings per destination** — the MP3 toggle and bitrate choice are saved per device and restored on next activation.
- **Preferences module** — durable settings storage wired into the main process.
- **Anonymous opt-in analytics** — lightweight usage metrics routed through a Cloudflare Worker proxy; can be toggled in the About modal.
- **Event-based USB watcher** — device detection rebuilt with OS events, retry logic, and a polling fallback; more reliable on all platforms.
- **Animated Selected size** — the "selected" size indicator animates during track loading so the user sees progress immediately.
- **Phase-aware sync progress** — the sticky footer progress bar now tracks individual sync phases (fetching / copying / converting / validating) with byte-level progress.

### Fixed

- Fixed FFmpeg argument order when embedding cover art into converted MP3s.
- Fixed stale closure in MP3 convert/bitrate handler — settings now captured correctly.
- Fixed negative sign on "will remove" count in sync preview modal.
- Fixed UI lockout during sync — Cancel is correctly the only blocked interaction; rest of the UI remains accessible.
- Fixed device storage size showing 0 on activation (itemTracks now populated from DB).
- Fixed skeleton flash when navigating library → sync tab and on device re-activation.
- Fixed selected size and preview track count for newly selected items on activation.
- Fixed track loading: tracks are now fetched eagerly on device activation, not lazily at sync time.
- Fixed About modal analytics toggle not matching the sync panel toggle style.
- Fixed `addDestination` returning a stale closure instead of the fresh destination object.

### Changed

- Migrated to Material Design 3 design tokens and typography scale.
- Sync preview modal and storage bar share a unified color language: violet = new, yellow = will-update, green = already-synced, red = will-remove.
- Folder removal redesigned with inline confirmation (no extra modal).
- Sync button shows a loading state while the preview is being computed.
- About modal now links to the privacy policy.
- `handleStartSync` no longer re-fetches tracks or calls `analyzeDiff` — data is pre-loaded at activation time.

### Internal

- Strict TypeScript configuration enabled across the project.
- `synced_tracks` DB schema improved; `columnExists` helper added; audio-format constants extracted.
- Vitest renderer infrastructure added; component and hook unit tests wired up.
- GitHub Actions CI/CD workflows updated.
