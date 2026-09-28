#!/usr/bin/env bash
# =============================================================================
# scripts/check-spanish.sh — guard the "English only" rule in CLAUDE.md
#
# Exits non-zero if any line in src/, tests/, docs/, the project-root *.md files
# or other scripts/ files (excluding this one and the regex definition below)
# contains Spanish text. The two patterns below are the canonical Spanish
# detectors; this file is the exception that defines them.
#
# Run before opening a PR:
#   bash scripts/check-spanish.sh
# =============================================================================
set -euo pipefail

PATTERN_ACCENTS='[áéíóúñÁÉÍÓÚÑ¿¡]'
PATTERN_WORDS='\b(Descarga|fallida|demasiado|incompleta|tamaño)\b'

# Search everything except the regex definition itself (this file).
HITS=$(
  grep -rnE "${PATTERN_ACCENTS}|${PATTERN_WORDS}" \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=release \
    src tests docs scripts *.md 2>/dev/null \
    | grep -v '^scripts/check-spanish.sh:' \
    || true
)

if [ -n "${HITS}" ]; then
  echo "Found Spanish text in repo (English only — see CLAUDE.md):" >&2
  echo "${HITS}" >&2
  exit 1
fi

echo "OK — no Spanish text found."
