# Implementación de Data-TestIDs para Tests BDD

Para que los tests BDD funcionen correctamente, la aplicación React debe implementar los siguientes atributos `data-testid`:

## Pantalla de Autenticación

```tsx
<div data-testid="auth-screen">
  <input data-testid="server-url-input" type="url" />
  <input data-testid="api-key-input" type="password" />
  <button data-testid="connect-button">Conectar</button>
  {error && <div data-testid="error-message">{error}</div>}
</div>
```

## Pantalla de Biblioteca

```tsx
<div data-testid="library-screen">
  <div data-testid="library-content">
    <button data-testid="tab-artists">Artistas</button>
    <button data-testid="tab-albums">Álbumes</button>
    <button data-testid="tab-playlists">Playlists</button>
    
    <div data-testid="artists-list">
      {artists.map(artist => (
        <div key={artist.id} data-testid="artist-item">
          <span data-testid="artist-name">{artist.name}</span>
          <span data-testid="album-count">{artist.albumCount}</span>
        </div>
      ))}
    </div>
    
    <div data-testid="albums-list">
      {albums.map(album => (
        <div key={album.id} data-testid="album-item">
          <img data-testid="album-cover" src={album.coverUrl} />
        </div>
      ))}
    </div>
  </div>
</div>
```

## Lista de Canciones

```tsx
<div data-testid="tracks-list">
  {tracks.map(track => (
    <div key={track.id} data-testid="track-item">
      <input data-testid="track-checkbox" type="checkbox" />
      <span data-testid="track-number">{track.number}</span>
      <span data-testid="track-title">{track.title}</span>
      <span data-testid="track-duration">{track.duration}</span>
    </div>
  ))}
</div>
```

## Sincronización y Dispositivo USB

```tsx
{deviceConnected && (
  <div data-testid="usb-device-connected">
    <span data-testid="device-name">{device.name}</span>
    <span data-testid="available-space">{formatBytes(device.space)}</span>
  </div>
)}

<button data-testid="sync-button" disabled={!deviceConnected}>
  Sincronizar
</button>

<span data-testid="selected-count">{selectedCount}</span>
<span data-testid="required-space">{formatBytes(requiredSpace)}</span>

{syncing && (
  <div data-testid="sync-progress">
    <progress data-testid="sync-progress-bar" value={progress} max={100} />
  </div>
)}

{syncComplete && <div data-testid="sync-complete">Sincronización completada</div>}
{syncCancelled && <div data-testid="sync-cancelled">Sincronización cancelada</div>}
```

## Búsqueda y Filtros

```tsx
<input data-testid="search-input" type="search" />

<button data-testid="filter-button">Filtros</button>

{activeFilters.map(filter => (
  <span key={filter.id} data-testid="active-filter">{filter.label}</span>
))}

<div data-testid="search-results">
  {results.map(result => (
    <div key={result.id} data-testid="search-item">
      <span data-testid="result-type">{result.type}</span>
    </div>
  ))}
</div>

<button data-testid="clear-filters-button">Limpiar filtros</button>
```

## Breadcrumbs y Navegación

```tsx
<nav data-testid="breadcrumb">
  {breadcrumbs.map((crumb, index) => (
    <span key={index}>{crumb.label}</span>
  ))}
</nav>
```

## Estados Offline y Errores

```tsx
{isOffline && (
  <div data-testid="offline-status">Modo offline</div>
)}

<div data-testid="cached-content">
  {/* Contenido en caché */}
</div>

{error && (
  <div data-testid="generic-error-message">
    {userFriendlyMessage}
    <button onClick={showTechnicalDetails}>Ver detalles técnicos</button>
  </div>
)}

{technicalDetails && (
  <pre data-testid="technical-details">{JSON.stringify(details, null, 2)}</pre>
)}
```

## Notas

1. Todos los `data-testid` deben ser únicos dentro de su contexto
2. Los elementos dinámicos (listas) deben usar `data-testid` consistentes
3. Los estados condicionales deben tener `data-testid` tanto en true como false cuando aplique
4. Preferir `data-testid` sobre clases CSS para testing
5. No eliminar `data-testid` en builds de producción (no afectan el bundle significativamente)