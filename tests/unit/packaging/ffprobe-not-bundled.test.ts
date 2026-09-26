import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ORAIN-0733: ffprobe is a dev/test tool, not part of the shipped app.
 *
 * The app only uses ffprobe to read the original file's tags before a
 * conversion, and works without it (readFileMetadata resolves {}). Bundling it
 * adds ~75 MB per platform and changes which tags end up in converted files,
 * so doing it needs a deliberate product decision, not a test-driven side effect.
 */

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly build: { readonly asarUnpack?: readonly string[] };
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
const isFfprobe = (name: string): boolean => name.startsWith('@ffprobe-installer/');

describe('ffprobe packaging', () => {
  it('keeps @ffprobe-installer out of the runtime dependencies', () => {
    expect(Object.keys(manifest.dependencies ?? {}).filter(isFfprobe)).toEqual([]);
    expect(Object.keys(manifest.optionalDependencies ?? {}).filter(isFfprobe)).toEqual([]);
  });

  it('keeps ffprobe available for the FFmpeg integration tests', () => {
    expect(manifest.devDependencies?.['@ffprobe-installer/ffprobe']).toBeDefined();
  });

  it('does not unpack ffprobe binaries from the asar', () => {
    expect(
      (manifest.build.asarUnpack ?? []).filter((g) => g.includes('@ffprobe-installer')),
    ).toEqual([]);
  });
});
