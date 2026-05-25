// src/renderer/src/components/LibraryItem.test.tsx

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LibraryItem } from './LibraryItem';

describe('LibraryItem playlist subtitle', () => {
  const baseProps = {
    wasSynced: false,
    outOfSync: false,
    onToggle: () => {},
    serverUrl: undefined,
  };

  it('hides subtitle when playlist has ChildCount of 0 and no runtime', () => {
    render(
      <LibraryItem
        item={{ Id: 'p1', Name: 'Empty Playlist', ChildCount: 0 } as const}
        type="playlist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    // Should be empty (no "0 tracks" shown)
    expect(subtitle?.textContent?.trim()).toBe('');
  });

  it('shows runtime when playlist has ChildCount of 0 but has runtime', () => {
    // 1h = 36000000000 ticks
    render(
      <LibraryItem
        item={{ Id: 'p2', Name: 'Playlist 2', ChildCount: 0, RunTimeTicks: 36000000000 } as const}
        type="playlist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent).toBe('1h');
  });

  it('shows track count and runtime when playlist has ChildCount > 0', () => {
    // 2h = 72000000000 ticks, 15 tracks
    render(
      <LibraryItem
        item={{ Id: 'p3', Name: 'Playlist 3', ChildCount: 15, RunTimeTicks: 72000000000 } as const}
        type="playlist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent).toContain('15 tracks');
    expect(subtitle?.textContent).toContain('2h');
  });

  it('shows singular "track" for ChildCount of 1', () => {
    render(
      <LibraryItem
        item={{ Id: 'p4', Name: 'Playlist 4', ChildCount: 1 } as const}
        type="playlist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent).toContain('1 track'); // singular
  });
});

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

describe('LibraryItem search artist (ChildCount missing/undefined)', () => {
  const baseProps = {
    wasSynced: false,
    outOfSync: false,
    onToggle: () => {},
    serverUrl: undefined,
  };

  it('hides subtitle when artist from search has undefined ChildCount and no runtime', () => {
    // Search results may not return ChildCount — must not show "undefined"
    render(
      <LibraryItem
        item={{ Id: 's1', Name: 'Search Artist' } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent?.trim()).toBe('');
    expect(subtitle?.textContent).not.toContain('undefined');
  });

  it('shows only runtime when artist from search has undefined ChildCount but has runtime', () => {
    // 90 minutes (54000000000 ticks) formats as "1h 30m" since it exceeds 60 min
    render(
      <LibraryItem
        item={{ Id: 's2', Name: 'Search Artist 2', RunTimeTicks: 54000000000 } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const subtitle = screen.getByTestId('library-item').querySelector('.text-caption');
    expect(subtitle?.textContent).toBe('1h 30m');
    expect(subtitle?.textContent).not.toContain('undefined');
    expect(subtitle?.textContent).not.toContain('album');
  });

  it('does NOT show "undefined" in subtitle when all fields are missing', () => {
    render(
      <LibraryItem
        item={{ Id: 's3', Name: 'Minimal Artist' } as const}
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );
    const item = screen.getByTestId('library-item');
    const itemHtml = item.innerHTML;
    expect(itemHtml).not.toContain('undefined');
  });
});
