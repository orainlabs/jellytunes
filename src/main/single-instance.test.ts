import { describe, it, expect, vi } from 'vitest';
import { acquireSingleInstanceLock } from './single-instance';

interface FakeApp {
  requestSingleInstanceLock: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

function makeFakeApp(granted: boolean): { app: FakeApp; handlers: Map<string, () => void> } {
  const handlers = new Map<string, () => void>();
  const app: FakeApp = {
    requestSingleInstanceLock: vi.fn().mockReturnValue(granted),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    quit: vi.fn(),
  };
  return { app, handlers };
}

describe('acquireSingleInstanceLock', () => {
  it('returns acquired=true when lock is granted and registers second-instance listener', () => {
    const { app, handlers } = makeFakeApp(true);
    const getMainWindow = vi.fn();
    const quit = vi.fn();

    const result = acquireSingleInstanceLock({ app, getMainWindow, quit });

    expect(result.acquired).toBe(true);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(handlers.has('second-instance')).toBe(true);
    expect(quit).not.toHaveBeenCalled();
  });

  it('returns acquired=false and quits when lock is denied', () => {
    const { app, handlers } = makeFakeApp(false);
    const getMainWindow = vi.fn();
    const quit = vi.fn();

    const result = acquireSingleInstanceLock({ app, getMainWindow, quit });

    expect(result.acquired).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(handlers.has('second-instance')).toBe(false);
    expect(getMainWindow).not.toHaveBeenCalled();
  });

  it('second-instance event restores a minimized window and focuses it', () => {
    const { app, handlers } = makeFakeApp(true);
    const restore = vi.fn();
    const focus = vi.fn();
    const isMinimized = vi.fn().mockReturnValue(true);
    const isDestroyed = vi.fn().mockReturnValue(false);
    const win = { restore, focus, isMinimized, isDestroyed };
    const getMainWindow = vi.fn().mockReturnValue(win);
    const quit = vi.fn();

    acquireSingleInstanceLock({ app, getMainWindow, quit });
    const secondInstanceHandler = handlers.get('second-instance');
    expect(secondInstanceHandler).toBeDefined();
    secondInstanceHandler!();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('second-instance event focuses a non-minimized window without restore', () => {
    const { app, handlers } = makeFakeApp(true);
    const restore = vi.fn();
    const focus = vi.fn();
    const isMinimized = vi.fn().mockReturnValue(false);
    const isDestroyed = vi.fn().mockReturnValue(false);
    const win = { restore, focus, isMinimized, isDestroyed };
    const getMainWindow = vi.fn().mockReturnValue(win);
    const quit = vi.fn();

    acquireSingleInstanceLock({ app, getMainWindow, quit });
    const secondInstanceHandler = handlers.get('second-instance');
    secondInstanceHandler!();

    expect(restore).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('second-instance event is a no-op when main window is destroyed', () => {
    const { app, handlers } = makeFakeApp(true);
    const restore = vi.fn();
    const focus = vi.fn();
    const isMinimized = vi.fn().mockReturnValue(false);
    const isDestroyed = vi.fn().mockReturnValue(true);
    const win = { restore, focus, isMinimized, isDestroyed };
    const getMainWindow = vi.fn().mockReturnValue(win);
    const quit = vi.fn();

    acquireSingleInstanceLock({ app, getMainWindow, quit });
    const secondInstanceHandler = handlers.get('second-instance');
    expect(() => secondInstanceHandler!()).not.toThrow();
    // destroyed window: restore/focus skipped, no crash
    expect(restore).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('second-instance event is a no-op when main window is null', () => {
    const { app, handlers } = makeFakeApp(true);
    const getMainWindow = vi.fn().mockReturnValue(null);
    const quit = vi.fn();

    acquireSingleInstanceLock({ app, getMainWindow, quit });
    const secondInstanceHandler = handlers.get('second-instance');
    expect(() => secondInstanceHandler!()).not.toThrow();
  });
});
