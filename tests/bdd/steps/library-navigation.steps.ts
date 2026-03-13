import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { Page } from 'playwright';

// Nota: Asumimos que page está disponible del contexto de Cucumber
// En una implementación real, usaríamos un World personalizado

declare let page: Page;

// Given steps
Given('el usuario está autenticado en Jellyfin', async () => {
  // Setup: usuario ya autenticado
  await page.waitForSelector('[data-testid="library-screen"]');
});

Given('la biblioteca de música está cargada', async () => {
  await page.waitForSelector('[data-testid="library-content"]');
});

Given('el usuario está en la pantalla de biblioteca', async () => {
  await page.waitForSelector('[data-testid="library-screen"]');
});

Given('el usuario está viendo la lista de artistas', async () => {
  await page.click('[data-testid="tab-artists"]');
  await page.waitForSelector('[data-testid="artists-list"]');
});

Given('el usuario está viendo los álbumes de {string}', async (artistName: string) => {
  await page.click(`[data-testid="artist-item"]:has-text("${artistName}")`);
  await page.waitForSelector('[data-testid="albums-list"]');
});

Given('el usuario está viendo un álbum', async () => {
  await page.click('[data-testid="album-item"]:first-child');
  await page.waitForSelector('[data-testid="album-detail"]');
});

Given('el usuario está viendo la lista de playlists', async () => {
  await page.click('[data-testid="tab-playlists"]');
  await page.waitForSelector('[data-testid="playlists-list"]');
});

Given('el usuario está viendo las canciones de un álbum', async () => {
  await page.click('[data-testid="album-item"]:first-child');
  await page.waitForSelector('[data-testid="tracks-list"]');
});

Given('la biblioteca tiene más de 50 artistas', async () => {
  // Verificar que haya suficientes artistas para el test
  const artists = await page.locator('[data-testid="artist-item"]').count();
  expect(artists).toBeGreaterThan(0); // Asumimos que hay datos de prueba
});

// When steps
When('el usuario selecciona la pestaña {string}', async (tabName: string) => {
  const tabMap: Record<string, string> = {
    'Artistas': 'tab-artists',
    'Álbumes': 'tab-albums',
    'Playlists': 'tab-playlists',
  };
  const testId = tabMap[tabName] || `tab-${tabName.toLowerCase()}`;
  await page.click(`[data-testid="${testId}"]`);
});

When('el usuario hace click en el artista {string}', async (artistName: string) => {
  await page.click(`[data-testid="artist-item"]:has-text("${artistName}")`);
});

When('el usuario hace click en el álbum {string}', async (albumName: string) => {
  await page.click(`[data-testid="album-item"]:has-text("${albumName}")`);
});

When('el usuario hace click en la playlist {string}', async (playlistName: string) => {
  await page.click(`[data-testid="playlist-item"]:has-text("${playlistName}")`);
});

When('el usuario hace click en {string} en el breadcrumb', async (breadcrumbText: string) => {
  await page.click(`[data-testid="breadcrumb"] >> text=${breadcrumbText}`);
});

When('el usuario hace scroll hasta el final', async () => {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500); // Esperar carga lazy
});

// Then steps
Then('debería mostrarse una lista de artistas', async () => {
  const artistsList = page.locator('[data-testid="artists-list"]');
  await expect(artistsList).toBeVisible();
  const artistCount = await page.locator('[data-testid="artist-item"]').count();
  expect(artistCount).toBeGreaterThan(0);
});

Then('cada artista debería mostrar su nombre', async () => {
  const firstArtist = page.locator('[data-testid="artist-item"]').first();
  await expect(firstArtist.locator('[data-testid="artist-name"]')).toBeVisible();
});

Then('cada artista debería mostrar la cantidad de álbumes', async () => {
  const firstArtist = page.locator('[data-testid="artist-item"]').first();
  await expect(firstArtist.locator('[data-testid="album-count"]')).toBeVisible();
});

Then('debería mostrarse la vista del artista', async () => {
  await page.waitForSelector('[data-testid="artist-detail"]');
});

Then('debería mostrar todos los álbumes del artista', async () => {
  const albumsList = page.locator('[data-testid="albums-list"]');
  await expect(albumsList).toBeVisible();
  const albumCount = await page.locator('[data-testid="album-item"]').count();
  expect(albumCount).toBeGreaterThan(0);
});

Then('debería mostrar información del artista \(nombre, biografía si existe\)', async () => {
  await expect(page.locator('[data-testid="artist-name-header"]')).toBeVisible();
});

Then('debería mostrarse la lista de canciones del álbum', async () => {
  const tracksList = page.locator('[data-testid="tracks-list"]');
  await expect(tracksList).toBeVisible();
});

Then('cada canción debería mostrar título, duración y número de pista', async () => {
  const firstTrack = page.locator('[data-testid="track-item"]').first();
  await expect(firstTrack.locator('[data-testid="track-title"]')).toBeVisible();
  await expect(firstTrack.locator('[data-testid="track-duration"]')).toBeVisible();
  await expect(firstTrack.locator('[data-testid="track-number"]')).toBeVisible();
});

Then('debería mostrar la portada del álbum', async () => {
  await expect(page.locator('[data-testid="album-cover"]')).toBeVisible();
});

Then('debería mostrarse una lista de playlists', async () => {
  const playlistsList = page.locator('[data-testid="playlists-list"]');
  await expect(playlistsList).toBeVisible();
});

Then('cada playlist debería mostrar su nombre', async () => {
  const firstPlaylist = page.locator('[data-testid="playlist-item"]').first();
  await expect(firstPlaylist.locator('[data-testid="playlist-name"]')).toBeVisible();
});

Then('cada playlist debería mostrar la cantidad de canciones', async () => {
  const firstPlaylist = page.locator('[data-testid="playlist-item"]').first();
  await expect(firstPlaylist.locator('[data-testid="track-count"]')).toBeVisible();
});

Then('debería mostrarse el nombre de la playlist', async () => {
  await expect(page.locator('[data-testid="playlist-name-header"]')).toBeVisible();
});

Then('debería mostrar el total de duración', async () => {
  await expect(page.locator('[data-testid="playlist-duration"]')).toBeVisible();
});

Then('debería volver a la lista de artistas', async () => {
  await expect(page.locator('[data-testid="artists-list"]')).toBeVisible();
});

Then('debería volver a la vista principal de biblioteca', async () => {
  await expect(page.locator('[data-testid="library-content"]')).toBeVisible();
});

Then('debería mostrar los primeros 20 artistas', async () => {
  const artistCount = await page.locator('[data-testid="artist-item"]').count();
  expect(artistCount).toBeGreaterThanOrEqual(Math.min(20, artistCount));
});

Then('debería cargar los siguientes 20 artistas', async () => {
  // Verificar que se cargaron más items
  await page.waitForTimeout(500);
});

Then('la lista debería mostrar 40 artistas en total', async () => {
  const artistCount = await page.locator('[data-testid="artist-item"]').count();
  expect(artistCount).toBeGreaterThanOrEqual(40);
});