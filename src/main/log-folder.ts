// ORAIN-0727: thin, testable helper that opens the system file manager on
// the current log file.
//
// The IPC handler in `index.ts` takes no payload from the renderer —
// instead it asks `electron-log` for the file path and hands that to
// `shell.showItemInFolder`. This module keeps the contract obvious so the
// handler can be unit-tested in isolation (see log-folder.test.ts).

import type { shell as ElectronShell } from 'electron';

export type LogPathResolver = () => string;

/** Narrow surface of `electron.shell` we use — easy to mock. */
export interface ShellLike {
  showItemInFolder: typeof ElectronShell.showItemInFolder;
}

/**
 * Resolve the current log file via `resolve` and ask the shell to reveal
 * it. The first argument is intentionally ignored if it happens to be
 * passed — the renderer never gets to choose the path.
 *
 * Kept as a pure function so the renderer-ignores-arguments contract
 * (AC2) is enforced by tests, not by hope.
 */
export function showLogFileInFolder(
  _rendererSuppliedPath: unknown,
  resolve: LogPathResolver,
  shell: ShellLike,
): void {
  shell.showItemInFolder(resolve());
}
