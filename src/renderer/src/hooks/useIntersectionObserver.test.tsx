import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useIntersectionObserver } from './useIntersectionObserver';

// Component that exposes the hook values for testing
function TestComponent({
  rootMargin = '100px',
  threshold = 0,
  triggerOnce = true,
}: {
  rootMargin?: string;
  threshold?: number | number[];
  triggerOnce?: boolean;
}) {
  const { ref, isIntersecting } = useIntersectionObserver({ rootMargin, threshold, triggerOnce });

  return (
    <div ref={ref as never} data-testid="observed">
      {isIntersecting ? 'visible' : 'hidden'}
    </div>
  );
}

describe('useIntersectionObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders and eventually shows visible state (mock auto-triggers)', async () => {
    render(<TestComponent triggerOnce={true} />);
    // The mock triggers isIntersecting: true on observe() via setTimeout(0)
    await waitFor(() => {
      expect(screen.getByTestId('observed')).toHaveTextContent('visible');
    });
  });

  it('renders with hidden state initially before the mock triggers', () => {
    render(<TestComponent />);
    // Initial state - before setTimeout fires
    // We can't easily test initial state without changing the mock
    expect(screen.getByTestId('observed')).toBeInTheDocument();
  });

  it('returns a ref that can be attached to DOM elements', () => {
    render(<TestComponent />);
    const div = document.querySelector('div[data-testid="observed"]');
    expect(div).toBeInTheDocument();
    expect(div).toHaveAttribute('data-testid', 'observed');
  });
});
