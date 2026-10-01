/**
 * ORAIN-0762: Single-instance lock.
 *
 * Electron's `app.requestSingleInstanceLock()` returns `true` for the first
 * instance and `false` for every subsequent launch. The primary instance
 * receives a `second-instance` event whenever another launch is attempted
 * and is expected to focus its existing window.
 *
 * The lock file lives under `app.getPath('userData')`, so it is scoped per
 * --user-data-dir. Under snap this is $SNAP_USER_DATA and the snap
 * confinement still allows writing there (no new plug needed).
 *
 * The lock MUST be acquired before opening the database, configuring the
 * session logger, creating the window, or scheduling the update check —
 * otherwise a second launch races against the primary on `jellytunes.db`
 * and `main.log`. The wrapper here takes injectable `app`, `getMainWindow`,
 * and `quit` so the call site in `index.ts` can pass them in without the
 * module importing electron at the top level (testability).
 */

/** Minimal subset of the BrowserWindow surface this module touches. */
export interface FocusableWindow {
  isMinimized(): boolean;
  isDestroyed(): boolean;
  restore(): void;
  focus(): void;
}

export interface SingleInstanceDeps {
  /** Electron's `app` — injected so the test can pass a fake. */
  app: {
    requestSingleInstanceLock(): boolean;
    on(event: 'second-instance', handler: () => void): void;
    quit(): void;
  };
  /** Returns the current main window, or null if it has been closed. */
  getMainWindow: () => FocusableWindow | null;
  /**
   * Called when the lock is denied. In production this is `app.quit()`,
   * but the indirection lets the test substitute a spy.
   */
  quit: () => void;
}

export interface SingleInstanceResult {
  /** True when this process is the primary instance. */
  acquired: boolean;
}

/**
 * Try to become the primary instance.
 *
 * - On success: registers a `second-instance` listener that restores + focuses
 *   the existing window (no-op if it has been destroyed) and returns
 *   `{ acquired: true }`.
 * - On failure: calls `quit()` once and returns `{ acquired: false }`. The
 *   caller must NOT proceed with database / logger / window setup.
 */
export function acquireSingleInstanceLock(deps: SingleInstanceDeps): SingleInstanceResult {
  const { app, getMainWindow, quit } = deps;

  if (!app.requestSingleInstanceLock()) {
    quit();
    return { acquired: false };
  }

  app.on('second-instance', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      // No live window — let the caller-side `activate` handler recreate it.
      // Restoring a destroyed window would crash; focusing nothing would
      // silently swallow the user gesture.
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });

  return { acquired: true };
}
