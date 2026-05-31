import type { Artist, Album, Playlist, UsbDevice } from '../appTypes';

export const mockArtists: Artist[] = [
  {
    Id: 'artist-1',
    Name: 'The Beatles',
    AlbumCount: 13,
    ImageTags: {},
  },
  {
    Id: 'artist-2',
    Name: 'Pink Floyd',
    AlbumCount: 15,
    ImageTags: {},
  },
  {
    Id: 'artist-3',
    Name: 'Radiohead',
    AlbumCount: 9,
    ImageTags: {},
  },
];

export const mockAlbums: Album[] = [
  {
    Id: 'album-1',
    Name: 'Abbey Road',
    AlbumArtist: 'The Beatles',
    ProductionYear: 1969,
    ImageTags: {},
  },
  {
    Id: 'album-2',
    Name: 'The Dark Side of the Moon',
    AlbumArtist: 'Pink Floyd',
    ProductionYear: 1973,
    ImageTags: {},
  },
  {
    Id: 'album-3',
    Name: 'OK Computer',
    AlbumArtist: 'Radiohead',
    ProductionYear: 1997,
    ImageTags: {},
  },
];

export const mockPlaylists: Playlist[] = [
  {
    Id: 'playlist-1',
    Name: 'My Favorites',
    ChildCount: 42,
    ImageTags: {},
  },
  {
    Id: 'playlist-2',
    Name: 'Road Trip',
    ChildCount: 28,
    ImageTags: {},
  },
];

export const mockSyncedItems: Array<{
  id: string;
  name: string;
  type: 'artist' | 'album' | 'albumArtist' | 'playlist';
}> = [
  { id: 'artist-1', name: 'The Beatles', type: 'artist' },
  { id: 'album-2', name: 'The Dark Side of the Moon', type: 'album' },
];

export const mockUsbDevice: UsbDevice = {
  device: '/dev/disk2s1',
  displayName: 'SANDISK CRUZER',
  size: 64_000_000_000,
  mountpoints: [{ path: '/Volumes/MUSIC_USB' }],
  isRemovable: true,
  vendorName: 'SanDisk',
  serialNumber: 'ABC123456',
};
