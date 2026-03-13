# Jellysync

Jellyfin music synchronizer → MP3/FLAC devices

[![BDD Tests](https://github.com/edgarquasarz/jellysync/actions/workflows/bdd-tests.yml/badge.svg)](https://github.com/edgarquasarz/jellysync/actions/workflows/bdd-tests.yml)

## Development

```bash
pnpm install
pnpm dev
```

## BDD Tests

```bash
# Run tests
pnpm test:bdd

# Development with visible UI
pnpm test:bdd:dev

# CI (headless)
pnpm test:bdd:ci

# View HTML report
pnpm test:bdd:report
```

## Ignored configuration

```
node_modules/
dist/
release/
*.log
test-*
```
