import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Electron 44 embeds Node 24 (Electron 149 ABI). If CI installs Node 20,
 * native modules (better-sqlite3, usb-detection) get compiled against the
 * wrong ABI. The failure is silent: device-watcher.ts falls back to polling
 * without breaking the build.
 */
const EXPECTED_MAJOR = '24';
const STALE_MAJOR = '20';

// Accepts all three valid YAML forms: '24', "24" and 24 (without quotes).
const expectedPattern = new RegExp(`node-version:\\s*['"]?${EXPECTED_MAJOR}['"]?\\s*$`, 'm');
const stalePattern = new RegExp(`node-version:\\s*['"]?${STALE_MAJOR}['"]?\\s*$`, 'm');

const workflowsDir = join('.github', 'workflows');
const workflowsUsingSetupNode = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => join(workflowsDir, file))
  .filter((filePath) => readFileSync(filePath, 'utf8').includes('actions/setup-node'));

describe('CI Node version', () => {
  it('finds at least one workflow that uses actions/setup-node', () => {
    expect(workflowsUsingSetupNode.length).toBeGreaterThan(0);
  });

  it.each(workflowsUsingSetupNode)('%s installs the Node runtime of Electron', (workflowPath) => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toMatch(expectedPattern);
    expect(workflow).not.toMatch(stalePattern);
  });
});
