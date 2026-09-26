// ORAIN-0727 AC2: the IPC handler that opens the log folder must not accept
// any path from the renderer — it resolves the current log file from the
// logger itself and calls the shell opener on that. This unit test pins
// down the contract by checking what arguments the opener receives when the
// renderer is allowed to pass anything.

import { describe, it, expect, vi } from 'vitest';
import { showLogFileInFolder } from './log-folder';

describe('showLogFileInFolder', () => {
  it('ignores the path passed in and uses the path from the logger', () => {
    const shell = { showItemInFolder: vi.fn() };
    showLogFileInFolder('/attacker-supplied/path/whatever.log', () => '/safe/log/main.log', shell);
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/safe/log/main.log');
  });

  it('calls the log path resolver exactly once', () => {
    const shell = { showItemInFolder: vi.fn() };
    const resolve = vi.fn(() => '/safe/log/main.log');
    showLogFileInFolder(undefined, resolve, shell);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved log file path to showItemInFolder', () => {
    const shell = { showItemInFolder: vi.fn() };
    // Resolved path on Windows-style backslashes — prove we are not
    // coercing the value, only forwarding what the logger reports.
    const resolved = 'C:\\Users\\someone\\AppData\\Roaming\\JellyTunes\\logs\\main.log';
    showLogFileInFolder(undefined, () => resolved, shell);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(resolved);
  });
});
