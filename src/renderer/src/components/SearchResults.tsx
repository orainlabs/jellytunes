import { Loader2, User, Disc, ListMusic } from 'lucide-react'
import type { Artist, Album, Playlist } from '../appTypes'

interface SearchResultsProps {
  query: string
  isSearching: boolean
  results: { artists: Artist[]; albums: Album[]; playlists: Playlist[] } | null
  selectedTracks: Set<string>
  onToggle: (id: string) => void
}

export function SearchResults({ query, isSearching, results, selectedTracks, onToggle }: SearchResultsProps): JSX.Element {
  return (
    <div data-testid="search-results" className="grid gap-4 mb-2">
      {isSearching && (
        <div className="flex items-center gap-2 text-zinc-500 text-sm px-1 py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Searching...
        </div>
      )}
      {!isSearching && results && (
        <>
          {results.artists.map(artist => (
            <div key={artist.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
              <input type="checkbox" checked={selectedTracks.has(artist.Id)} onChange={() => onToggle(artist.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
              <User className="w-5 h-5 text-zinc-500 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-medium">{artist.Name}</h3>
                <p className="text-xs text-zinc-500">Artist</p>
              </div>
            </div>
          ))}
          {results.albums.map(album => (
            <div key={album.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
              <input type="checkbox" checked={selectedTracks.has(album.Id)} onChange={() => onToggle(album.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
              <Disc className="w-5 h-5 text-zinc-500 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-medium">{album.Name}</h3>
                <p className="text-xs text-zinc-500">Album{album.AlbumArtist ? ` · ${album.AlbumArtist}` : ''}</p>
              </div>
            </div>
          ))}
          {results.playlists.map(pl => (
            <div key={pl.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
              <input type="checkbox" checked={selectedTracks.has(pl.Id)} onChange={() => onToggle(pl.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
              <ListMusic className="w-5 h-5 text-zinc-500 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-medium">{pl.Name}</h3>
                <p className="text-xs text-zinc-500">Playlist{pl.ChildCount != null ? ` · ${pl.ChildCount} songs` : ''}</p>
              </div>
            </div>
          ))}
          {results.artists.length === 0 && results.albums.length === 0 && results.playlists.length === 0 && (
            <p className="text-zinc-500 text-sm px-1 py-2">No results for "{query}"</p>
          )}
        </>
      )}
    </div>
  )
}
