// src/main/app-menu.ts
// Platform-specific application menu template (ORAIN-0708).
//
// On Linux, the snap build suffers a visual bug where the application menu bar
// does not follow the system theme (titlebar goes dark, menu stays light, both
// rendered by the host's GTK). To eliminate that variable we hide the menu
// bar on Linux — parity with the Windows build — and register a minimal
// template there so the DevTools accelerator stays wired up in dev. Windows
// and macOS keep the templates they shipped with in 0.7.0.
//
// Ctrl+C / Ctrl+V / Ctrl+X are NOT wired through this template on Linux:
// text fields in the renderer rely on the browser's native clipboard
// behaviour. The caller hides the menu bar via `autoHideMenuBar` so the user
// never sees the Edit submenu in the first place.

import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuTemplateOptions {
  /** True in dev builds — controls visibility of the DevTools toggle. */
  isDev: boolean;
  /** Callback invoked when the user clicks the DevTools toggle. */
  onToggleDevTools: () => void;
}

const DEVTOOLS_VIEW_TEMPLATE = (options: AppMenuTemplateOptions): MenuItemConstructorOptions[] => [
  {
    label: 'View',
    submenu: [
      {
        label: 'Toggle Developer Tools',
        accelerator: 'CmdOrCtrl+Alt+I',
        visible: options.isDev,
        click: () => options.onToggleDevTools(),
      },
    ],
  },
];

export function getAppMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  options: AppMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  const devToolsView = DEVTOOLS_VIEW_TEMPLATE(options);

  if (platform === 'darwin') {
    // macOS needs the app menu (first item carries the app name and Cmd+Q)
    // plus an Edit submenu with the standard clipboard roles.
    return [
      { label: appName, submenu: [{ role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      ...devToolsView,
    ];
  }
  if (platform === 'win32') {
    // Windows keeps the template it shipped with in 0.7.0: the menu bar is
    // auto-hidden, and the `editMenu` role was never involved in the Linux
    // GTK theming bug this module addresses. Leaving it in place keeps the
    // clipboard behaviour on Windows byte-for-byte unchanged.
    return [{ role: 'editMenu' }, ...devToolsView];
  }

  // linux: minimal template that exists only to register the DevTools
  // accelerator. The menu bar is auto-hidden (see createWindow() in
  // src/main/index.ts) and the Edit role is dropped so the host's GTK stops
  // rendering a light menu bar under a dark titlebar in the snap build.
  return devToolsView;
}
