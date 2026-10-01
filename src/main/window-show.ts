/**
 * ORAIN-0764: show the main window even when `ready-to-show` never fires.
 *
 * Since Electron 44 (native Wayland ozone) a `show: false` window may never
 * receive its first compositor frame, so `ready-to-show` is not emitted and
 * the window stays hidden forever. Calling `show()` maps the surface and
 * unblocks the first paint, so a fallback is safe.
 *
 * The window is shown on the first of:
 *   1. `ready-to-show`
 *   2. `did-finish-load` + FINISH_LOAD_FALLBACK_MS
 *   3. ABSOLUTE_FALLBACK_MS after creation (covers a renderer that never
 *      finishes loading, e.g. a crash or `did-fail-load`)
 * and `show()` is called at most once per window.
 */

export const FINISH_LOAD_FALLBACK_MS = 1500;
export const ABSOLUTE_FALLBACK_MS = 10_000;

/** Minimal subset of the BrowserWindow surface this module touches. */
export interface ShowableWindow {
  show(): void;
  isDestroyed(): boolean;
  once(event: 'ready-to-show', handler: () => void): void;
  webContents: {
    on(event: 'did-finish-load', handler: () => void): void;
  };
}

export interface WindowShowDeps<TimerHandle> {
  window: ShowableWindow;
  timers: {
    setTimeout(handler: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
  };
  log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export function showWindowWithFallback<TimerHandle>(deps: WindowShowDeps<TimerHandle>): void {
  const { window, timers, log } = deps;
  let shown = false;
  let finishLoadTimer: TimerHandle | null = null;
  let finishLoadArmed = false;

  const showOnce = (message: string, level: 'info' | 'warn'): void => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    timers.clearTimeout(absoluteTimer);
    if (finishLoadTimer !== null) timers.clearTimeout(finishLoadTimer);
    window.show();
    log[level](message);
  };

  const showViaFallback = (): void =>
    showOnce('Window shown via fallback: ready-to-show did not fire', 'warn');

  const absoluteTimer = timers.setTimeout(showViaFallback, ABSOLUTE_FALLBACK_MS);

  window.once('ready-to-show', () => showOnce('Window ready', 'info'));

  window.webContents.on('did-finish-load', () => {
    // Reloads emit did-finish-load again; one timer is enough.
    if (finishLoadArmed || shown) return;
    finishLoadArmed = true;
    finishLoadTimer = timers.setTimeout(showViaFallback, FINISH_LOAD_FALLBACK_MS);
  });
}
