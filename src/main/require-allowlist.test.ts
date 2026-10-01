// ORAIN-0763 AC2: regression guard against dynamic `require()` calls in
// production source. The bundling model (electron-vite → Rollup → single
// `dist/main/index.js`) only rewrites static `import` statements; raw
// `require()` survives and resolves against the wrong module graph at
// runtime, which is how ORAIN-0614 and now ORAIN-0763 broke packaged
// builds. This scan enforces an allowlist — every `require()` in
// `src/main` and `src/sync` must either be a Node built-in or one of the
// ffmpeg-installer packages (whose optional native binaries we resolve
// manually in `index.ts`).

import { readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

/**
 * Modules the production code is allowed to `require()` directly. Built-ins
 * are listed explicitly so a typo (e.g. `requrie('node:fs')`) still fails.
 *
 * Why these are allowed and nothing else:
 * - `node:` built-ins: bundling them as static imports is fine, but the
 *   codebase already uses `require('child_process')` / `require('fs')` in
 *   a few CJS-flavoured spots. Listed explicitly so we can spot drift.
 * - `@ffmpeg-installer/*` and `@ffprobe-installer/*`: their native binaries
 *   are unpacked via `electron-builder` (`asarUnpack` in package.json),
 *   so the package main resolves at runtime in packaged builds. We
 *   intentionally do NOT list `electron-log` — see ORAIN-0614.
 */
const ALLOWED = new Set<string>([
  // Node built-ins (no `node:` prefix; the existing call sites omit it).
  'child_process',
  'fs',
  'fs/promises',
  'path',
  'stream',
  'crypto',
  'os',
  'util',
  'url',
  'events',
  // FFmpeg / FFprobe binaries — optional native deps resolved via
  // electron-builder `asarUnpack`.
  '@ffmpeg-installer/ffmpeg',
  '@ffmpeg-installer/darwin-arm64',
  '@ffmpeg-installer/darwin-x64',
  '@ffmpeg-installer/linux-arm',
  '@ffmpeg-installer/linux-x64',
  '@ffmpeg-installer/linux-ia32',
  '@ffmpeg-installer/win32-ia32',
  '@ffmpeg-installer/win32-x64',
  '@ffprobe-installer/ffprobe',
]);

/**
 * Recursively collect every `*.ts` file under `root` except tests. The
 * guard runs against production source only — test files legitimately
 * use `require()` for mocks and dynamic imports of the same module.
 */
function walkTs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find every `require(...)` call in a source file. Matches the opening
 * `require(` plus the first balanced argument. Tolerates single and
 * double quotes; ignores `require` inside identifiers, comments, and
 * string literals that don't look like a function call.
 *
 * Why we don't use an AST: the suite must run without compiling the
 * project, and a regex keeps the dependency surface zero. We do
 * pre-filter with a stricter pattern (`require(` not preceded by a
 * word char) to skip `foo.require(` and `// require(`.
 *
 * Comments are stripped first so a `// require('foo')` in an explanatory
 * block (e.g. ORAIN-0614's note about the old dynamic require) doesn't
 * trip the guard.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const nx = source[i + 1];
    if (ch === '/' && nx === '/') {
      // Line comment — skip to newline.
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && nx === '*') {
      // Block comment — skip to close.
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // String literal — copy verbatim, respecting escapes.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i]!;
          i += 1;
          if (i < source.length) {
            out += source[i]!;
            i += 1;
          }
        } else {
          out += source[i]!;
          i += 1;
        }
      }
      if (i < source.length) {
        out += source[i]!;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function findRequires(source: string): Array<{ line: number; argument: string }> {
  const cleaned = stripComments(source);
  const hits: Array<{ line: number; argument: string }> = [];
  const re = /(?<![A-Za-z0-9_$.])require\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const start = m.index + m[0].length;
    // Walk to the matching close-paren, tracking quote state.
    let i = start;
    let quote: '"' | "'" | null = null;
    while (i < cleaned.length) {
      const ch = cleaned[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch as '"' | "'";
      } else if (ch === ')') {
        break;
      }
      i += 1;
    }
    const argument = cleaned.slice(start, i).trim();
    hits.push({ line: lineOf(source, m.index), argument });
  }
  return hits;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

describe('ORAIN-0763 AC2 — require() allowlist guard for src/main and src/sync', () => {
  const repoRoot = join(__dirname, '..', '..');
  const dirs = [join(repoRoot, 'src', 'main'), join(repoRoot, 'src', 'sync')];
  const files = dirs.flatMap((d) => {
    try {
      return walkTs(d);
    } catch {
      return [];
    }
  });

  it('every require() call in production source is on the allowlist', () => {
    const violations: Array<{ file: string; line: number; argument: string }> = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const reqs = findRequires(source);
      for (const r of reqs) {
        // Strip quotes from the argument for the lookup.
        const arg = r.argument.replace(/^['"]|['"]$/g, '');
        if (!ALLOWED.has(arg)) {
          violations.push({ file, line: r.line, argument: r.argument });
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}:${v.line}  require(${v.argument})`)
        .join('\n');
      throw new Error(
        `Forbidden require() calls in production source (add to ALLOWED or replace with a static import):\n${formatted}\n` +
          `Allowed: ${[...ALLOWED].join(', ')}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('allowlist is non-empty so a typo in ALLOWED does not silently pass', () => {
    // Self-check: if a future contributor wipes ALLOWED, the previous test
    // would pass trivially. This test pins the presence of the canonical
    // modules we expect to keep using.
    expect(ALLOWED.has('electron-log')).toBe(false);
    expect(ALLOWED.has('@ffmpeg-installer/ffmpeg')).toBe(true);
    expect(ALLOWED.has('child_process')).toBe(true);
    expect(ALLOWED.size).toBeGreaterThanOrEqual(8);
  });
});
