# PRD - Jellysync

**Product Owner:** NexusPO  
**Proyecto:** Jellysync - Sincronizador de música Jellyfin → dispositivos  
**Fecha:** 2026-03-12  
**Versión:** 1.0

---

## 🎯 Visión del Producto

**Jellysync** es una aplicación desktop para sincronizar bibliotecas de música desde Jellyfin a dispositivos reproductores MP3/FLAC (USB, SD, etc.).

**Propuesta de valor:** Gestión inteligente de música offline con filtros avanzados, conversión de formato automática y sincronización selectiva.

---

## 👥 Target Users

| Segmento | Descripción | Necesidad |
|----------|-------------|-----------|
| **Audiófilos** | Usuarios con FLAC en Jellyfin, reproductores portátiles | Llevar música HQ al coche/gimnasio |
| **Coleccionistas** | Grandes bibliotecas organizadas por artista/album | Sync selectivo por criterios |
| **Minimalistas** | Reproductores con poco espacio (8-32GB) | Optimizar espacio con filtros + conversión |

---

## 🎨 Stack Tecnológico

```
┌─────────────────────────────────────────────┐
│  FRONTEND: Electron + React + shadcn/ui    │
├─────────────────────────────────────────────┤
│  BACKEND: Node.js (main process)           │
│  ├── Jellyfin API Client                   │
│  ├── SQLite (better-sqlite3)               │
│  ├── node-usb (detección dispositivos)     │
│  ├── rsync/robocopy (sync archivos)        │
│  └── ffmpeg (transcoding)                  │
└─────────────────────────────────────────────┘
```

---

## 🎮 Funcionalidades Core

### Fase 1 - MVP (Sync básico)

| Funcionalidad | Descripción | Prioridad |
|---------------|-------------|-----------|
| **Conexión Jellyfin** | Login + listar biblioteca | 🔴 MUST |
| **Navegación** | Artistas, álbums, playlists | 🔴 MUST |
| **Selección** | Checkbox por items | 🔴 MUST |
| **Detección dispositivo** | USB plug & play | 🔴 MUST |
| **Sync básico** | Copiar archivos seleccionados | 🔴 MUST |
| **Estadísticas** | Canciones, álbumes, artistas, GB | 🟡 SHOULD |
| **Búsqueda** | Campo de búsqueda global | 🟡 SHOULD |

### Fase 2 - Polish (Sync inteligente)

| Funcionalidad | Descripción | Prioridad |
|---------------|-------------|-----------|
| **Conversión formato** | FLAC → MP3 (configurable bitrate) | 🔴 MUST |
| **Filtros avanzados** | Por género, año, rating | 🟡 SHOULD |
| **Smart sync** | Solo novedades desde último sync | 🟡 SHOULD |
| **Vista previa** | Ver qué se va a sincronizar antes | 🟡 SHOULD |
| **Múltiples dispositivos** | Perfiles por dispositivo | 🟢 COULD |

### Fase 3 - Advanced (Power user)

| Funcionalidad | Descripción | Prioridad |
|---------------|-------------|-----------|
| **Reglas automáticas** | "Siempre syncar favoritos" | 🟢 COULD |
| **Playlist inteligentes** | "Últimos 50 añadidos" | 🟢 COULD |
| **Sync bidireccional** | Ratings/playcounts → Jellyfin | 🟢 COULD |
| **Modo CLI** | Para automatizaciones | 🟢 COULD |

---

## 📐 UI/UX Design

### Pantalla Principal

```
┌─────────────────────────────────────────────────────┐
│  Jellysync                              [⚙️] [👤]  │
├─────────────────────────────────────────────────────┤
│  [🔍 Buscar...                      ]               │
├──────────────┬──────────────────────────────────────┤
│              │                                      │
│  📁 LIBRARY  │  👤 Artist Name                      │
│  ├── Artists │  ─────────────────                   │
│  ├── Albums  │                                      │
│  ├── Playlists│  💿 Album 1              [✓] 45:32 │
│              │     Track 1              [✓] 03:45 │
│  📱 DEVICES  │     Track 2              [✓] 04:12 │
│  ├── MiMP3 (8GB)                                     │
│     [32% libre]│  💿 Album 2              [ ] 38:15 │
│              │                                      │
│              │  [🔄 Sincronizar selección (2.3 GB)] │
├──────────────┴──────────────────────────────────────┤
│  📊 Stats: 1,234 canciones • 156 álbumes • 45.2 GB  │
└─────────────────────────────────────────────────────┘
```

### Flujo Sync

```
1. Conectar dispositivo USB
   → Detectado automáticamente
   → Mostrar espacio libre

2. Seleccionar contenido
   → Navegar árbol Jellyfin
   → Checkboxes + filtros
   → Vista previa "qué se copiará"

3. Configurar sync
   → ¿Convertir FLAC→MP3? [320kbps]
   → ¿Eliminar duplicados?
   → ¿Solo novedades?

4. Ejecutar
   → Barra progreso con archivo actual
   → Estimación tiempo restante
   → Cancelable

5. Resumen
   → X archivos copiados
   → Y GB transferidos
   → Z conversiones
```

---

## 🔧 Requisitos Técnicos

### Plataformas Soportadas

