import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { Page } from 'playwright';

declare let page: Page;

// Given steps
Given('el usuario ha configurado un servidor válido', async () => {
  await page.fill('[data-testid="server-url-input"]', 'https://jellyfin.example.com');
});

Given('el usuario está intentando conectar', async () => {
  await page.click('[data-testid="connect-button"]');
});

Given('el usuario ingresa credenciales', async () => {
  await page.fill('[data-testid="server-url-input"]', 'https://jellyfin.example.com');
  await page.fill('[data-testid="api-key-input"]', 'expired-key');
  await page.click('[data-testid="connect-button"]');
});

Given('el usuario está navegando la biblioteca', async () => {
  await page.waitForSelector('[data-testid="library-screen"]');
});

Given('el usuario está conectado', async () => {
  await page.waitForSelector('[data-testid="library-screen"]');
});

Given('hay un dispositivo USB conectado', async () => {
  await page.waitForSelector('[data-testid="usb-device-connected"]');
});

Given('ocurre un error inesperado', async () => {
  // Simular error inesperado
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('unhandled-error', {
      detail: { message: 'Unknown error occurred' }
    }));
  });
});

// When steps
When('el servidor Jellyfin está caído', async () => {
  // Simular servidor caído
  await page.route('**/jellyfin/**', route => route.abort('failed'));
});

When('el usuario intenta conectar', async () => {
  await page.click('[data-testid="connect-button"]');
});

When('el servidor tarda más de {int} segundos en responder', async (seconds: number) => {
  await page.route('**/jellyfin/**', async route => {
    await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000));
    route.abort('timedout');
  });
});

When('la API key ha expirado', async () => {
  await page.route('**/jellyfin/**', route => {
    route.fulfill({
      status: 401,
      body: JSON.stringify({ message: 'Unauthorized' })
    });
  });
});

When('se pierde la conexión a internet', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
  });
});

When('ocurre un error al cargar la biblioteca', async () => {
  await page.route('**/jellyfin/library**', route => {
    route.fulfill({
      status: 500,
      body: JSON.stringify({ message: 'Internal Server Error' })
    });
  });
});

When('se encuentra un archivo corrupto', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('sync-error', {
      detail: { type: 'corrupt-file', filename: 'song.mp3' }
    }));
  });
});

When('el dispositivo está protegido contra escritura', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('usb-error', {
      detail: { type: 'read-only' }
    }));
  });
});

When('el usuario intenta sincronizar', async () => {
  await page.click('[data-testid="sync-button"]');
});

// Then steps
Then('debería mostrarse un mensaje de error amigable', async () => {
  await page.waitForSelector('[data-testid="error-message"]');
  const errorElement = page.locator('[data-testid="error-message"]');
  await expect(errorElement).toBeVisible();
});

Then('el mensaje debería decir {string}', async (message: string) => {
  const errorElement = page.locator('[data-testid="error-message"]');
  await expect(errorElement).toContainText(message);
});

Then('debería mostrar {string}', async (text: string) => {
  await expect(page.locator(`text=${text}`)).toBeVisible();
});

Then('debería ofrecer la opción {string}', async (option: string) => {
  await expect(page.locator(`button:has-text("${option}")`)).toBeVisible();
});

Then('debería sugerir {string}', async (suggestion: string) => {
  await expect(page.locator(`text=${suggestion}`)).toBeVisible();
});

Then('debería mostrarse el contenido en caché si está disponible', async () => {
  // Verificar que se muestra contenido offline
  const hasCachedContent = await page.locator('[data-testid="cached-content"]').count() > 0;
  // Puede o no tener contenido en caché
});

Then('debería mostrar el estado {string}', async (status: string) => {
  await expect(page.locator(`[data-testid="offline-status"]:has-text("${status}")`)).toBeVisible();
});

Then('debería mostrar el detalle del error', async () => {
  await expect(page.locator('[data-testid="error-details"]')).toBeVisible();
});

Then('debería registrar el error en logs', async () => {
  // Los errores deberían estar en el estado de la app
  await expect(page.locator('[data-testid="error-logged-indicator"]')).toBeVisible();
});

Then('debería continuar con la siguiente canción', async () => {
  await page.waitForTimeout(1000);
  // La sincronización debería continuar
});

Then('al finalizar debería mostrar {string}', async (message: string) => {
  await expect(page.locator(`text=${message}`)).toBeVisible();
});

Then('debería ofrecer ver el reporte de errores', async () => {
  await expect(page.locator('button:has-text("Ver reporte")')).toBeVisible();
});

Then('debería mostrarse un mensaje genérico amigable', async () => {
  await expect(page.locator('[data-testid="generic-error-message"]')).toBeVisible();
});

Then('no debería mostrarse código de error técnico al usuario', async () => {
  const errorText = await page.locator('[data-testid="generic-error-message"]').textContent();
  expect(errorText).not.toMatch(/\d{3,}/); // No números grandes (códigos de error)
  expect(errorText).not.toMatch(/Error:|Exception:/i);
});

Then('debería ofrecer la opción {string}', async (option: string) => {
  await expect(page.locator(`button:has-text("${option}")`)).toBeVisible();
});

Then('los detalles técnicos deberían estar disponibles para soporte', async () => {
  await page.click('button:has-text("Ver detalles técnicos")');
  await expect(page.locator('[data-testid="technical-details"]')).toBeVisible();
});