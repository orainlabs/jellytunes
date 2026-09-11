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

/**
 * Extrae el cuerpo de un bloque `<clave>: { ... }` de primer nivel dentro del
 * objeto de configuración, contando llaves para no cortar en el primer `}`
 * anidado. Lanza si la clave no aparece.
 */
const extractBlock = (source: string, key: string): string => {
  const keyPattern = new RegExp(`\\b${key}\\s*:\\s*{`);
  const match = keyPattern.exec(source);
  if (match === null) {
    throw new Error(`No se encontró el bloque "${key}" en electron.vite.config.ts`);
  }

  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Bloque "${key}" sin cerrar en electron.vite.config.ts`);
};

const preloadBlock = extractBlock(viteConfig, 'preload');
const mainBlock = extractBlock(viteConfig, 'main');

describe('Endurecimiento del renderer', () => {
  it('activa el sandbox del sistema operativo', () => {
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).not.toContain('sandbox: false');
  });

  it('mantiene contextIsolation y nodeIntegration endurecidos', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
  });

  // Cubre: que la exclusión de externalización de @electron-toolkit/preload
  // vive en el bloque `preload:` (no en `main:`, donde no tendría efecto
  // sobre el bundle del preload). No cubre: un bump de electron-vite que
  // renombre o reestructure la opción sin mover texto — eso solo lo detecta
  // el E2E, que arranca el binario real y comprueba `window.api`.
  it('bundlea el toolkit del preload para que un preload sandboxeado lo resuelva', () => {
    expect(preloadBlock).toContain("exclude: ['@electron-toolkit/preload']");
    expect(mainBlock).not.toContain("exclude: ['@electron-toolkit/preload']");
  });
});
