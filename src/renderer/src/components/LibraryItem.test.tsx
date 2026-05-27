import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { LibraryItem } from './LibraryItem';
import { mockObserverInstances } from '../__tests__/setup';

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

  it('does NOT show album count even if ChildCount has a valid value', () => {
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

describe('LibraryItem lazy loading with IntersectionObserver', () => {
  const baseProps = {
    wasSynced: false,
    outOfSync: false,
    onToggle: () => {},
    serverUrl: 'https://jellyfin.example.com',
  };

  it('shows placeholder icon when item is not in viewport', () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'album-1',
            Name: 'Test Album',
            ImageTags: { Primary: 'abc123' },
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    // Explicitly set "not intersecting" so test is deterministic
    const mock = mockObserverInstances[0];
    act(() => {
      mock.setIntersecting(false);
    });

    // Should show placeholder (div with icon), not the img element with src
    const placeholder = screen
      .getByTestId('library-item')
      .querySelector('.bg-surface_container_low');
    expect(placeholder?.tagName.toLowerCase()).toBe('div');
    expect(placeholder?.querySelector('img')).toBeNull();
  });

  it('renders img with src when item enters viewport', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'album-2',
            Name: 'Test Album 2',
            ImageTags: { Primary: 'xyz789' },
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    // Trigger visibility if mock is available
    if (mockObserverInstances.length > 0) {
      const mock = mockObserverInstances[mockObserverInstances.length - 1];
      act(() => {
        mock.setIntersecting(true);
      });
    }

    // Wait for React to process the state update
    await waitFor(
      () => {
        const img = screen.getByTestId('library-item').querySelector('img');
        expect(img).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Verify the img has the correct src attributes
    const img = screen.getByTestId('library-item').querySelector('img');
    expect(img?.getAttribute('src')).toContain('https://jellyfin.example.com');
    expect(img?.getAttribute('src')).toContain('/Items/album-2/Images/Primary');
    expect(img?.getAttribute('src')).toContain('xyz789');
    expect(img?.getAttribute('src')).toContain('fillHeight=40');
    expect(img?.getAttribute('src')).toContain('fillWidth=40');
  });

  it('onError prop still works → fallback to icon when image fails', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'album-error',
            Name: 'Album With Error',
            ImageTags: { Primary: 'broken-tag' },
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    // Trigger visibility explicitly
    const mock = mockObserverInstances[mockObserverInstances.length - 1];
    act(() => {
      mock.setIntersecting(true);
    });

    // Simulate image error
    const img = screen.getByTestId('library-item').querySelector('img')!;
    act(() => {
      img.dispatchEvent(new Event('error', { bubbles: true }));
    });

    // Should fall back to placeholder icon
    await waitFor(() => {
      const placeholder = screen
        .getByTestId('library-item')
        .querySelector('.bg-surface_container_low');
      expect(placeholder?.tagName.toLowerCase()).toBe('div');
      expect(placeholder?.querySelector('img')).toBeNull();
    });
  });

  it('renders rounded-full for artist type when visible', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'artist-1',
            Name: 'Test Artist',
            ImageTags: { Primary: 'artist-tag' },
          } as const
        }
        type="artist"
        isSelected={false}
        {...baseProps}
      />,
    );

    const mock = mockObserverInstances[mockObserverInstances.length - 1];
    act(() => {
      mock.setIntersecting(true);
    });

    await waitFor(
      () => {
        const img = screen.getByTestId('library-item').querySelector('img');
        expect(img).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    const img = screen.getByTestId('library-item').querySelector('img');
    expect(img?.className).toContain('rounded-full');
  });

  it('renders rounded (not rounded-full) for album type when visible', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'album-3',
            Name: 'Test Album 3',
            ImageTags: { Primary: 'album-tag' },
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    const mock = mockObserverInstances[mockObserverInstances.length - 1];
    act(() => {
      mock.setIntersecting(true);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('library-item').querySelector('img')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    const img = screen.getByTestId('library-item').querySelector('img');
    expect(img?.className).toContain('rounded');
    expect(img?.className).not.toContain('rounded-full');
  });

  it('renders rounded (not rounded-full) for playlist type when visible', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'playlist-1',
            Name: 'Test Playlist',
            ImageTags: { Primary: 'playlist-tag' },
          } as const
        }
        type="playlist"
        isSelected={false}
        {...baseProps}
      />,
    );

    const mock = mockObserverInstances[mockObserverInstances.length - 1];
    act(() => {
      mock.setIntersecting(true);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('library-item').querySelector('img')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    const img = screen.getByTestId('library-item').querySelector('img');
    expect(img?.className).toContain('rounded');
    expect(img?.className).not.toContain('rounded-full');
  });

  it('shows placeholder when there is no serverUrl', () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'item-no-url',
            Name: 'Item Without Server',
            ImageTags: { Primary: 'some-tag' },
          } as const
        }
        type="album"
        isSelected={false}
        wasSynced={false}
        outOfSync={false}
        onToggle={() => {}}
        serverUrl={undefined}
      />,
    );

    // Should show placeholder, not img with broken src
    const placeholder = screen
      .getByTestId('library-item')
      .querySelector('.bg-surface_container_low');
    expect(placeholder?.tagName.toLowerCase()).toBe('div');
    expect(screen.getByTestId('library-item').querySelector('img')).toBeNull();
  });

  it('shows placeholder when there is no ImageTags', () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'item-no-tag',
            Name: 'Item Without Image Tag',
            ImageTags: undefined,
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    // Should show placeholder, not img with broken src
    const placeholder = screen
      .getByTestId('library-item')
      .querySelector('.bg-surface_container_low');
    expect(placeholder?.tagName.toLowerCase()).toBe('div');
    expect(screen.getByTestId('library-item').querySelector('img')).toBeNull();
  });

  it('loads image and stays visible after onLoad (full cycle test)', async () => {
    render(
      <LibraryItem
        item={
          {
            Id: 'album-cycle',
            Name: 'Test Album Cycle',
            ImageTags: { Primary: 'cycle-tag' },
          } as const
        }
        type="album"
        isSelected={false}
        {...baseProps}
      />,
    );

    // Wait for the effect to run (observer creation)
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mock = mockObserverInstances[mockObserverInstances.length - 1];

    // Phase 1: Element enters viewport but image hasn't loaded yet
    act(() => {
      mock.setIntersecting(true);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('library-item').querySelector('img')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Phase 2: Simulate onLoad event (image finishes loading)
    const img = screen.getByTestId('library-item').querySelector('img')!;
    act(() => {
      img.dispatchEvent(new Event('load', { bubbles: true }));
    });

    // Phase 3: Image should STILL be visible (not disappear after onLoad)
    await waitFor(
      () => {
        const loadedImg = screen.getByTestId('library-item').querySelector('img');
        expect(loadedImg).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Confirm the image stays - no img inside the placeholder
    const placeholder = screen
      .getByTestId('library-item')
      .querySelector('.bg-surface_container_low');
    expect(placeholder?.querySelector('img')).toBeUndefined();

    // Phase 4: Even if intersection state changes, image should remain
    act(() => {
      mock.setIntersecting(false);
    });

    // Image should still be visible (not replaced by placeholder)
    const stillVisibleImg = screen.getByTestId('library-item').querySelector('img');
    expect(stillVisibleImg).toBeInTheDocument();
  });
});
