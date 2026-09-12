// src/main/session-handlers.ts
//
// ORAIN-0564 SO-2: extract the encrypted session storage logic out of
// `src/main/index.ts` so the contract is unit-testable without booting
// Electron.
//
// The IPC handlers in `index.ts` are thin wrappers: they construct the
// `fs` and `log` adapters (the only Electron-aware pieces) and call
// these pure functions. All the shape-agnostic work — encrypt, write,
// read, decrypt, stale-blob cleanup, error reporting — lives here.
//
// The contract is intentionally agnostic to the payload shape. The
// renderer is responsible for never including the password in the
// plaintext (SO-1 strips it before calling `session:save`). The main
// process MUST NOT log the plaintext either, and the on-disk file
// MUST be the bytes the provider returned, not the raw plaintext.

import type { StorageProvider } from './secure-storage';

/** Narrow fs surface these handlers need — injected for testability. */
export interface SessionFs {
  existsSync(p: string): boolean;
  writeFileSync(p: string, data: Buffer | string): void;
  readFileSync(p: string): Buffer;
  unlinkSync(p: string): void;
}

/** Narrow logger surface — `electron-log` satisfies this. */
export interface SessionLogger {
  error(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
}

export type SaveSessionResult =
  | { success: true }
  | { success: false; reason: 'encryption_unavailable' | 'storage_error' };

export interface SaveSessionInput {
  provider: StorageProvider | null;
  filePath: string;
  plaintext: string;
  fs: SessionFs;
  log: SessionLogger;
}

export interface LoadSessionInput {
  provider: StorageProvider | null;
  filePath: string;
  fs: SessionFs;
  log: SessionLogger;
}

export interface ClearSessionInput {
  provider: StorageProvider | null;
  filePath: string;
  fs: SessionFs;
  log: SessionLogger;
}

/**
 * Encrypt `plaintext` and write the resulting bytes to `filePath`.
 *
 * On success returns `{success: true}`. When no provider is available
 * (the boot-time probe found no OS keyring) returns
 * `{success: false, reason: 'encryption_unavailable'}` so the renderer
 * can surface the no-persistence banner (ORAIN-0590 AC).
 *
 * The function never logs `plaintext` — a strict property asserted by
 * `session-handlers.test.ts`.
 */
export async function saveSession(input: SaveSessionInput): Promise<SaveSessionResult> {
  if (!input.provider) {
    return { success: false, reason: 'encryption_unavailable' };
  }
  try {
    const encrypted = await input.provider.encrypt(input.plaintext);
    input.fs.writeFileSync(input.filePath, encrypted);
    return { success: true };
  } catch (e) {
    input.log.error('Failed to save session:', e);
    return { success: false, reason: 'storage_error' };
  }
}

/**
 * Read the encrypted file, decrypt it, and return the original
 * plaintext. Returns `null` when:
 *   - no provider is available,
 *   - the file does not exist (no session),
 *   - the active provider can't decrypt the on-disk blob (stale,
 *     e.g. backend switched from safeStorage to secret-tool between
 *     runs). In that case the file is best-effort unlinked so the
 *     user doesn't get stuck in a loop.
 *
 * Never throws.
 */
export async function loadSession(input: LoadSessionInput): Promise<string | null> {
  if (!input.provider) {
    return null;
  }
  try {
    if (!input.fs.existsSync(input.filePath)) return null;
    const raw = input.fs.readFileSync(input.filePath);
    const decrypted = await input.provider.decrypt(raw);
    if (decrypted === null && raw.length > 0) {
      input.log.warn('Session file present but unreadable by active provider; clearing');
      try {
        input.fs.unlinkSync(input.filePath);
      } catch {
        /* best effort */
      }
    }
    return decrypted;
  } catch (err) {
    input.log.error('Failed to load session:', err);
    return null;
  }
}

/**
 * ORAIN-0706: clears session credentials from the encrypted file but preserves
 * `httpConfirmedHosts` so that HTTP confirmation survives logout/clearSession.
 *
 * Strategy: read the existing blob → strip credential fields → re-encrypt and
 * write back.  When no provider is available the file is unlinked outright
 * (AC9 doesn't apply — there is no persistent storage to protect).
 *
 * Errors are logged but not surfaced — the renderer never awaits a meaningful
 * return value.
 */
export async function clearSession(input: ClearSessionInput): Promise<void> {
  try {
    if (!input.fs.existsSync(input.filePath)) return;

    if (!input.provider) {
      // No encryption available — nothing to protect; unlink the file.
      input.fs.unlinkSync(input.filePath);
      return;
    }

    // Read and decrypt the existing blob.
    const raw = input.fs.readFileSync(input.filePath);
    const plaintext = await input.provider.decrypt(raw);
    if (plaintext === null) {
      // Unreadable blob — unlink to avoid leaving a stuck file.
      input.fs.unlinkSync(input.filePath);
      return;
    }

    // Strip credential fields while preserving httpConfirmedHosts.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      // Corrupt JSON — unlink to avoid carrying forward bad data.
      input.fs.unlinkSync(input.filePath);
      return;
    }

    const httpConfirmedHosts = parsed.httpConfirmedHosts;

    // Build a minimal stub. httpConfirmedHosts survives; everything else is gone.
    const stub: Record<string, unknown> = {};
    if (
      httpConfirmedHosts &&
      typeof httpConfirmedHosts === 'object' &&
      !Array.isArray(httpConfirmedHosts)
    ) {
      stub.httpConfirmedHosts = httpConfirmedHosts;
    }
    // If httpConfirmedHosts is absent or corrupt, the stub is empty — fail-open
    // for the confirmation map so the user is prompted again (not worse than
    // before the feature existed).

    const stubPlaintext = JSON.stringify(stub);
    const encrypted = await input.provider.encrypt(stubPlaintext);
    input.fs.writeFileSync(input.filePath, encrypted);
  } catch (err) {
    input.log.error('Failed to clear session:', err);
  }
}
