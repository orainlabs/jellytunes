#!/usr/bin/env bash
# Download statistics from GitHub Releases
# Usage: bash scripts/download-stats.sh

REPO="tresnola-labs/jellytunes"

echo "Fetching download stats for $REPO..."
echo ""

gh api "repos/$REPO/releases" --jq '
  .[] |
  "Release: \(.tag_name) (\(.published_at | split("T")[0]))",
  (.assets[] | "  \(.name): \(.download_count) downloads"),
  ""
'
