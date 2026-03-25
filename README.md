<p align="center">
  <img src="assets/icon.png" alt="JellyTunes" width="128" height="128" />
</p>

<h1 align="center">JellyTunes</h1>

<p align="center">
  Sync your Jellyfin music library to any USB drive or SD card — with optional FLAC to MP3 conversion.
</p>

<p align="center">
  <a href="https://github.com/oriaflow-labs/jellytunes/releases/latest"><img src="https://img.shields.io/github/v/release/oriaflow-labs/jellytunes" alt="Latest Release" /></a>
  &nbsp;
  <a href="https://www.gnu.org/licenses/gpl-3.0"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL v3" /></a>
</p>

<p align="center">
  <a href="https://ko-fi.com/oriaflowlabs"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support on Ko-fi" /></a>
</p>

---

JellyTunes is a desktop app for [Jellyfin](https://jellyfin.org) users who want to take their music offline. Browse your server's artists, albums, and playlists, pick a destination device, and hit sync. JellyTunes downloads everything, converts formats if needed, and mirrors your server's folder structure on the device.

## Key Features

- **Browse your full library** — artists, albums, and playlists pulled directly from your Jellyfin server
- **Selective sync** — only downloads what's new or changed; skips tracks already on the device
- **FLAC to MP3 conversion** — built-in FFmpeg support with configurable bitrate (128k / 192k / 320k)
- **Smart filesystem handling** — auto-detects FAT32, exFAT, and NTFS; sanitizes filenames accordingly
- **Per-device history** — remembers what was synced to each device so you can pick up where you left off
- **Cancel anytime** — stop a sync mid-progress without corrupting what's already been written

## Screenshots

<p align="center">
  <a href="assets/screenshot-albums.png"><img src="assets/screenshot-albums.png" alt="Browse your Jellyfin library" width="400" /></a>
  &nbsp;&nbsp;
  <a href="assets/screenshot-sync.png"><img src="assets/screenshot-sync.png" alt="Sync to device with MP3 conversion" width="400" /></a>
</p>
<p align="center">
  <em>Browse your library &nbsp;·&nbsp; Sync to any device with optional MP3 conversion</em>
</p>

## Installation

Download the latest release for your platform from [GitHub Releases](https://github.com/oriaflow-labs/jellytunes/releases):

| Platform | File |
|----------|------|
| macOS | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.AppImage` or `.deb` |

Open the installer and follow the prompts. No additional setup is required — FFmpeg is bundled with the app.

### macOS: "App is damaged" or Gatekeeper warning

JellyTunes is not signed with an Apple Developer certificate. macOS may block it on first launch, especially on macOS 15 (Sequoia). To open it:

**Option A — via Terminal (recommended):**
```bash
xattr -cr /Applications/JellyTunes.app
```
Then open the app normally.

**Option B — via System Settings:**
1. Try to open the app (it will be blocked)
2. Go to **System Settings → Privacy & Security → Security**
3. Click **"Open Anyway"** next to the JellyTunes entry

### Prerequisites

- A [Jellyfin](https://jellyfin.org) server reachable on your network
- A USB drive, SD card, or any mounted storage device

---

## Development

Everything below is for contributors and developers who want to build JellyTunes from source.

### Setup

```bash
git clone https://github.com/oriaflow-labs/jellytunes.git
cd jellytunes
pnpm install
pnpm dev
```

This starts the Vite dev server and launches the Electron window.

**Requirements**: Node.js 18+ and [pnpm](https://pnpm.io)

### Commands

```bash
# Development
pnpm dev              # Start dev server + Electron
pnpm build            # Compile with electron-vite
pnpm typecheck        # TypeScript type checking

# Testing
pnpm test             # Unit tests (Vitest)
pnpm test:unit:watch  # Unit tests in watch mode
pnpm test:bdd         # BDD tests headless (Cucumber + Playwright)
pnpm test:bdd:dev     # BDD tests with visible UI

# Packaging
pnpm package          # Build + create installers
```

### Architecture

Three Electron processes plus a standalone sync engine:

- **Main process** (`src/main/`) — IPC handlers, USB/filesystem detection, sync orchestration
- **Preload** (`src/preload/`) — typed IPC bridge between main and renderer
- **Renderer** (`src/renderer/`) — React UI for library navigation, device selection, and sync progress
- **Sync module** (`src/sync/`) — dependency-injected sync engine (API client, file ops, FFmpeg converter); fully unit-testable without hitting the network or filesystem

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on reporting bugs, submitting changes, and code style.

## License

This project is licensed under the GNU General Public License v3.0 — see the [LICENSE](LICENSE) file for details.
