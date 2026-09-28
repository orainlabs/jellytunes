# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## English Only

Everything committed to this repo is in English: user-facing strings (UI text, error
messages, modal copy, validation messages), code comments, test descriptions and
`it()` names, and documentation under `docs/`. Music metadata (track names, album
names, artist names) is the user's own data and is exempt — proper nouns in
fixtures stay as-is regardless of accented characters.

Spanish in this repo is a bug. Before opening a PR, scan with two regexes:

- **Accented characters**: any line matching the Spanish-accent character class
  (defined in `scripts/check-spanish.sh`) is suspect. Acronyms and proper nouns
  are the only legitimate hit; everything else is Spanish.
- **Spanish vocabulary without accents**: words like "Acepta las tres formas",
  "ventana de soporte", "el sandbox del SO" pass the accent filter but are still
  Spanish. Agents must self-review what they wrote.

A canonical grep combining both patterns lives in `scripts/check-spanish.sh` —
run it before opening a PR. The script's own patterns are an exception (they
define the rule); everything else in `src tests docs scripts *.md` must return
zero matches.

Out of scope: task specs and bodies under `orainlabs/tasks/` (they live outside
the repo and may be written in the author's language).

## What This Project Does

JellyTunes is an Electron + React desktop app that syncs music libraries from a Jellyfin media server to portable devices (USB drives, SD cards). It handles selective sync, format conversion (FLAC→MP3 via FFmpeg), and preserves the server's folder structure on the destination device.

## Commands

```bash
# Development
pnpm dev              # Start dev server + Electron
pnpm build            # Compile with electron-vite
pnpm typecheck        # TypeScript type checking

# Testing
pnpm test             # Run unit tests (Vitest)
pnpm test:unit:watch  # Unit tests in watch mode
pnpm test:e2e         # E2E tests with Playwright

# Packaging
pnpm package          # Build + create installers
```

To run a single test file: `pnpm vitest run src/sync/sync.test.ts`

## Architecture

The app has three Electron processes plus a shared sync module:

**Main process** (`src/main/index.ts`) — IPC handlers for USB detection, file dialogs, and sync orchestration. Registers handlers like `sync:start2`, `usb:list`, `dialog:selectFolder`.

**Preload** (`src/preload/index.ts`) — IPC bridge that exposes a typed `api` object to the renderer. This is the contract between main and renderer.

**Renderer** (`src/renderer/src/App.tsx`) — Single large React component handling library navigation (artists/albums/playlists), device selection, and sync UI with progress tracking.

**Sync module** (`src/sync/`) — Standalone, testable sync engine with dependency injection:

- `sync-core.ts` — Main orchestrator that drives the sync phases (fetching → copying → converting → validating → complete)
- `sync-api.ts` — Jellyfin HTTP client (uses `/Items`, `/Items/{id}/Download`, `/Playlists/{id}/Items`)
- `sync-config.ts` — Config validation and `buildDestinationPath()` path construction
- `sync-files.ts` — File system and FFmpeg audio conversion operations
- `sync-progress.ts` — `ProgressEmitter` and `CancellationController`
- `types.ts` — All shared types (`SyncConfig`, `SyncInput`, `SyncProgress`, `SyncResult`, etc.)

The sync module uses dependency injection: `SyncCore` accepts `{ api, fs, converter }` interfaces, making it fully testable with mocks without touching the real filesystem or network.

## Key Jellyfin API Notes

- Artist IDs from Jellyfin don't directly map to album artist IDs — use `/Items?ParentId=` to fetch albums under an artist
- Playlists require `Fields=Path` query param to get track file paths
- Track downloads use `/Items/{id}/Download` with API key auth, not local file copy
- See `docs/JELLYFIN_API.md` for detailed endpoint research

## Path Handling

The sync module preserves the server's folder structure on the destination device. `serverRootPath` (auto-detected from common prefix of track paths) is stripped from each track's server path before joining with `destinationPath`. Path traversal (`..`) is explicitly blocked in `buildDestinationPath()`.

## Snap Store Listing

The Snap Store listing is maintained **by hand** in the snapcraft dashboard. It is not generated from this repo.

Editing the listing via the web dashboard set `update_metadata_on_release` to `false`, which broke the chain from the repo to the store. The consequences:

- `package.json` → `build.snapcraft.core24` (`title`, `summary`, `description`) is still baked into the `.snap` by electron-builder, and is still what `snap info` shows for a locally installed snap.
- The store listing **ignores** it. Uploading new revisions never changes the listing text.
- `version` is the exception: it flows from `package.json` into every revision automatically.

So the copy exists in two independent places and can drift silently — nothing in CI detects it. When changing user-facing copy, update `package.json` **and** the dashboard.

`license`, `contact`, `website`, `categories` and `keywords` only exist in the dashboard. electron-builder cannot emit them: `SnapOptions24` has no such fields, and `categories`/`keywords` are not snapcraft.yaml keys in any variant.

There is no changelog or "what's new" field in snapcraft.yaml, and the store listing has no per-version section. Apps that show release notes write them into the description body manually.

## Git Integration

`main` is a **rebase-only trunk** — its history stays linear, no merge commits.
Integrate a feature branch by rebasing it onto `main` and fast-forwarding:

```bash
git fetch origin
git rebase origin/main        # from the feature branch
git checkout main && git merge --ff-only <branch>
```

**Never `git merge <branch>` without `--ff-only`** — a merge commit breaks the
linear history. To undo one that already landed: `git update-ref refs/heads/main
<linear-tip> <merge-sha>` then `git push --force-with-lease`.

## Testing Strategy

- **Unit tests** live alongside source in `src/sync/*.test.ts` and also in `tests/unit/`
- **E2E tests** use Playwright in `tests/e2e/` — specs in `tests/e2e/specs/`, harness in `tests/e2e/support/`
- E2E runs against a containerised Jellyfin and is local-only, never a CI gate. See `docs/E2E_TESTING.md`
- E2E fixtures and `tests/e2e/.server.json` are generated, not committed
- Unit tests run on `ubuntu-latest` **and `windows-latest`** (`checks.yml`), never on macOS. Guard any assertion about POSIX-only properties (execute bits, path separators, symlinks) behind a platform check, even when the test describes macOS or Linux behaviour. An execute bit, for example, lives in the git index as mode `100755`; on NTFS `statSync().mode & 0o111` is always `0`.