| OS | Versión | Prioridad |
|----|---------|-----------|
| macOS | 12+ (Intel/Apple Silicon) | 🔴 MUST |
| Windows | 10/11 | 🔴 MUST |
| Linux | Ubuntu 22.04+ | 🟡 SHOULD |

### Dependencias

- **Node.js** 18+
- **ffmpeg** (incluido o system)
- **rsync** (macOS/Linux) / **robocopy** (Windows)

### Performance Targets

- **Startup:** < 3 segundos
- **Navegación biblioteca:** < 500ms (con cache SQLite)
- **Sync:** Velocidad limitada por USB 2.0/3.0
- **UI:** 60fps, responsive

---

## 🗄️ SQLite Schema

```sql
-- Configuración
settings(key, value)

-- Cache Jellyfin
tracks(
  id PRIMARY KEY,
  title, artist, album, album_artist,
  genre, year, duration_ms, track_number,
  path, format, bitrate, size_bytes,
  jellyfin_id, last_updated
)

albums(
  id PRIMARY KEY,
  title, artist, year, genre,
  cover_url, track_count, duration_ms,
  jellyfin_id, last_updated
)

playlists(
  id PRIMARY KEY,
  name, description, track_count,
  jellyfin_id, last_updated
)

playlist_tracks(playlist_id, track_id, position)

-- Dispositivos
devices(
  id PRIMARY KEY,
  name, mount_point, total_bytes, free_bytes,
  last_sync_at, created_at
)

-- Historial sync
sync_history(
  id PRIMARY KEY,
  device_id, started_at, completed_at,
  tracks_synced, bytes_transferred,
  status -- pending, success, error
)
```

---

## 🚀 Roadmap

### Sprint 1 - Fase 1 (MVP)

**Duración:** 2 semanas  
**Objetivo:** Aplicación funcional con sync básico

**Entregables:**
1. Electron app + shadcn/ui setup
2. Conexión Jellyfin API + auth
3. Navegación artistas/albums/playlists
4. Selección con checkboxes
5. Detección USB con node-usb
6. Sync básico (copia archivos)
7. Estadísticas básicas

**Definition of Done:**
- [ ] App abre en macOS/Windows
- [ ] Login Jellyfin funciona
- [ ] Navegación fluida (< 1s)
- [ ] Sync copia archivos correctamente
- [ ] Txomin valida "se siente bien"

### Sprint 2 - Fase 2 (Polish)

**Duración:** 2 semanas  
**Objetivo:** Sync inteligente con conversiones

**Entregables:**
1. Conversión FLAC→MP3 (ffmpeg)
2. Filtros avanzados (género, año)
3. Smart sync (solo cambios)
4. Vista previa antes de sync
5. Manejo de errores robusto

### Sprint 3 - Fase 3 (Advanced)

**Duración:** 1 semana  
**Objetivo:** Power features

**Entregables:**
1. Reglas automáticas
2. Perfiles de dispositivo
3. Documentación usuario

---

## ✅ Criterios de Aceptación

### Must Have (MVP)

- [ ] App desktop funciona en macOS y Windows
- [ ] Login Jellyfin con token persistente
- [ ] Navegar biblioteca completa (< 2s por nivel)
- [ ] Seleccionar artistas/albums/playlists
- [ ] Detectar dispositivo USB automáticamente
- [ ] Copiar archivos seleccionados al dispositivo
- [ ] Mostrar estadísticas (canciones, GB)
- [ ] Búsqueda funciona

### Should Have (Fase 2)

- [ ] Conversión FLAC→MP3 configurable
- [ ] Filtros por género, año, rating
- [ ] Sync incremental (solo novedades)
- [ ] Vista previa antes de sync

### Could Have (Fase 3)

- [ ] Reglas automáticas
- [ ] Perfiles múltiples dispositivos
- [ ] Modo CLI

---

## 🚫 Out of Scope (v1.0)

- ❌ Reproducción de música
- ❌ Edición de metadatos
- ❌ Sync desde otras fuentes (Spotify, etc.)
- ❌ Cloud sync (Dropbox, etc.)
- ❌ Mobile app
- ❌ Web app (imposible por WebUSB)

---

## 👥 Equipo & Responsabilidades

| Rol | Agente | Responsabilidad |
|-----|--------|-----------------|
| **Product Owner** | NexusPO | PRD, backlog, priorización |
| **Coordinator** | BuboCord | Sprint planning |
| **Developer** | GizmoDev | Implementación Electron |
| **UI/UX** | ChispArt | Diseño interfaz |
| **QA** | TicoQA | Testing |
| **Validador Final** | Txomin | Aprobación producto |

---

## 📝 Notas Técnicas

### Detección USB

```javascript
// node-usb para hotplug
usb.on('attach', (device) => {
  if (isMassStorage(device)) {
    const mountPoint = getMountPoint(device);
    // Actualizar UI
  }
});
```

### Sync con rsync

```bash
rsync -av --progress --exclude="*.flac" 
  /source/ /destination/
```

### Conversión ffmpeg

```bash
ffmpeg -i input.flac 
  -codec:a libmp3lame -q:a 0 
  -metadata title="TITLE" 
  output.mp3
```

---

**Documento creado por:** NexusPO  
**Última actualización:** 2026-03-12  
**Stack validado por:** Rastreator (Electron + Node.js)
