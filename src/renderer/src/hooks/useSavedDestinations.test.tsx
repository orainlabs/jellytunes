import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSavedDestinations } from './useSavedDestinations';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
};
vi.stubGlobal('localStorage', localStorageMock);

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.getItem.mockReturnValue('[]');
});

describe('useSavedDestinations', () => {
  it('updateDestination persists convertToMp3 and bitrate prefs', async () => {
    const { result } = renderHook(() => useSavedDestinations());

    // Add a destination
    act(() => {
      result.current.addDestination('/mnt/music');
    });
    // Get the destination from state (setState is synchronous after act)
    const dest = result.current.destinations.find((d) => d.path === '/mnt/music');
    expect(dest?.convertToMp3).toBeUndefined();
    expect(dest?.bitrate).toBeUndefined();

    // Update prefs
    await act(async () => {
      result.current.updateDestination(dest!.id, { convertToMp3: true, bitrate: '128k' as const });
    });

    // Verify localStorage was called with the patch (updateDestination call = index 1)
    const saved = JSON.parse(localStorageMock.setItem.mock.calls[1][1]);
    expect(saved[0].convertToMp3).toBe(true);
    expect(saved[0].bitrate).toBe('128k');
  });

  it('prefs survive across hook re-initializations (re-load from localStorage)', () => {
    // Pre-populate localStorage with a dest that has prefs
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify([
        { id: '999', name: 'USB', path: '/mnt/usb', convertToMp3: true, bitrate: '320k' },
      ]),
    );

    // First hook instance
    const { result: r1 } = renderHook(() => useSavedDestinations());
    const dest = r1.current.destinations.find((d) => d.path === '/mnt/usb');
    expect(dest?.convertToMp3).toBe(true);
    expect(dest?.bitrate).toBe('320k');
  });
});
