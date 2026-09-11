import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Electron 44 empotra Node 24 (ABI de Electron 149). Si CI instala
 * Node 20, los módulos nativos (better-sqlite3, usb-detection) se compilan
 * contra el ABI equivocado. El fallo es silencioso: device-watcher.ts cae a
 * polling sin romper el build.
 */
const EXPECTED_MAJOR = '24';
const STALE_MAJOR = '20';

// Acepta las tres formas válidas en YAML: '24', "24" y 24 (sin comillas).
const expectedPattern = new RegExp(`node-version:\\s*['"]?${EXPECTED_MAJOR}['"]?\\s*$`, 'm');
const stalePattern = new RegExp(`node-version:\\s*['"]?${STALE_MAJOR}['"]?\\s*$`, 'm');

const workflowsDir = join('.github', 'workflows');
const workflowsUsingSetupNode = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => join(workflowsDir, file))
  .filter((filePath) => readFileSync(filePath, 'utf8').includes('actions/setup-node'));

describe('Versión de Node en CI', () => {
  it('encuentra al menos un workflow que use actions/setup-node', () => {
    expect(workflowsUsingSetupNode.length).toBeGreaterThan(0);
  });

  it.each(workflowsUsingSetupNode)('%s instala el Node del runtime de Electron', (workflowPath) => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toMatch(expectedPattern);
    expect(workflow).not.toMatch(stalePattern);
  });
});
