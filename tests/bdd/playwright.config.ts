import { defineConfig, devices } from '@playwright/test';

/**
 * Configuración de Playwright para tests E2E de Jellysync
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e',
  
  /* Tiempo máximo por test */
  timeout: 30 * 1000,
  
  /* Esperar hasta que todos los hooks terminen */
  expect: {
    timeout: 5000,
  },
  
  /* Reporterios */
  reporter: [
    ['html', { outputFolder: './tests/bdd/reports/playwright-report' }],
    ['list'],
  ],
  
  /* Configuración de workers */
  workers: process.env.CI ? 1 : undefined,
  
  /* Configuración de proyectos */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  
  /* Directorio de output */
  outputDir: './tests/bdd/test-results/',
});