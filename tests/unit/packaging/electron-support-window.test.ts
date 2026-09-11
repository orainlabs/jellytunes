import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly devDependencies: Readonly<Record<string, string>>;
}

const projectManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

/**
 * Electron mantiene solo las 3 majors más recientes. A 2026-09-11: 42, 43 y 44.
 * Actualizar esta lista cuando la ventana se desplace — el test es un recordatorio
 * deliberado, no una comprobación en vivo contra releases.electronjs.org.
 */
const SUPPORTED_MAJORS: readonly number[] = [42, 43, 44];
const CHOSEN_MAJOR = 44;

const parseMajor = (range: string): number => {
  const match = /(\d+)\./.exec(range);
  if (match === null) {
    throw new Error(`No se pudo extraer la major del rango "${range}"`);
  }
  return Number(match[1]);
};

describe('Ventana de soporte de Electron', () => {
  it('fija electron en una major mantenida', () => {
    const major = parseMajor(projectManifest.devDependencies.electron);

    expect(SUPPORTED_MAJORS).toContain(major);
  });

  it('apunta a la línea 44 elegida en ORAIN-0691', () => {
    const major = parseMajor(projectManifest.devDependencies.electron);

    expect(major).toBe(CHOSEN_MAJOR);
  });
});
