import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly homepage: string;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly build: {
    readonly productName: string;
    readonly linux: {
      readonly target: readonly string[];
    };
  };
}

const projectManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
const require = createRequire(import.meta.url);
const appBuilderLibRoot = dirname(require.resolve('app-builder-lib/package.json'));
const linuxTemplate = (name: string): string =>
  readFileSync(join(appBuilderLibRoot, 'templates', 'linux', name), 'utf8');

describe('Linux deb sandbox packaging', () => {
  it('uses electron-builder v26 with the existing deb and AppImage targets', () => {
    expect(projectManifest.devDependencies['electron-builder']).toMatch(/^\^26\./);
    expect(projectManifest.build.linux.target).toEqual(['AppImage', 'deb']);
  });

  it('provides the project URL required by v26 deb metadata', () => {
    expect(projectManifest.homepage).toBe('https://github.com/orainlabs/jellytunes');
  });

  it('keeps a whitespace-free product name for valid AppArmor syntax', () => {
    expect(projectManifest.build.productName).toBe('JellyTunes');
    expect(projectManifest.build.productName).not.toMatch(/\s/);
  });

  it('bundles the user namespace AppArmor profile used by deb packages', () => {
    const profile = linuxTemplate('apparmor-profile.tpl');

    expect(profile).toContain('userns,');
    expect(profile).toContain('/opt/${sanitizedProductName}/${executable}');
  });

  it('installs and removes the generated AppArmor profile', () => {
    const afterInstall = linuxTemplate('after-install.tpl');
    const afterRemove = linuxTemplate('after-remove.tpl');

    expect(afterInstall).toContain("APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'");
    expect(afterInstall).toContain('apparmor_parser --replace');
    expect(afterRemove).toContain("APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'");
    expect(afterRemove).toContain('rm -f "$APPARMOR_PROFILE_DEST"');
  });
});
