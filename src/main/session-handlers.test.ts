// src/main/session-handlers.test.ts
//
// ORAIN-0564 SO-2: the session handler contract is shape-agnostic.
// The renderer's saveSession/loadSession already JSON.stringifies a
// discriminated payload ({authKind:'apikey'|'password', url, ...}).
// The main-process side must:
//   1. round-trip both shapes through encrypt+write / read+decrypt
//   2. never log the plaintext (the password must never reach disk
//      in the first place — the renderer strips it; the main process
//      is responsible for not echoing it either way)
//   3. return {success:false, reason:'encryption_unavailable'} when
//      the provider is null
//   4. return null from load when no file exists
//   5. clear stale blobs (provider can't decrypt) and return null
//
// The handlers are extracted into pure functions (saveSession, loadSession,
// clearSession) so they can be exercised here without booting Electron.
// The IPC layer in `src/main/index.ts` is a thin wrapper that calls them.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveSession,
  loadSession,
  clearSession,
  type SessionFs,
  type SessionLogger,
} from './session-handlers';
import type { StorageProvider } from './secure-storage';

// Trivial XOR-based "encryption" so the on-disk bytes never contain the
// plaintext. A test mock that just prepends "enc:" leaks the plaintext
// into the on-disk check, which is the wrong thing to assert — the
// handler contract is "delegate to provider.encrypt + write the bytes";
// whether those bytes hide the plaintext is the provider's job. We use
// XOR with a fixed key here so the test exercise is realistic: a
// genuinely opaque blob that round-trips through decrypt.
const TEST_KEY = Buffer.from('jellytunes-test-key-32-bytes-xor0', 'utf8');
function xorTransform(buf: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out;
}

function makeProvider(
  opts: { kind?: 'safeStorage' | 'secret-tool'; failDecrypt?: boolean } = {},
): StorageProvider {
  const kind = opts.kind ?? 'safeStorage';
  if (kind === 'secret-tool') {
    // For these tests we don't need the keyring to actually persist —
    // the marker buffer is what gets written, and the plaintext is
    // recorded so we can hand it back from decrypt.
    let lastPlain: string | null = null;
    return {
      kind: 'secret-tool',
      async encrypt(plaintext: string) {
        lastPlain = plaintext;
        return Buffer.from('secret-tool:v1', 'utf8');
      },
      async decrypt(_buf: Buffer) {
        if (opts.failDecrypt) return null;
        return lastPlain;
      },
    };
  }
  return {
    kind: 'safeStorage',
    async encrypt(plaintext: string) {
      // Real symmetric transform: the on-disk bytes are opaque.
      return xorTransform(Buffer.from(plaintext, 'utf8'), TEST_KEY);
    },
    async decrypt(buf: Buffer) {
      if (opts.failDecrypt) return null;
      return xorTransform(buf, TEST_KEY).toString('utf8');
    },
  };
}

