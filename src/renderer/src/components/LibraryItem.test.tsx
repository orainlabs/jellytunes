// src/renderer/src/components/LibraryItem.test.tsx

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LibraryItem } from './LibraryItem';

describe('LibraryItem artist subtitle', () => {
  const baseProps = {
    wasSynced: false,
    outOfSync: false,
    onToggle: () => {},
    serverUrl: undefined,
  };

  it('renders no subtitle when artist has no RunTimeTicks and no ChildCount', () => {
    render(
      <LibraryItem
        item={{ Id: '1', Name: 'Artist 1' } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    // Subtitle should be null/undefined - no text rendered
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent?.trim()).toBe('');
  });

  it('renders only runtime when artist has RunTimeTicks but no ChildCount', () => {
    render(
      <LibraryItem
        item={{ Id: '2', Name: 'Artist 2', RunTimeTicks: 36000000000 } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    // Should show formatted runtime, NOT album count
    expect(subtitle?.textContent).not.toContain('album');
    expect(subtitle?.textContent).toContain('1h');
  });

  it('does NOT display "undefined" when artist ChildCount is undefined', () => {
    render(
      <LibraryItem
        item={
          { Id: '3', Name: 'Artist 3', ChildCount: undefined, RunTimeTicks: 18000000000 } as const
        }
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    // The bug was: "undefined albums · 30m" — this must never happen
    expect(subtitle?.textContent).not.toContain('undefined');
    expect(subtitle?.textContent).toBe('30m');
  });

  it('shows only runtime when ChildCount is explicitly null', () => {
    render(
      <LibraryItem
        item={
          {
            Id: '4',
            Name: 'Artist 4',
            ChildCount: null as unknown as undefined,
            RunTimeTicks: 7200000000,
          } as const
        }
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent).not.toContain('album');
    expect(subtitle?.textContent).toBe('12m');
  });

  it('does NOT display album count even if ChildCount has a valid value', () => {
    // This test documents that album count should NOT appear per AC
    render(
      <LibraryItem
        item={{ Id: '5', Name: 'Artist 5', ChildCount: 5, RunTimeTicks: 36000000000 } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    // AC: album count should NOT appear regardless of value
    expect(subtitle?.textContent).not.toContain('album');
    expect(subtitle?.textContent).not.toContain('5');
    expect(subtitle?.textContent).toBe('1h');
  });
});
