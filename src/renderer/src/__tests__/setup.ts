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
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];

  private _callback: IntersectionObserverCallback | null = null;
  private _currentEntry: IntersectionObserverEntry | null = null;

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    this._callback = callback;
  }

  observe(): void {
    if (this._callback && !this._currentEntry) {
      this._currentEntry = {
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRatio: 1,
        intersectionRect: {} as DOMRectReadOnly,
        isIntersecting: true,
        rootBounds: null,
        target: {} as Element,
        time: Date.now(),
      };
      // Schedule callback after observing so tests can set up their assertions
      setTimeout(() => {
        if (this._callback && this._currentEntry) {
          this._callback([this._currentEntry], this);
        }
      }, 0);
    }
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
