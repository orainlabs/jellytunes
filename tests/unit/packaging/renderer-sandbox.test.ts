import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guardián de configuración, no de comportamiento: la prueba real de que el
 * sandbox funciona es la suite E2E, que arranca el binario con
 * `_electron.launch`. Este test evita que alguien revierta el endurecimiento
 * sin darse cuenta.
 */
const mainSource = readFileSync('src/main/index.ts', 'utf8');
const viteConfig = readFileSync('electron.vite.config.ts', 'utf8');

describe('Endurecimiento del renderer', () => {
  it('activa el sandbox del sistema operativo', () => {
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).not.toContain('sandbox: false');
  });

  it('mantiene contextIsolation y nodeIntegration endurecidos', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
  });

  it('bundlea el toolkit del preload para que un preload sandboxeado lo resuelva', () => {
    expect(viteConfig).toContain("exclude: ['@electron-toolkit/preload']");
  });
});
