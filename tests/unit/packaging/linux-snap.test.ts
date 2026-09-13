import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PlugDescriptor {
  readonly [key: string]: { readonly [key: string]: unknown } | null;
}

// electron-builder canonical shape for snap plugs (SnapOptions.d.ts:164/426):
// `plugs: Array<string | PlugDescriptor> | PlugDescriptor | null`. The list form
// is what we use here because the `"default"` keyword only expands inside a
// list (see processPlugOrSlots in app-builder-lib out/targets/snap/core24.js).
// As a top-level object key, `"default"` is emitted verbatim and snapd rejects
// it with "unknown interface default" — that was the bug ORAIN-0708 fixed on
// 2026-09-13 after the first attempt with a `Record<string, ...>` shape.
type PlugEntry = string | PlugDescriptor;

interface SnapCore24Options {
  readonly confinement: string;
  readonly useLXD: boolean;
  readonly stagePackages: readonly string[];
  readonly executableArgs: readonly string[];
  readonly plugs: readonly PlugEntry[];
}

interface PackageManifest {
  readonly build: {
    readonly linux: {
      readonly target: readonly string[];
    };
    readonly snapcraft: {
      readonly base: string;
      readonly core24: SnapCore24Options;
    };
    // Legacy electron-builder key — must stay absent, see ORAIN-0571 spec:
    // mixing `snap` with `snapcraft`/`base: core24` silently builds a
    // core20-templated package that fails at runtime on Noble.
    readonly snap?: unknown;
  };
}

const projectManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

describe('Linux snap sandbox packaging', () => {
  it('adds the snap target alongside the existing AppImage/deb targets', () => {
    expect(projectManifest.build.linux.target).toEqual(['AppImage', 'deb', 'snap']);
  });

  it('configures snap packaging via the `snapcraft` key targeting core24, not the legacy `snap` key', () => {
    expect(projectManifest.build.snapcraft.base).toBe('core24');
    expect(projectManifest.build.snap).toBeUndefined();
  });

  it('ships strict confinement, per the ORAIN-0571 spike decision', () => {
    expect(projectManifest.build.snapcraft.core24.confinement).toBe('strict');
  });

  it('builds via LXD so the gnome extension provisions Electron/Chromium runtime libraries automatically', () => {
    expect(projectManifest.build.snapcraft.core24.useLXD).toBe(true);
  });

  it('opts into the default stage-packages (libnss3 and friends) — omitting this silently ships zero runtime libs', () => {
    expect(projectManifest.build.snapcraft.core24.stagePackages).toContain('default');
  });

  it('disables /dev/shm so Chromium falls back to $TMPDIR under strict confinement', () => {
    expect(projectManifest.build.snapcraft.core24.executableArgs).toContain(
      '--disable-dev-shm-usage',
    );
  });

  it('declares the manual-connect interfaces required by USB sync and volume labeling', () => {
    // ORAIN-0591: `hardware-observe` is intentionally absent — USB detection
    // under snap runs entirely on polling (`device-watcher.ts`), so the
    // udev access granted by that plug is no longer needed.
    // ORAIN-0592: `mount-observe` is also absent — nested mount detection
    // uses `st_dev`/`statfs` instead of `/proc/mounts`.
    const plugs = projectManifest.build.snapcraft.core24.plugs;
    const flatPlugNames = collectPlugNames(plugs);

    expect(flatPlugNames).toContain('removable-media');
    expect(flatPlugNames).not.toContain('mount-observe');
    expect(flatPlugNames).not.toContain('hardware-observe');
    expect(flatPlugNames).not.toContain('password-manager-service');
  });

  it('does NOT declare password-manager-service (ORAIN-0590 — secret-tool needs no plug)', () => {
    // The session-storage provider switched to `secret-tool`, which routes
    // through the Secret portal inside the confinement. The plug is no
    // longer requested, no longer surfaced in the UI, and no longer probed.
    // If a future contributor re-adds it, the banner copy and the snap
    // permission reports will drift, so the test fails fast.
    const flatPlugNames = collectPlugNames(projectManifest.build.snapcraft.core24.plugs);
    expect(flatPlugNames).not.toContain('password-manager-service');
  });

  it('uses the list-mixed shape (not a top-level object) so "default" is a keyword, not an interface name', () => {
    // Regression: ORAIN-0708 round 1 declared `plugs` as
    // `{ default: null, removable-media: null, ... }`. Object keys are emitted
    // verbatim to snapcraft.yaml, so snapd read `default: null` as an
    // interface declaration and rejected it:
    //   "snap "jellytunes" has bad plugs or slots: default (unknown interface "default")"
    // Only the list form expands `"default"` as the keyword that keeps the
    // 11 default plugs (desktop, x11, wayland, ...); as a top-level object
    // key it is just a name. See processPlugOrSlots in
    // app-builder-lib/out/targets/snap/core24.js.
    const plugs = projectManifest.build.snapcraft.core24.plugs;
    expect(Array.isArray(plugs)).toBe(true);
  });

  it('keeps the 11 electron-builder default plugs via the "default" keyword', () => {
    // The `"default"` keyword expands to the electron-builder defaults:
    // desktop, desktop-legacy, home, x11, wayland, unity7, network, gsettings,
    // audio-playback, pulseaudio, opengl. Listing them as a string is the
    // documented way to keep them (SnapOptions.d.ts:152-153). Adding them
    // manually would drift if electron-builder changes its default set.
    const plugs = projectManifest.build.snapcraft.core24.plugs;
    expect(plugs).toContain('default');
    // The keyword MUST appear as a bare string in the array. If a future
    // edit wraps it inside an object descriptor, it would be treated as a
    // plug name and emit `default: {}` to snapcraft.yaml — same crash.
    expect(plugs.some((entry) => typeof entry !== 'string' && 'default' in entry)).toBe(false);
  });

  it('declares browser-support with allow-sandbox:true so Chromium does not crash under strict confinement', () => {
    // electron-builder only auto-injects browser-support when the user has
    // declared NO plugs. Since we declare `default` plus `removable-media`,
    // we are responsible for adding browser-support ourselves. Without
    // allow-sandbox: true, Chromium's internal sandbox fails with
    // "FATAL: Permission denied (13)" in credentials.cc (see comments at
    // core24.js:232-242 and the same Chromium upstream bug referenced there).
    const plugs = projectManifest.build.snapcraft.core24.plugs;
    const browserSupport = plugs.find(
      (entry) => typeof entry !== 'string' && 'browser-support' in entry,
    ) as PlugDescriptor | undefined;

    expect(browserSupport).toBeDefined();
    const descriptor = browserSupport!['browser-support'] as Record<string, unknown>;
    expect(descriptor['interface']).toBe('browser-support');
    expect(descriptor['allow-sandbox']).toBe(true);
  });
});

/**
 * Flatten the mixed plug list into a set of plug names so each test can assert
 * "plug X is declared" or "plug Y is absent" without caring whether the plug
 * sits as a bare string or inside a one-key descriptor object.
 */
function collectPlugNames(entries: readonly PlugEntry[]): readonly string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      // `"default"` is a keyword, not a real plug — skip it. Tests that
      // care about it assert on its presence directly.
      if (entry !== 'default') {
        names.push(entry);
      }
    } else {
      for (const name of Object.keys(entry)) {
        names.push(name);
      }
    }
  }
  return names;
}
