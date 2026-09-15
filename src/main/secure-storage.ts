/**
 * Provider selector for OS-backed encrypted session storage.
 *
 * ORAIN-0590: replace the boolean guard around Electron's `safeStorage`
 * with a small provider interface. Two providers exist, both exposing
 * `encrypt`/`decrypt` over `Buffer`:
 *
 *   - **secret-tool** (preferred on Linux). libsecret CLI. The design
 *     intent is that libsecret detects the sandbox and routes through the
 *     Secret portal, which AppArmor permits without the
 *     `password-manager-service` plug (that interface is removed from the
 *     snap entirely).
 *
 *     ORAIN-0615 — STATUS: UNVERIFIED under real Snap confinement. Until
 *     ORAIN-0601 this selector never even reached a subprocess: the adapter
 *     threw on `isAvailable()` before spawning, so the probe returned false
 *     on EVERY Linux install and this branch was dead code. That bug is
 *     fixed, but "the portal path works" remains an untested claim — see
 *     the header of `secret-store.ts`. Do not restate it as fact here.
 *
 *   - **safeStorage** (everywhere else, plus Linux fallback). Electron's
 *     built-in, backed by macOS Keychain / Windows DPAPI / libsecret
 *     reachable on non-snap Linux installs. Under Snap strict confinement
 *     this is still blocked, so the selector only picks it on Linux when
 *     `secret-tool` is genuinely unavailable.
 *
 * Stale-blob safety: when the previously-active provider (safeStorage on
 * Snap) produced a blob on disk and the new provider takes over, the
 * load path sees a missing/corrupt entry and returns null rather than
 * throwing. The user is dropped to the login screen — the AC6 contract.
 */

export type LinuxStorageBackend =
  'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';

/**
 * Read-only probe — what the ORAIN-0571 guard needed.
 * Kept separate from the full crypto interface so legacy callers (and
 * tests that only care about availability) don't have to mock the
 * encrypt/decrypt methods.
 */
export interface SecureStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): LinuxStorageBackend;
}

/**
 * Full safeStorage surface — what the safeStorage provider actually needs
 * at runtime. A normal Electron `safeStorage` import satisfies this.
 */
export interface FullSecureStorageLike extends SecureStorageLike {
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}

/**
 * Minimal contract the selector needs from the secret-tool wrapper.
 * Matches `SecretStore` in `secret-store.ts` — kept narrow here so this
 * file has no upstream dependency on the wrapper.
 */
export interface SecretStorageLike {
  isAvailable(): Promise<boolean>;
  store(secret: string): Promise<void>;
  lookup(): Promise<string | null>;
  clear(): Promise<void>;
}

/** Linux backends backed by a real OS/desktop keyring. */
const SECURE_LINUX_BACKENDS = new Set<LinuxStorageBackend>([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

/**
 * Legacy boolean guard (ORAIN-0571). Kept exported for any caller that
 * still wants a yes/no answer — `createSecureStorageProvider` is the
 * preferred entry point now.
 */
export function isSecureStorageAvailable(storage: SecureStorageLike): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  return SECURE_LINUX_BACKENDS.has(storage.getSelectedStorageBackend());
}

export interface StorageProvider {
  /** Identifier for diagnostics and tests. */
  readonly kind: 'secret-tool' | 'safeStorage';
  encrypt(plaintext: string): Promise<Buffer>;
  /**
   * Returns the plaintext on success, or null when the stored blob cannot
   * be read with the active provider (missing entry, wrong backend, etc).
   * Never throws on stale-blob mismatches — that would crash the renderer.
   */
  decrypt(buf: Buffer): Promise<string | null>;
}

export interface SelectProviderInput {
  secretStore: SecretStorageLike;
  safeStorage: FullSecureStorageLike;
  /**
   * Result of `await secretStore.isAvailable()` resolved once at startup.
   * Required on Linux (where the selector has to pick a provider
   * synchronously) — omitted values are treated as `false`, which routes
   * the call to safeStorage just like an unreachable binary.
   */
  secretToolAvailable?: boolean;
}

/**
 * Build the provider that should handle `session:save` / `session:load`.
 *
 * Selection rules:
 *   - On macOS / Windows → `safeStorage` (no probe of secret-tool, since
 *     libsecret is not the primary keyring on those platforms).
 *   - On Linux → use the cached availability of `secret-tool`. When the
 *     cache says reachable, prefer secret-tool. Otherwise fall back to
 *     safeStorage when backed by a real keyring (libsecret/kwallet,
 *     not basic_text).
 *   - Otherwise → null. The IPC handler returns `encryption_unavailable`
 *     and the renderer shows the no-persistence banner (ORAIN-0590 AC).
 *
 * The probe is async but the selector is sync — callers must `await`
 * `secretStore.isAvailable()` once at startup and pass the result in
 * `secretToolAvailable`. This keeps the selector itself trivially
 * testable and synchronous, and avoids mutating the store to glue the
 * cached value onto a third-party wrapper.
 */
export function createSecureStorageProvider(input: SelectProviderInput): StorageProvider | null {
  const { safeStorage } = input;

  if (process.platform !== 'linux') {
    return safeStorage.isEncryptionAvailable() ? makeSafeStorageProvider(safeStorage) : null;
  }

  return pickLinuxProvider(input);
}

/**
 * The synchronous Linux decision. Production callers should pre-await
 * `secretStore.isAvailable()` and pass the boolean via `secretToolAvailable`.
 */
function pickLinuxProvider(input: SelectProviderInput): StorageProvider | null {
  const { secretStore, safeStorage } = input;

  if (input.secretToolAvailable === true) {
    return makeSecretToolProvider(secretStore);
  }

  // Fallback: safeStorage only counts when it has a real keyring behind it.
  if (isSecureStorageAvailable(safeStorage)) {
    return makeSafeStorageProvider(safeStorage);
  }

  return null;
}

function makeSecretToolProvider(store: SecretStorageLike): StorageProvider {
  return {
    kind: 'secret-tool',
    async encrypt(plaintext: string): Promise<Buffer> {
      // libsecret owns the encryption; we hand the plaintext to the
      // wrapper, which pipes it over stdin. The "encrypted" buffer we
      // return is the lookup result — by the time `encrypt` resolves,
      // the value is in the keyring. session.enc on disk records only
      // the marker that triggers `lookup` at load time.
      await store.store(plaintext);
      // Sentinel: a non-empty marker so the load path knows there is
      // something to read. Real ciphertext never leaves the keyring.
      return Buffer.from('secret-tool:v1', 'utf8');
    },
    async decrypt(_buf: Buffer): Promise<string | null> {
      try {
        return await store.lookup();
      } catch {
        // Stale blob / corrupt entry / wrong backend — treat as no session.
        return null;
      }
    },
  };
}

function makeSafeStorageProvider(storage: FullSecureStorageLike): StorageProvider {
  return {
    kind: 'safeStorage',
    async encrypt(plaintext: string): Promise<Buffer> {
      return storage.encryptString(plaintext);
    },
    async decrypt(buf: Buffer): Promise<string | null> {
      try {
        return storage.decryptString(buf);
      } catch {
        // Stale-blob safety: a previous safeStorage backend encrypted
        // this blob and the new one can't read it. Drop to login.
        return null;
      }
    },
  };
}
