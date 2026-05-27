import { useRef, useEffect, useState } from 'react';

export interface UseIntersectionObserverOptions {
  /**
   * Margin around the root (viewport) to trigger visibility early.
   * '100px' preloads slightly before entering viewport.
   */
  rootMargin?: string;
  /**
   * Fraction of the element that must be visible (0 to 1).
   */
  threshold?: number | number[];
  /**
   * Whether to disconnect after first intersection.
   * @default true
   */
  triggerOnce?: boolean;
}

export interface UseIntersectionObserverReturn<T extends HTMLElement = HTMLElement> {
  ref: React.RefObject<T | null>;
  isIntersecting: boolean;
  /** The IntersectionObserver instance — useful for manual disconnect. */
  observer: IntersectionObserver | null;
}

/**
 * Custom hook that uses IntersectionObserver to detect when an element
 * enters the viewport.
 *
 * @example
 * const { ref, isIntersecting } = useIntersectionObserver();
 * return <div ref={ref}>{isIntersecting ? 'Visible' : 'Hidden'}</div>;
 */
export function useIntersectionObserver<T extends HTMLElement = HTMLElement>(
  options: UseIntersectionObserverOptions = {},
): UseIntersectionObserverReturn<T> {
  const { rootMargin = '100px', threshold = 0, triggerOnce = true } = options;

  const ref = useRef<T | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [observer, setObserver] = useState<IntersectionObserver | null>(null);

  // Keep a stable reference to the state setter for the effect
  const setIsIntersectingRef = useRef(setIsIntersecting);
  setIsIntersectingRef.current = setIsIntersecting;
  const triggerOnceRef = useRef(triggerOnce);
  triggerOnceRef.current = triggerOnce;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observerInstance = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        setIsIntersectingRef.current(entry.isIntersecting);

        if (triggerOnceRef.current && entry.isIntersecting) {
          observerInstance.disconnect();
        }
      },
      { rootMargin, threshold },
    );

    observerInstance.observe(element);
    setObserver(observerInstance);

    return () => {
      observerInstance.disconnect();
    };
  }, [rootMargin, threshold]); // Re-create observer only when options change

  return { ref: ref as React.RefObject<T | null>, isIntersecting, observer };
}
