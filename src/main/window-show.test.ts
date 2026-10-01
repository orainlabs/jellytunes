import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  showWindowWithFallback,
  FINISH_LOAD_FALLBACK_MS,
  ABSOLUTE_FALLBACK_MS,
} from './window-show';

function makeFakeWindow() {
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  const win = {
    show: vi.fn(),
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    webContents: {
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
      }),
    },
  };
  return {
    win,
    emit: (event: string) => handlers.get(event)?.(),
    destroy: () => {
      destroyed = true;
    },
  };
}

function setup() {
  const fake = makeFakeWindow();
  const log = { info: vi.fn(), warn: vi.fn() };
  showWindowWithFallback({
    window: fake.win,
    timers: { setTimeout, clearTimeout },
    log,
  });
  return { ...fake, log };
}

describe('showWindowWithFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) shows once on ready-to-show before any fallback, without a warning', () => {
    const { win, emit, log } = setup();

    emit('did-finish-load');
    emit('ready-to-show');
    vi.advanceTimersByTime(ABSOLUTE_FALLBACK_MS * 2);

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('Window ready');
  });

  it('(b) shows after did-finish-load + 1500 ms when ready-to-show never fires', () => {
    const { win, emit, log } = setup();

    emit('did-finish-load');
    vi.advanceTimersByTime(FINISH_LOAD_FALLBACK_MS - 1);
    expect(win.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(FINISH_LOAD_FALLBACK_MS).toBe(1500);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Window shown via fallback: ready-to-show did not fire');
  });

  it('(c) keeps a single show() when ready-to-show arrives after the fallback', () => {
    const { win, emit, log } = setup();

    emit('did-finish-load');
    vi.advanceTimersByTime(FINISH_LOAD_FALLBACK_MS);
    emit('ready-to-show');
    vi.advanceTimersByTime(ABSOLUTE_FALLBACK_MS * 2);

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith('Window ready');
  });

  it('(d) does not show or throw when the window is destroyed before the timer fires', () => {
    const { win, emit, destroy, log } = setup();

    emit('did-finish-load');
    destroy();

    expect(() => vi.advanceTimersByTime(ABSOLUTE_FALLBACK_MS * 2)).not.toThrow();
    expect(win.show).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('(d2) ignores ready-to-show on a destroyed window', () => {
    const { win, emit, destroy } = setup();

    destroy();

    expect(() => emit('ready-to-show')).not.toThrow();
    expect(win.show).not.toHaveBeenCalled();
  });

  it('(e) arms a single timer when did-finish-load fires several times', () => {
    const fake = makeFakeWindow();
    const setTimeoutSpy = vi.fn(setTimeout);
    showWindowWithFallback({
      window: fake.win,
      timers: { setTimeout: setTimeoutSpy, clearTimeout },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    // 1 call for the absolute deadline armed at creation.
    const baseline = setTimeoutSpy.mock.calls.length;

    fake.emit('did-finish-load');
    fake.emit('did-finish-load');
    fake.emit('did-finish-load');
    vi.advanceTimersByTime(ABSOLUTE_FALLBACK_MS * 2);

    expect(setTimeoutSpy.mock.calls.length - baseline).toBe(1);
    expect(fake.win.show).toHaveBeenCalledTimes(1);
  });

  it('(f) shows at the 10 s deadline when neither event ever fires', () => {
    const { win, log } = setup();

    vi.advanceTimersByTime(ABSOLUTE_FALLBACK_MS - 1);
    expect(win.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(ABSOLUTE_FALLBACK_MS).toBe(10_000);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
