import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { Page } from 'playwright';

declare let page: Page;

// Given steps
Given('la biblioteca está cargada con múltiples artistas y géneros', async () => {
  await page.waitForSelector('[data-testid="library-content"]');
});

Given('el usuario ha aplicado filtros', async () => {
  // Aplicar algún filtro de ejemplo
  await page.click('[data-testid="filter-button"]');
  await page.click('[data-testid="filter-genre"]');
  await page.click('text=Rock');
});

// When steps
When('el usuario escribe {string} en el campo de búsqueda', async (searchTerm: string) => {
  await page.fill('[data-testid="search-input"]', searchTerm);
  await page.waitForTimeout(500); // Debounce
});

When('el usuario selecciona el filtro {string}', async (filterType: string) => {
  await page.click('[data-testid="filter-button"]');
  const filterMap: Record<string, string> = {
    'Género': 'filter-genre',
    'Década': 'filter-decade',
  };
  const testId = filterMap[filterType] || `filter-${filterType.toLowerCase()}`;
  await page.click(`[data-testid="${testId}"]`);
});

When('el usuario selecciona {string}', async (option: string) => {
  await page.click(`text=${option}`);
});

When('el usuario aplica el filtro {string}', async (filter: string) => {
  const [filterType, filterValue] = filter.split(':').map(s => s.trim());
  await page.click('[data-testid="filter-button"]');
  
  const filterMap: Record<string, string> = {
    'Género': 'filter-genre',
    'Década': 'filter-decade',
  };
  
  await page.click(`[data-testid="${filterMap[filterType]}"]`);
  await page.click(`text=${filterValue}`);
});

When('el usuario hace click en {string}', async (buttonText: string) => {
  if (buttonText === 'Limpiar filtros') {
    await page.click('[data-testid="clear-filters-button"]');
  } else {
    await page.click(`button:has-text("${buttonText}")`);
  }
});

When('el usuario selecciona {string}', async (sortOption: string) => {
  await page.click('[data-testid="sort-dropdown"]');
  await page.click(`text=${sortOption}`);
});

When('el usuario hace click en el campo de búsqueda', async () => {
  await page.click('[data-testid="search-input"]');
});

// Then steps
Then('deberían mostrarse resultados que contengan {string}', async (searchTerm: string) => {
  const results = page.locator('[data-testid="search-results"]');
  await expect(results).toBeVisible();
  const firstResult = results.locator('[data-testid="search-item"]').first();
  await expect(firstResult).toContainText(searchTerm, { ignoreCase: true });
});

Then('los resultados deberían incluir canciones, álbumes y artistas', async () => {
  const resultTypes = await page.locator('[data-testid="result-type"]').allTextContents();
  expect(resultTypes.some(t => t.includes('Canción'))).toBeTruthy();
  expect(resultTypes.some(t => t.includes('Álbum'))).toBeTruthy();
  expect(resultTypes.some(t => t.includes('Artista'))).toBeTruthy();
});

Then('cada resultado debería mostrar su tipo \(canción, álbum, artista\)', async () => {
  const items = await page.locator('[data-testid="search-item"]').all();
  for (const item of items) {
    await expect(item.locator('[data-testid="result-type"]')).toBeVisible();
  }
});

Then('deberían mostrarse solo los artistas del género Rock', async () => {
  // Verificar que se aplicó el filtro
  await expect(page.locator('[data-testid="active-filter"]:has-text("Rock")')).toBeVisible();
});

Then('el contador debería actualizarse con el total filtrado', async () => {
  await expect(page.locator('[data-testid="filtered-count"]')).toBeVisible();
});

Then('deberían mostrarse solo los álbumes de los años 60', async () => {
  await expect(page.locator('[data-testid="active-filter"]:has-text("1960s")')).toBeVisible();
});

Then('los álbumes deberían estar ordenados por año', async () => {
  const years = await page.locator('[data-testid="album-year"]').allTextContents();
  const yearNumbers = years.map(y => parseInt(y)).filter(n => !isNaN(n));
  const sortedYears = [...yearNumbers].sort((a, b) => a - b);
  expect(yearNumbers).toEqual(sortedYears);
});

Then('deberían mostrarse solo álbumes de Rock de los 70s', async () => {
  await expect(page.locator('[data-testid="active-filter"]:has-text("Rock")')).toBeVisible();
  await expect(page.locator('[data-testid="active-filter"]:has-text("1970s")')).toBeVisible();
});

Then('ambos filtros deberían mostrarse como tags activos', async () => {
  const activeFilters = await page.locator('[data-testid="active-filter"]').count();
  expect(activeFilters).toBeGreaterThanOrEqual(2);
});

Then('todos los filtros deberían eliminarse', async () => {
  const activeFilters = await page.locator('[data-testid="active-filter"]').count();
  expect(activeFilters).toBe(0);
});

Then('debería mostrarse la biblioteca completa', async () => {
  await expect(page.locator('[data-testid="library-content"]')).toBeVisible();
});

Then('debería mostrarse el mensaje {string}', async (message: string) => {
  await expect(page.locator(`text=${message}`)).toBeVisible();
});

Then('debería sugerir {string}', async (suggestion: string) => {
  await expect(page.locator(`text=${suggestion}`)).toBeVisible();
});

Then('el filtro de género debería seguir activo', async () => {
  await expect(page.locator('[data-testid="active-filter"]:has-text("Jazz")')).toBeVisible();
});

Then('los artistas deberían ordenarse alfabéticamente', async () => {
  const names = await page.locator('[data-testid="artist-name"]').allTextContents();
  const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sortedNames);
});

Then('los artistas deberían ordenarse por fecha de adición', async () => {
  // Verificar que se aplicó el ordenamiento
  await expect(page.locator('[data-testid="sort-indicator"]')).toBeVisible();
});

Then('debería mostrarse {string} en las búsquedas recientes', async (searchTerm: string) => {
  await expect(page.locator(`[data-testid="recent-search"]:has-text("${searchTerm}")`)).toBeVisible();
});

Then('deberían mostrarse los resultados de {string}', async (searchTerm: string) => {
  const results = page.locator('[data-testid="search-results"]');
  await expect(results).toBeVisible();
});