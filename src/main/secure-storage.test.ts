// src/main/secure-storage.test.ts
// Unit tests for the secure storage provider selector.
//
// ORAIN-0590: replace the boolean guard around Electron's safeStorage with
// a provider interface. On Linux the preferred provider is `secret-tool`
// (libsecret CLI, routed through the Secret portal inside the snap
// sandbox). `safeStorage` is the fallback on Linux and the only provider
// on macOS/Windows. Both expose `encrypt`/`decrypt`.
//
// Stale-blob safety: a session encrypted with the previous safeStorage
// backend cannot be decrypted by the new provider — the load path must
// treat that as "no session", not a crash. This is a separate AC.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isSecureStorageAvailable,
  createSecureStorageProvider,
  type SecureStorageLike,
  type FullSecureStorageLike,
  type SecretStorageLike,
  type StorageProvider,
} from './secure-storage';

describe('isSecureStorageAvailable (legacy boolean guard)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns false when isEncryptionAvailable() is false', () => {
    const storage: SecureStorageLike = {
      isEncryptionAvailable: vi.fn(() => false),
      getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret' as const),
    };

    expect(isSecureStorageAvailable(storage)).toBe(false);
    expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it('returns true on macOS/Windows when isEncryptionAvailable() is true', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const storage: SecureStorageLike = {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => 'unknown' as const),
    };

    expect(isSecureStorageAvailable(storage)).toBe(true);
  });

  it('returns true on Linux with a real keyring backend', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const) {
      const storage: SecureStorageLike = {
        isEncryptionAvailable: vi.fn(() => true),
        getSelectedStorageBackend: vi.fn(() => backend),
      };
      expect(isSecureStorageAvailable(storage)).toBe(true);
    }
  });

  it('returns false on Linux when backend is basic_text', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const storage: SecureStorageLike = {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => 'basic_text' as const),
    };

    expect(isSecureStorageAvailable(storage)).toBe(false);
  });
});

function makeSafeStorage(
  backend: 'gnome_libsecret' | 'basic_text' | 'unknown',
): FullSecureStorageLike {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
  };
}