function makeFs(_filePath?: string): SessionFs {
  return {
    existsSync: (p: string) => existsSync(p),
    writeFileSync: (p: string, data: Buffer | string) =>
      writeFileSync(p, typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
    readFileSync: (p: string) => readFileSync(p),
    unlinkSync: (p: string) => {
      try {
        rmSync(p);
      } catch {
        /* best-effort, mirrors production */
      }
    },
  };
}

function makeLogger(): SessionLogger & {
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

describe('session-handlers (ORAIN-0564 SO-2)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jellytunes-session-test-'));
    filePath = join(dir, 'session.enc');
  });

  describe('saveSession', () => {
    it('round-trips an apikey-shaped payload through save -> load', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const plaintext = JSON.stringify({
        authKind: 'apikey',
        url: 'https://jellyfin.test',
        apiKey: 'key-abc',
        userId: 'user-1',
      });

      const save = await saveSession({ provider, filePath, plaintext, fs, log });
      expect(save).toEqual({ success: true });

      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBe(plaintext);
      // The plaintext on disk is whatever the provider returns; it MUST NOT
      // be the raw plaintext (the file is opaque encrypted bytes).
      const onDisk = readFileSync(filePath).toString('utf8');
      expect(onDisk).not.toContain('key-abc');
    });

    it('round-trips a password-shaped payload (accessToken, no password field) through save -> load', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const plaintext = JSON.stringify({
        authKind: 'password',
        url: 'https://jellyfin.test',
        accessToken: 'pw-token-abc',
        userId: 'user-1',
      });

      const save = await saveSession({ provider, filePath, plaintext, fs, log });
      expect(save).toEqual({ success: true });

      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBe(plaintext);
      const onDisk = readFileSync(filePath).toString('utf8');
      expect(onDisk).not.toContain('pw-token-abc');
    });

    it('does NOT log the plaintext (apikey)', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const plaintext = JSON.stringify({
        authKind: 'apikey',
        url: 'https://jellyfin.test',
        apiKey: 'super-secret-key-xyz',
        userId: 'user-1',
      });

      await saveSession({ provider, filePath, plaintext, fs, log });
      // After the call, none of the logger methods should have been called
      // with the plaintext, the apiKey, or the full payload.
      const allCalls = [
        ...log.error.mock.calls,
        ...log.warn.mock.calls,
        ...log.info.mock.calls,
      ].flat();
      for (const arg of allCalls) {
        const s = String(arg);
        expect(s).not.toContain('super-secret-key-xyz');
        expect(s).not.toContain(plaintext);
      }
    });

    it('does NOT log the plaintext (password shape)', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const plaintext = JSON.stringify({
        authKind: 'password',
        url: 'https://jellyfin.test',
        accessToken: 'token-shhh-123',
        userId: 'user-1',
      });

      await saveSession({ provider, filePath, plaintext, fs, log });
      const allCalls = [
        ...log.error.mock.calls,
        ...log.warn.mock.calls,
        ...log.info.mock.calls,
      ].flat();
      for (const arg of allCalls) {
        const s = String(arg);
        expect(s).not.toContain('token-shhh-123');
        expect(s).not.toContain(plaintext);
      }
    });

    it('if a payload contains a "password" field, the encrypted round-trip preserves it (proves the responsibility to strip lives in the renderer, not main)', async () => {
      // Defensive contract test: a malformed payload that contains a
      // `password` field still gets persisted as opaque bytes. The
      // responsibility to never include a password in the payload
      // belongs to the renderer (SO-1 strips it before save). The main
      // process is intentionally agnostic to the shape and must not
      // echo the plaintext either.
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const plaintext = JSON.stringify({
        authKind: 'password',
        url: 'https://jellyfin.test',
        accessToken: 'token-123',
        userId: 'user-1',
        password: 'should-not-be-here-but-if-it-is-main-does-not-strip-it',
      });

      const save = await saveSession({ provider, filePath, plaintext, fs, log });
      expect(save).toEqual({ success: true });

      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBe(plaintext);

      // Plaintext does not appear on disk; only the encrypted bytes.
      const onDisk = readFileSync(filePath).toString('utf8');
      expect(onDisk).not.toContain('should-not-be-here-but-if-it-is-main-does-not-strip-it');
    });

    it('returns {success:false, reason:"encryption_unavailable"} when provider is null', async () => {
      const fs = makeFs(filePath);
      const log = makeLogger();
      const result = await saveSession({
        provider: null,
        filePath,
        plaintext: 'whatever',
        fs,
        log,
      });
      expect(result).toEqual({ success: false, reason: 'encryption_unavailable' });
      // No file should be written.
      expect(existsSync(filePath)).toBe(false);
    });

    it('returns {success:false, reason:"storage_error"} when fs.writeFileSync throws', async () => {
      const provider = makeProvider();
      const brokenFs: SessionFs = {
        ...makeFs(filePath),
        writeFileSync: vi.fn(() => {
          throw new Error('disk full');
        }),
      };
      const log = makeLogger();
      const result = await saveSession({
        provider,
        filePath,
        plaintext: 'x',
        fs: brokenFs,
        log,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('storage_error');
      } else {
        throw new Error('expected save to fail');
      }
    });
  });

  describe('loadSession', () => {
    it('returns null when no file exists', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBeNull();
    });

    it('returns null when no provider is available', async () => {
      const fs = makeFs(filePath);
      const log = makeLogger();
      const loaded = await loadSession({
        provider: null,
        filePath,
        fs,
        log,
      });
      expect(loaded).toBeNull();
    });

    it('clears a stale blob (provider cannot decrypt) and returns null', async () => {
      // First write a file by saving with a working provider.
      const writer = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      await saveSession({
        provider: writer,
        filePath,
        plaintext: 'whatever',
        fs,
        log,
      });
      expect(existsSync(filePath)).toBe(true);

      // Then try to load with a provider that can't decrypt it.
      const failingReader = makeProvider({ failDecrypt: true });
      const loaded = await loadSession({
        provider: failingReader,
        filePath,
        fs,
        log,
      });
      expect(loaded).toBeNull();
      // The stale file should be unlinked.
      expect(existsSync(filePath)).toBe(false);
    });

    it('returns the saved plaintext for both apikey and password shapes', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();

      const apikeyPlain = JSON.stringify({
        authKind: 'apikey',
        url: 'https://jellyfin.test',
        apiKey: 'k1',
        userId: 'u1',
      });
      await saveSession({ provider, filePath, plaintext: apikeyPlain, fs, log });
      expect(await loadSession({ provider, filePath, fs, log })).toBe(apikeyPlain);

      // Overwrite with a password shape.
      const pwPlain = JSON.stringify({
        authKind: 'password',
        url: 'https://jellyfin.test',
        accessToken: 't1',
        userId: 'u1',
      });
      await saveSession({ provider, filePath, plaintext: pwPlain, fs, log });
      expect(await loadSession({ provider, filePath, fs, log })).toBe(pwPlain);
    });
  });

  describe('clearSession', () => {
    it('removes the file when it exists', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();
      await saveSession({ provider, filePath, plaintext: 'x', fs, log });
      expect(existsSync(filePath)).toBe(true);
      await clearSession({ provider, filePath, fs, log });
      expect(existsSync(filePath)).toBe(false);
    });

    it('is a no-op when the file does not exist (no throw)', async () => {
      const fs = makeFs(filePath);
      const log = makeLogger();
      await expect(clearSession({ provider: null, filePath, fs, log })).resolves.not.toThrow();
    });

    // ORAIN-0706 HIGH-2: httpConfirmedHosts must survive clearSession/logout.
    it('preserves httpConfirmedHosts when clearing a session (ORAIN-0706)', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();

      // Pre-populate the file with a full session + httpConfirmedHosts.
      await saveSession({
        provider,
        filePath,
        plaintext: JSON.stringify({
          authKind: 'apikey',
          url: 'https://jellyfin.test',
          apiKey: 'k1',
          userId: 'u1',
          httpConfirmedHosts: { 'jellyfin.example.com:80': true },
        }),
        fs,
        log,
      });
      expect(existsSync(filePath)).toBe(true);

      await clearSession({ provider, filePath, fs, log });

      // File still exists (not unlinked).
      expect(existsSync(filePath)).toBe(true);
      // The stub on disk contains only httpConfirmedHosts.
      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBe(
        JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:80': true } }),
      );
      // No credential fields.
      const parsed = JSON.parse(loaded!);
      expect(parsed).not.toHaveProperty('authKind');
      expect(parsed).not.toHaveProperty('url');
      expect(parsed).not.toHaveProperty('apiKey');
      expect(parsed).not.toHaveProperty('accessToken');
      expect(parsed).not.toHaveProperty('userId');
    });

    it('httpConfirmedHosts survives clearSession even when no other session fields exist', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();

      // File already contains only httpConfirmedHosts (already cleared once).
      await saveSession({
        provider,
        filePath,
        plaintext: JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:80': true } }),
        fs,
        log,
      });

      await clearSession({ provider, filePath, fs, log });

      const loaded = await loadSession({ provider, filePath, fs, log });
      expect(loaded).toBe(
        JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:80': true } }),
      );
    });

    it('httpConfirmedHosts absent from stub when it was absent from session (fail-open for map)', async () => {
      const provider = makeProvider();
      const fs = makeFs(filePath);
      const log = makeLogger();

      // Session without httpConfirmedHosts.
      await saveSession({
        provider,
        filePath,
        plaintext: JSON.stringify({
          authKind: 'apikey',
          url: 'https://jellyfin.test',
          apiKey: 'k1',
          userId: 'u1',
        }),
        fs,
        log,
      });

      await clearSession({ provider, filePath, fs, log });

      const loaded = await loadSession({ provider, filePath, fs, log });
      // Stub with no fields is valid — user will be prompted again, which is the
      // correct fail-open behaviour (no worse than before the feature existed).
      expect(loaded).toBe('{}');
    });

    it('unlinks outright when provider is null (no storage to protect)', async () => {
      const fs = makeFs(filePath);
      const log = makeLogger();
      await saveSession({ provider: null, filePath, plaintext: 'x', fs, log });
      // With null provider saveSession doesn't write anything.
      // Write manually to set up the test.
      writeFileSync(filePath, 'x');
      expect(existsSync(filePath)).toBe(true);
      await clearSession({ provider: null, filePath, fs, log });
      expect(existsSync(filePath)).toBe(false);
    });
  });
});
