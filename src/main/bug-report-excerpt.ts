/**
 * ORAIN-0747 — pure excerpt builder for the "Report a Bug" body.
 *
 * Extracts the last sync block (start + track failures + end) from
 * main.log, plus a small tail of other recent errors, and trims the
 * result to fit the GitHub issue-body URL budget.
 *
 * No fs or Electron imports: this module operates on log content already
 * read into memory, so it stays fully testable without touching disk.
 */

// Measured 2026-09-28: GitHub accepts a full
// `https://github.com/<org>/<repo>/issues/new?body=<...>` URL up to 7061
// characters (HTTP 302) and rejects 7063 (HTTP 500). 7061 * 0.9 ≈ 6354;
// rounded down to 6300 for extra cushion against org/repo name length and
// other query-string overhead.
export const URL_BUDGET = 6300;
