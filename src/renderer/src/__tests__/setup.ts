import '@testing-library/jest-dom';
import { afterEach } from 'vitest';

// Conditionally load renderer-specific setup only when jsdom is active
// This avoids crashes when running with node environment
if (typeof window !== 'undefined') {
  import('@testing-library/react').then(({ cleanup }) => {
    afterEach(() => cleanup());
  });
}

// Mock IntersectionObserver for jsdom
class MockIntersectionObserver implements IntersectionObserver {
  private _rootMargin: string;
  private _thresholds: ReadonlyArray<number>;
  readonly root: Element | null = null;
  get rootMargin(): string {
    return this._rootMargin;
  }
  get thresholds(): ReadonlyArray<number> {
    return this._thresholds;
  }

  private _callback: IntersectionObserverCallback | null = null;
  private _currentEntry: IntersectionObserverEntry | null = null;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this._callback = callback;
    this._rootMargin = options?.rootMargin ?? '';
    const threshold = options?.threshold;
    if (typeof threshold === 'number') {
      this._thresholds = [threshold];
    } else if (Array.isArray(threshold)) {
      this._thresholds = threshold;
    } else {
      this._thresholds = [];
    }
  }

  observe(): void {
    // Do not auto-trigger on observe — tests control state via setIntersecting()
  }

  unobserve(): void {}

  disconnect(): void {
    this._callback = null;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return this._currentEntry ? [this._currentEntry] : [];
  }

  // For testing: set whether the element is intersecting
  setIntersecting(value: boolean): void {
    if (!this._callback) return;
    this._currentEntry = {
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: value ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      isIntersecting: value,
      rootBounds: null,
      target: {} as Element,
      time: Date.now(),
    };
    // Synchronously call the callback for test predictability
    this._callback([this._currentEntry], this);
  }
}

// Expose mock globally for test customization
const mockObserverInstances: MockIntersectionObserver[] = [];

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'IntersectionObserver', {
    value: function createMockIntersectionObserver(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      const instance = new MockIntersectionObserver(callback, options);
      mockObserverInstances.push(instance);
      return instance;
    } as unknown as typeof IntersectionObserver,
    writable: true,
    configurable: true,
  });
}

// Export for tests that need to control the mock
export { MockIntersectionObserver, mockObserverInstances };
