// src/main/app-menu.test.ts
// Unit tests for the platform-specific application menu template (ORAIN-0708).
//
// The snap build for Linux suffers a visual bug where the application menu bar
// does not follow the system theme (it stays light while the titlebar goes
// dark). To eliminate the variable, we hide the menu bar on Linux (parity with
// the Windows build) and only register a minimal template that keeps the
// DevTools accelerator wired up in dev.

import { describe, it, expect } from 'vitest';
import { getAppMenuTemplate, type AppMenuTemplateOptions } from './app-menu';

const NOOP_OPTIONS: AppMenuTemplateOptions = {
  isDev: false,
  onToggleDevTools: () => {},
};

describe('getAppMenuTemplate', () => {
  it('returns a darwin template with the app menu (quit), Edit and View submenus (macOS UX)', () => {
    const template = getAppMenuTemplate('darwin', 'JellyTunes', NOOP_OPTIONS);
    expect(template).not.toBeNull();
    const labels = template!.map((entry) => entry.label);
    expect(labels[0]).toBe('JellyTunes'); // macOS app menu carries the app name and Cmd+Q
    expect(labels).toContain('Edit');
    expect(labels).toContain('View');
  });

  it('keeps the editMenu role on win32 (unchanged from 0.7.0 — Windows is out of scope)', () => {
    // ORAIN-0708 is a Linux GTK theming bug. The Windows menu bar is already
    // auto-hidden and its `editMenu` role was never part of the problem, so it
    // stays exactly as it shipped in 0.7.0: dropping it would ship an
    // untested clipboard change to a platform the fix does not touch.
    const template = getAppMenuTemplate('win32', 'JellyTunes', NOOP_OPTIONS);
    expect(template).not.toBeNull();
    const roles = template!.map((entry) => entry.role);
    expect(roles).toContain('editMenu');
    const labels = template!.map((entry) => entry.label);
    expect(labels).toContain('View');
  });

  it('returns a linux template without a top-level Edit submenu (ORAIN-0708 parity with win32)', () => {
    // ORAIN-0708: the Edit menu on Linux inherited from the win32/linux
    // shared branch used the `editMenu` role, which rendered a visible menu
    // bar under GTK that did not pick up the system theme. The fix hides the
    // menu bar on Linux (autoHideMenuBar) and drops the Edit role entirely —
    // text fields in the renderer rely on the browser's native copy/paste.
    const template = getAppMenuTemplate('linux', 'JellyTunes', NOOP_OPTIONS);
    expect(template).not.toBeNull();
    const roles = template!.map((entry) => entry.role);
    expect(roles).not.toContain('editMenu');
    const labels = template!.map((entry) => entry.label);
    expect(labels).not.toContain('Edit');
    expect(labels).toContain('View');
  });
});
