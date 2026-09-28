import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Configuration guardian, not behaviour guardian: the real proof that the
 * sandbox works is the E2E suite, which launches the binary with
 * `_electron.launch`. This test keeps anyone from silently reverting the
 * hardening.
 */
const mainSource = readFileSync('src/main/index.ts', 'utf8');
const viteConfig = readFileSync('electron.vite.config.ts', 'utf8');

/**
 * Extracts the body of a top-level `<key>: { ... }` block in the
 * configuration object, counting braces so it does not stop at the first
 * nested `}`. Throws if the key does not appear.
 */
const extractBlock = (source: string, key: string): string => {
  const keyPattern = new RegExp(`\\b${key}\\s*:\\s*{`);
  const match = keyPattern.exec(source);
  if (match === null) {
    throw new Error(`Block "${key}" not found in electron.vite.config.ts`);
  }

  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Block "${key}" not closed in electron.vite.config.ts`);
};

const preloadBlock = extractBlock(viteConfig, 'preload');
const mainBlock = extractBlock(viteConfig, 'main');

describe('Renderer hardening', () => {
  it('enables the OS sandbox', () => {
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).not.toContain('sandbox: false');
  });

  it('keeps contextIsolation and nodeIntegration hardened', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
  });

  // Covers: that the externalisation exclusion of @electron-toolkit/preload
  // lives in the `preload:` block (not in `main:`, where it would have no
  // effect on the preload bundle). Does NOT cover: an electron-vite bump that
  // renames or restructures the option without moving text — only the E2E
  // detects that, since it launches the real binary and checks `window.api`.
  it('bundles the preload toolkit so a sandboxed preload can resolve it', () => {
    expect(preloadBlock).toContain("exclude: ['@electron-toolkit/preload']");
    expect(mainBlock).not.toContain("exclude: ['@electron-toolkit/preload']");
  });
});
