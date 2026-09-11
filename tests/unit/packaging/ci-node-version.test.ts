import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Electron 44 empotra Node 24 (ABI de Electron 149). Si CI instala
 * Node 20, los módulos nativos (better-sqlite3, usb-detection) se compilan
 * contra el ABI equivocado. El fallo es silencioso: device-watcher.ts cae a
 * polling sin romper el build.
 */
const EXPECTED_NODE_VERSION = "node-version: '24'";
const STALE_NODE_VERSION = "node-version: '20'";

const WORKFLOWS: readonly string[] = [
  '.github/workflows/checks.yml',
  '.github/workflows/build-test.yml',
  '.github/workflows/release.yml',
];

describe('Versión de Node en CI', () => {
  it.each(WORKFLOWS)('%s instala el Node del runtime de Electron', (workflowPath) => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain(EXPECTED_NODE_VERSION);
    expect(workflow).not.toContain(STALE_NODE_VERSION);
  });
});
