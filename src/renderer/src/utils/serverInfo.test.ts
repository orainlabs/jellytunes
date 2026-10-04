/**
 * ORAIN-0770 — renderer-side helper tests for the [server-info]
 * emission wiring. Focuses on the pure `buildServerInfoReport`
 * function and the IPC forwarding; the version fetch is covered
 * here via mock fetch (no real network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServerInfoReport, reportServerInfo } from './serverInfo';
import type { LibraryStats } from '../appTypes';

// Lightweight stand-in for the preload `window.api`. We don't depend on
// the full Api type here because the test mocks just the surface
// serverInfo.ts uses — keeping it loose avoids fighting ambient
// declarations from `types.d.ts`.
type MockApi = {
  reportServerInfo: (p: unknown) => Promise<void>;
  logWarn?: (m: string) => void;
  logInfo?: (m: string) => void;
  logError?: (m: string) => void;
};

function setWindowApi(api: MockApi): void {
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
}

describe('buildServerInfoReport — ORAIN-0770', () => {
  it('maps counts and version into the payload shape', () => {
    const stats: LibraryStats = {
      ArtistCount: 100,
      AlbumArtistCount: 80,
      AlbumCount: 200,
      SongCount: 1500,
      PlaylistCount: 5,
      ItemCount: 1805,
    };
    const payload = buildServerInfoReport(stats, '10.9.0');
    expect(payload).toEqual({
      artists: 100,
      albumArtists: 80,
      albums: 200,
      audioTracks: 1500,
      jellyfinVersion: '10.9.0',
    });
  });

  it('returns null for null stats (AC3 graceful degradation)', () => {
    const payload = buildServerInfoReport(null, '10.9.0');
    expect(payload).toEqual({
      artists: null,
      albumArtists: null,
      albums: null,
      audioTracks: null,
      jellyfinVersion: '10.9.0',
    });
  });

  it('returns null for missing fields so the formatter renders unknown (AC3)', () => {
    // Legacy server that returns /Items/Counts without AlbumArtistCount.
    const partial = {
      ArtistCount: 50,
      AlbumCount: 100,
      SongCount: 600,
      PlaylistCount: 0,
      ItemCount: 750,
    } as LibraryStats;
    const payload = buildServerInfoReport(partial, null);
    expect(payload.artists).toBe(50);
    expect(payload.albums).toBe(100);
    expect(payload.audioTracks).toBe(600);
    expect(payload.albumArtists).toBe(null);
    expect(payload.jellyfinVersion).toBe(null);
  });
});

describe('reportServerInfo — IPC forwarding', () => {
  const originalFetch = global.fetch;
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as { api?: unknown }).api;
  });

  afterEach(() => {
    setWindowApi(originalApi as MockApi);
    global.fetch = originalFetch;
  });

  it('forwards the payload to window.api.reportServerInfo', async () => {
    let received: unknown = null;
    setWindowApi({
      reportServerInfo: async (p) => {
        received = p;
      },
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ Version: '10.10.0' }),
    })) as unknown as typeof fetch;

    await reportServerInfo({
      baseUrl: 'https://jf.example.com',
      stats: {
        ArtistCount: 10,
        AlbumArtistCount: 10,
        AlbumCount: 20,
        SongCount: 100,
        PlaylistCount: 1,
        ItemCount: 121,
      },
    });

    expect(received).toEqual({
      artists: 10,
      albumArtists: 10,
      albums: 20,
      audioTracks: 100,
      jellyfinVersion: '10.10.0',
    });
  });

  it('forwards null version when /System/Info/Public is unreachable (AC3)', async () => {
    let received: unknown = null;
    setWindowApi({
      reportServerInfo: async (p) => {
        received = p;
      },
    });
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await reportServerInfo({
      baseUrl: 'https://jf.example.com',
      stats: null,
    });

    expect(received).toEqual({
      artists: null,
      albumArtists: null,
      albums: null,
      audioTracks: null,
      jellyfinVersion: null,
    });
  });

  it('does not throw when the IPC fails (AC3 — must not break library load)', async () => {
    setWindowApi({
      reportServerInfo: async () => {
        throw new Error('IPC down');
      },
      // The renderer logger forwards to window.api.logWarn when AC3
      // catches the IPC failure. Provide a stub so the test does not
      // fail because of an unrelated mock surface.
      logWarn: () => undefined,
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ Version: '10.10.0' }),
    })) as unknown as typeof fetch;

    // No expectation — just check it resolves.
    await expect(
      reportServerInfo({
        baseUrl: 'https://jf.example.com',
        stats: null,
      }),
    ).resolves.toBeUndefined();
  });
});
