# Contributing to JellyTunes

Thanks for your interest in contributing! Here's how you can help.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/tresnola-labs/jellytunes/issues) with:

- Steps to reproduce the problem
- What you expected to happen vs. what actually happened
- Your OS, Electron version, and Jellyfin server version

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm typecheck` and `pnpm test` to verify nothing is broken
4. Open a Pull Request with a clear description of what you changed and why

## Development Setup

```bash
pnpm install
pnpm dev
```

See the [README](README.md) for all available commands.

## Code Style

- TypeScript throughout
- React for the renderer UI
- Keep functions small and files focused
- Handle errors explicitly — don't swallow them

## Commit Messages

Follow this format:

```
<type>(<scope>): <subject>

- Bullet points describing what changed and why
- Keep lines under 72 characters

Closes #<issue>, relates to #<issue>
```

### Types
- `feat` — New feature
- `fix` — Bug fix
- `refactor` — Code refactoring
- `test` — Adding/updating tests
- `docs` — Documentation only
- `chore` — Maintenance, deps, build config

### Example
```
feat(usb-detection): add polling backup to detect mount/unmount without disconnect

- Runs polling backup concurrently with event-based usb-detection
- Detects volume unmount from Finder/eject without physical device disconnect
- Uses 15s polling interval with 5s cooldown to avoid duplicate events

Closes JELLY-0005, JELLY-0009
```

### Rules
- First line: type(scope): subject (max 50 chars)
- Body: bullet points explaining what/why (not how)
- Last line: references to issues/tasks (Closes, Fixes, Relates to)
- Use imperative mood ("add" not "added")

## License

By contributing to JellyTunes, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).
