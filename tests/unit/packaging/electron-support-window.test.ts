import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly devDependencies: Readonly<Record<string, string>>;
}

const projectManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

/**
 * Electron support window as of 2026-09-11: majors 42, 43 and 44 (Electron
 * keeps only the 3 most recent). This fact cannot be checked statically — no
 * test can know whether 44 is still supported further on — so it has to be
 * reviewed by hand when the window slides.
 */
const CHOSEN_MAJOR = 44;

const parseMajor = (range: string): number => {
  const match = /(\d+)\./.exec(range);
  if (match === null) {
    throw new Error(`Could not extract the major from range "${range}"`);
  }
  return Number(match[1]);
};

describe('Electron support window', () => {
  it('pins the electron major in package.json at line 44', () => {
    const major = parseMajor(projectManifest.devDependencies.electron);

    expect(major).toBe(CHOSEN_MAJOR);
  });
});
