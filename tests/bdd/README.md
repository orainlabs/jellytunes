# Jellysync - Tests BDD

Suite de tests BDD (Behavior-Driven Development) para Jellysync usando Cucumber + Playwright.

## Estructura

```
tests/bdd/
├── features/           # Archivos .feature en Gherkin
│   ├── authentication.feature
│   ├── library-navigation.feature
│   ├── synchronization.feature
│   ├── filters-search.feature
│   └── error-handling.feature
├── steps/              # Step definitions en TypeScript
│   ├── authentication.steps.ts
│   ├── library-navigation.steps.ts
│   ├── synchronization.steps.ts
│   ├── filters-search.steps.ts
│   └── error-handling.steps.ts
├── support/            # Configuración y utilidades
│   ├── app-launcher.ts
│   ├── hooks.ts
│   └── world.ts
├── reports/            # Reportes generados (gitignored)
├── screenshots/        # Screenshots de errores (gitignored)
├── cucumber.js         # Configuración de Cucumber
└── playwright.config.ts # Configuración de Playwright
```

## Instalación de Dependencias

```bash
# Instalar Playwright y Cucumber
pnpm add -D @cucumber/cucumber @cucumber/pretty-formatter playwright @playwright/test ts-node

# Instalar browsers de Playwright
pnpm exec playwright install chromium
```

## Ejecución de Tests

### Ejecutar todos los tests BDD

```bash
pnpm test:bdd
```

### Ejecutar un feature específico

```bash
pnpm test:bdd -- features/authentication.feature
```

### Modo desarrollo (con UI visible)

```bash
pnpm test:bdd:dev
```

### Modo CI (headless)

```bash
pnpm test:bdd:ci
```

### Ejecutar con tags específicos

```bash
# Solo tests de autenticación
pnpm test:bdd -- --tags "@authentication"

# Excluir tests lentos
pnpm test:bdd -- --tags "not @slow"
```

## Features Cubiertas

| Feature | Escenarios | Estado |
|---------|-----------|--------|
| Autenticación Jellyfin | 5 | ✅ Listo |
| Navegación de Biblioteca | 7 | ✅ Listo |
| Sincronización | 7 | ✅ Listo |
| Filtros y Búsqueda | 9 | ✅ Listo |
| Manejo de Errores | 8 | ✅ Listo |

## Data-TestIDs Requeridos

Para que los tests funcionen, la aplicación debe tener estos `data-testid`:

### Autenticación
- `auth-screen` - Pantalla de login
- `server-url-input` - Input de URL del servidor
- `api-key-input` - Input de API key
- `connect-button` - Botón de conectar
- `error-message` - Mensaje de error
- `library-screen` - Pantalla de biblioteca (post-login)

### Biblioteca
- `library-screen` - Pantalla principal
- `library-content` - Contenido de la biblioteca
- `tab-artists`, `tab-albums`, `tab-playlists` - Pestañas
- `artists-list`, `albums-list`, `playlists-list` - Listas
- `artist-item`, `album-item`, `playlist-item` - Items
- `artist-name`, `album-cover`, `track-item` - Elementos

### Sincronización
- `usb-device-connected` - Indicador de USB conectado
- `device-name` - Nombre del dispositivo
- `available-space` - Espacio disponible
- `sync-button` - Botón de sincronizar
- `sync-progress` - Barra de progreso
- `selected-count` - Contador de selección

### Búsqueda y Filtros
- `search-input` - Campo de búsqueda
- `search-results` - Resultados de búsqueda
- `filter-button` - Botón de filtros
- `active-filter` - Filtros activos

## Añadir Nuevos Tests

1. Crear archivo `.feature` en `features/`
2. Crear archivo `.steps.ts` en `steps/`
3. Ejecutar tests: `pnpm test:bdd`

## Reportes

Después de ejecutar tests, los reportes HTML están disponibles en:

```
tests/bdd/reports/cucumber-report.html
```

## Notas para Desarrolladores

- Los tests requieren que la app esté compilada: `pnpm build`
- Los screenshots de errores se guardan en `tests/bdd/screenshots/`
- Usar `@slow` tag para tests que toman más de 10 segundos
- Los tests corren en modo headless por defecto

## Troubleshooting

### Error: "Electron app no se inicia"
Verificar que la app esté compilada: `pnpm build`

### Error: "Timeout al esperar selector"
Verificar que los `data-testid` estén correctamente implementados en la app

### Tests intermitentemente fallan
Aumentar timeouts en `playwright.config.ts` o usar `@slow` tag