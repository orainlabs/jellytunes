#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <patch|minor|major>
#
# This script bumps the version, commits, tags, and pushes.
# GitHub Actions picks up the tag and builds for macOS, Windows, and Linux.

BUMP_TYPE="${1:-}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: pnpm release <patch|minor|major>"
  exit 1
fi

# Ensure working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure we're on main
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: releases must be created from the main branch (currently on '$BRANCH')."
  exit 1
fi

# Read current version
OLD_VERSION="$(node -p "require('./package.json').version")"
echo "Current version: $OLD_VERSION"

# Bump version in package.json only (no git tag yet)
NEW_VERSION="$(npm version "$BUMP_TYPE" --no-git-tag-version)"
NEW_VERSION="${NEW_VERSION#v}"
echo "Bumping to: $NEW_VERSION"

# Commit and tag
git add package.json
git commit -m "chore: bump version to $NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# Push — GitHub Actions release workflow triggers on the tag
git push origin main
git push origin "v$NEW_VERSION"

echo ""
echo "Tag v$NEW_VERSION pushed. GitHub Actions will build and publish the release."
echo "https://github.com/tresnola-labs/jellytunes/actions"
