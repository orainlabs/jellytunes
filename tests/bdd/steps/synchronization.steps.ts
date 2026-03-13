import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { Page } from 'playwright';

declare let page: Page;

// Given steps
Given('la biblioteca está cargada', async () => {
  await page.waitForSelector('[data-testid="library-content"]');
});

Given('el usuario está viendo canciones de un álbum', async () => {
  await page.click('[data-testid="album-item"]:first-child');
  await page.waitForSelector('[data-testid="tracks-list"]');
});

Given('un dispositivo USB es conectado', async () => {
  // Simular evento de dispositivo conectado
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('usb-device-connected', {
      detail: { name: 'USB Drive', availableSpace: 1024 * 1024 * 1024 }
    }));
  });
});

Given('hay un dispositivo USB conectado', async () => {
  await page.waitForSelector('[data-testid="usb-device-connected"]');
});

Given('el usuario ha seleccionado {int} canciones', async (count: number) => {
  // Seleccionar N canciones
  for (let i = 0; i < count; i++) {
    await page.click(`[data-testid="track-item"]:nth-child(${i + 1}) [data-testid="track-checkbox"]`);
  }
});

Given('la sincronización está en progreso', async () => {
  await page.click('[data-testid="sync-button"]');
  await page.waitForSelector('[data-testid="sync-progress"]');
});

Given('el usuario ha seleccionado canciones que exceden el espacio disponible', async () => {
  // Simular selección que excede espacio
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('storage-estimate', {
      detail: { required: 2000000000, available: 500000000 }
    }));
  });
});

// When steps
When('el usuario marca la casilla de la canción {string}', async (songTitle: string) => {
  const trackRow = page.locator(`[data-testid="track-item"]:has-text("${songTitle}")`);
  await trackRow.locator('[data-testid="track-checkbox"]').check();
});

When('el usuario marca la casilla {string}', async (checkboxLabel: string) => {
  if (checkboxLabel === 'Seleccionar todo') {
    await page.click('[data-testid="select-all-checkbox"]');
  } else {
    await page.check(`label:has-text("${checkboxLabel}") input[type="checkbox"]`);
  }
});

When('el dispositivo USB es desconectado', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('usb-device-disconnected'));
  });
});

// Then steps
Then('debería detectarse el dispositivo automáticamente', async () => {
  await page.waitForSelector('[data-testid="usb-device-connected"]');
});

Then('debería mostrarse el nombre del dispositivo', async () => {
  await expect(page.locator('[data-testid="device-name"]')).toBeVisible();
});

Then('debería mostrar el espacio disponible', async () => {
  await expect(page.locator('[data-testid="available-space"]')).toBeVisible();
});

Then('el botón {string} debería habilitarse', async (buttonText: string) => {
  const button = page.locator(`button:has-text("${buttonText}")`);
  await expect(button).toBeEnabled();
});

Then('el contador de canciones seleccionadas debería mostrar {string}', async (count: string) => {
  const counter = page.locator('[data-testid="selected-count"]');
  await expect(counter).toHaveText(count);
});

Then('el indicador de espacio requerido debería actualizarse', async () => {
  await expect(page.locator('[data-testid="required-space"]')).toBeVisible();
});

Then('todas las canciones del álbum deberían estar marcadas', async () => {
  const checkboxes = await page.locator('[data-testid="track-checkbox"]').all();
  for (const checkbox of checkboxes) {
    await expect(checkbox).toBeChecked();
  }
});

Then('el contador debería mostrar el total de canciones del álbum', async () => {
  const trackCount = await page.locator('[data-testid="track-item"]').count();
  const selectedCount = await page.locator('[data-testid="selected-count"]').textContent();
  expect(selectedCount).toContain(trackCount.toString());
});

Then('debería iniciarse el proceso de sincronización', async () => {
  await page.waitForSelector('[data-testid="sync-progress"]');
});

Then('debería mostrarse una barra de progreso', async () => {
  await expect(page.locator('[data-testid="sync-progress-bar"]')).toBeVisible();
});

Then('When la sincronización completa', async () => {
  await page.waitForSelector('[data-testid="sync-complete"]', { timeout: 30000 });
});

Then('las canciones deberían estar en el dispositivo USB', async () => {
  // Verificar que se completó exitosamente
  await expect(page.locator('[data-testid="sync-success-icon"]')).toBeVisible();
});

Then('la sincronización debería detenerse', async () => {
  await page.waitForSelector('[data-testid="sync-cancelled"]');
});

Then('los archivos parcialmente copiados deberían eliminarse', async () => {
  // Verificar limpieza de archivos temporales
  await expect(page.locator('[data-testid="cleanup-complete"]')).toBeVisible();
});

Then('debería mostrarse el mensaje {string}', async (message: string) => {
  await expect(page.locator(`text=${message}`)).toBeVisible();
});

Then('debería mostrar cuánto espacio adicional se necesita', async () => {
  await expect(page.locator('[data-testid="additional-space-needed"]')).toBeVisible();
});

Then('la sincronización no debería iniciarse', async () => {
  const progressBar = page.locator('[data-testid="sync-progress"]');
  await expect(progressBar).not.toBeVisible();
});

Then('debería mostrarse el mensaje {string}', async (message: string) => {
  await expect(page.locator(`text=${message}`)).toBeVisible();
});

Then('la sincronización debería pausarse', async () => {
  const progressBar = page.locator('[data-testid="sync-progress"]');
  // Verificar que el progreso se detuvo
  const progress = await progressBar.getAttribute('data-progress');
  await page.waitForTimeout(1000);
  const newProgress = await progressBar.getAttribute('data-progress');
  expect(progress).toBe(newProgress);
});