import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly devDependencies: Readonly<Record<string, string>>;
}

const projectManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

/**
 * Ventana de soporte de Electron a 2026-09-11: majors 42, 43 y 44 (Electron
 * mantiene solo las 3 más recientes). Este dato no se puede comprobar de
 * forma estática — ningún test sabe si la 44 sigue soportada más adelante —
 * así que hay que revisarlo a mano cuando la ventana se desplace.
 */
const CHOSEN_MAJOR = 44;

const parseMajor = (range: string): number => {
  const match = /(\d+)\./.exec(range);
  if (match === null) {
    throw new Error(`No se pudo extraer la major del rango "${range}"`);
  }
  return Number(match[1]);
};

describe('Ventana de soporte de Electron', () => {
  it('fija el pin de electron en package.json en la línea 44', () => {
    const major = parseMajor(projectManifest.devDependencies.electron);

    expect(major).toBe(CHOSEN_MAJOR);
  });
});
