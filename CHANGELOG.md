# Changelog

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