function makeSecretStorage(available: boolean): SecretStorageLike {
  return {
    isAvailable: vi.fn().mockResolvedValue(available),
    store: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createSecureStorageProvider (ORAIN-0590 selector)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('Linux branch', () => {
    it('returns null when neither secret-tool nor safeStorage is usable', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const result = createSecureStorageProvider({
        secretStore: makeSecretStorage(false),
        safeStorage: makeSafeStorage('basic_text'),
        secretToolAvailable: false,
      });
      expect(result).toBeNull();
    });

    it('prefers secret-tool when available (even with a working safeStorage)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const secretStore = makeSecretStorage(true);
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const result = createSecureStorageProvider({
        secretStore,
        safeStorage,
        secretToolAvailable: true,
      });

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('secret-tool');
      await result!.encrypt('hello');
      expect(secretStore.store).toHaveBeenCalledWith('hello');
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('falls back to safeStorage when secret-tool reports unavailable', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const result = createSecureStorageProvider({
        secretStore: makeSecretStorage(false),
        safeStorage,
        secretToolAvailable: false,
      });

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('safeStorage');
    });

    it('encrypts via safeStorage when selected', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const provider = createSecureStorageProvider({
        secretStore: makeSecretStorage(false),
        safeStorage,
        secretToolAvailable: false,
      }) as StorageProvider;

      expect(provider.kind).toBe('safeStorage');
      await provider.encrypt('plaintext');
      expect(safeStorage.encryptString).toHaveBeenCalledWith('plaintext');
    });

    it('treats a missing secretToolAvailable as false (does not trust unprobed wrapper)', () => {
      // Guards against a regression where the cached boolean is implicitly
      // truthy — that would have us select secret-tool without ever having
      // proved it reachable.
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const result = createSecureStorageProvider({
        secretStore: makeSecretStorage(true),
        safeStorage,
      });
      expect(result!.kind).toBe('safeStorage');
    });
  });

  describe('macOS/Windows branch', () => {
    it('always returns safeStorage when isEncryptionAvailable() is true', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const safeStorage = makeSafeStorage('unknown');
      const secretStore = makeSecretStorage(true); // ignored on macOS
      const provider = createSecureStorageProvider({ secretStore, safeStorage });

      expect(provider).not.toBeNull();
      expect(provider!.kind).toBe('safeStorage');
      // secret-tool is not consulted on macOS — saves a probe
      expect(secretStore.isAvailable).not.toHaveBeenCalled();
    });

    it('returns null on Windows when safeStorage is unavailable', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const safeStorage: FullSecureStorageLike = {
        isEncryptionAvailable: vi.fn(() => false),
        getSelectedStorageBackend: vi.fn(() => 'unknown' as const),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      };
      const result = createSecureStorageProvider({
        secretStore: makeSecretStorage(true),
        safeStorage,
      });
      expect(result).toBeNull();
    });
  });

  describe('stale-blob safety (encrypted with previous safeStorage backend)', () => {
    it('a lookup failure from secret-tool is treated as null, not thrown', async () => {
      // ORAIN-0590 AC: "A previous session encrypted with safeStorage does not
      // break the app. A decryption failure is treated as 'no session'."
      // When secret-tool is the active provider and a previously stored
      // safeStorage blob exists on disk, the load path will see null from
      // lookup() (exit 1 / corrupted) and must not throw.
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const secretStore: SecretStorageLike = {
        isAvailable: vi.fn().mockResolvedValue(true),
        store: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null), // stale blob → no entry
        clear: vi.fn().mockResolvedValue(undefined),
      };
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const provider = createSecureStorageProvider({
        secretStore,
        safeStorage,
        secretToolAvailable: true,
      }) as StorageProvider;

      expect(provider.kind).toBe('secret-tool');
      await expect(provider.decrypt(Buffer.from('stale-blob'))).resolves.toBeNull();
      expect(secretStore.lookup).toHaveBeenCalled();
      // We never ask safeStorage — secret-tool owns the read path.
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
    });

    it('a safeStorage decrypt failure is also treated as null (Linux fallback)', async () => {
      // If both providers ever coexist on Linux and the active one is
      // safeStorage, an unreadable blob must still result in null.
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const secretStore = makeSecretStorage(false);
      const safeStorage: FullSecureStorageLike = {
        isEncryptionAvailable: vi.fn(() => true),
        getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret' as const),
        encryptString: vi.fn((s: string) => Buffer.from(s)),
        decryptString: vi.fn(() => {
          throw new Error('wrong backend');
        }),
      };
      const provider = createSecureStorageProvider({
        secretStore,
        safeStorage,
        secretToolAvailable: false,
      }) as StorageProvider;

      expect(provider.kind).toBe('safeStorage');
      await expect(provider.decrypt(Buffer.from('stale'))).resolves.toBeNull();
    });
  });

  describe('provider interface symmetry', () => {
    it('both providers expose encrypt and decrypt', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const secretProvider = createSecureStorageProvider({
        secretStore: makeSecretStorage(true),
        safeStorage: makeSafeStorage('gnome_libsecret'),
        secretToolAvailable: true,
      });
      expect(typeof secretProvider!.encrypt).toBe('function');
      expect(typeof secretProvider!.decrypt).toBe('function');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      const safeProvider = createSecureStorageProvider({
        secretStore: makeSecretStorage(false),
        safeStorage: makeSafeStorage('gnome_libsecret'),
        secretToolAvailable: false,
      });
      expect(typeof safeProvider!.encrypt).toBe('function');
      expect(typeof safeProvider!.decrypt).toBe('function');
    });

    it('encrypt returns a Buffer that decrypt can round-trip', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const secretStore: SecretStorageLike = {
        isAvailable: vi.fn().mockResolvedValue(true),
        store: vi.fn(async (s: string) => {
          // Echo the secret as the "stored" value, so lookup returns it.
          (secretStore.lookup as ReturnType<typeof vi.fn>).mockResolvedValue(s);
        }),
        lookup: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue(undefined),
      };
      const safeStorage = makeSafeStorage('gnome_libsecret');
      const provider = createSecureStorageProvider({
        secretStore,
        safeStorage,
        secretToolAvailable: true,
      }) as StorageProvider;

      await provider.encrypt('round-trip');
      const recovered = await provider.decrypt(Buffer.from('any'));
      expect(recovered).toBe('round-trip');
    });
  });
});
