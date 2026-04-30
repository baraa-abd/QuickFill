import type {
  AnswerHistoryEntry,
  LogEntry,
  Profile,
  Settings,
  Story
} from '$shared/types';
import { DEFAULT_SETTINGS, KDF_ITERATIONS } from '$shared/constants';
import {
  type CipherBlob,
  type WrappedKey,
  b64decode,
  b64encode,
  decryptBlob,
  deriveKek,
  encryptBlob,
  exportDekRaw,
  importDekRaw,
  newDek,
  newSalt,
  unwrapDek,
  wrapDek
} from './crypto';
import { generateRecoveryPhrase, normalizeRecoveryPhrase } from './recovery';

// ───────────────────────── on-disk shapes ─────────────────────────

type MetaBlob = {
  format: 'meta/v1';
  kdf: {
    algorithm: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    saltBase64: string;
  };
  wrappedDek: WrappedKey;
  recovery?: {
    saltBase64: string;
    iterations: number;
    wrappedDek: WrappedKey;
  };
};

type StoredBlob = CipherBlob;

// ───────────────────────── storage keys ─────────────────────────

export const STORAGE_KEYS = {
  meta: 'meta',
  profile: 'profile',
  stories: 'stories',
  history: 'history',
  settings: 'settings',
  logs: 'logs'
} as const;

export const SESSION_KEYS = {
  dekRawBase64: 'session.dek.raw.b64',
  activeApplication: 'session.activeApplication',
  isActive: 'session.isActive',
  activeTabId: 'session.activeTabId',
  recentActivity: 'session.recentActivity'
} as const;

// ───────────────────────── value shapes per key ─────────────────────────

type EncryptedValueByKey = {
  profile: Profile;
  stories: Story[];
  history: AnswerHistoryEntry[];
  settings: Settings;
  logs: LogEntry[];
};

type EncryptedKey = keyof EncryptedValueByKey;

// ───────────────────────── singleton ─────────────────────────

class StoreImpl {
  private dek: CryptoKey | null = null;

  // ----- bootstrapping queries -----

  async isInitialized(): Promise<boolean> {
    const { meta } = await chrome.storage.local.get(STORAGE_KEYS.meta);
    return !!meta;
  }

  isUnlocked(): boolean {
    return this.dek !== null;
  }

  async getMeta(): Promise<MetaBlob | null> {
    const { meta } = await chrome.storage.local.get(STORAGE_KEYS.meta);
    return (meta as MetaBlob | undefined) ?? null;
  }

  // ----- session-DEK resumption -----

  /**
   * Try to resume the unlocked state from session storage. Called on every
   * SW startup. Returns true iff the DEK was successfully re-imported.
   */
  async tryResumeFromSession(): Promise<boolean> {
    const { [SESSION_KEYS.dekRawBase64]: rawB64 } = await chrome.storage.session.get(
      SESSION_KEYS.dekRawBase64
    );
    if (typeof rawB64 !== 'string' || !rawB64) return false;
    try {
      this.dek = await importDekRaw(b64decode(rawB64));
      return true;
    } catch {
      return false;
    }
  }

  private async stashDekToSession() {
    if (!this.dek) return;
    const raw = await exportDekRaw(this.dek);
    await chrome.storage.session.set({ [SESSION_KEYS.dekRawBase64]: b64encode(raw) });
  }

  // ----- setup / unlock -----

  async setupMaster(password: string): Promise<{ recoveryPhrase: string }> {
    if (await this.isInitialized()) {
      throw new Error('already initialized');
    }
    if (password.length < 8) throw new Error('password must be at least 8 characters');

    const passSalt = newSalt();
    const passKek = await deriveKek(password, passSalt, KDF_ITERATIONS);

    const dek = await newDek();
    const wrapped = await wrapDek(dek, passKek);

    const phrase = generateRecoveryPhrase();
    const phraseSalt = newSalt();
    const phraseKek = await deriveKek(normalizeRecoveryPhrase(phrase), phraseSalt, KDF_ITERATIONS);
    const wrappedPhrase = await wrapDek(dek, phraseKek);

    const meta: MetaBlob = {
      format: 'meta/v1',
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: KDF_ITERATIONS,
        saltBase64: b64encode(passSalt)
      },
      wrappedDek: wrapped,
      recovery: {
        saltBase64: b64encode(phraseSalt),
        iterations: KDF_ITERATIONS,
        wrappedDek: wrappedPhrase
      }
    };

    await chrome.storage.local.set({ [STORAGE_KEYS.meta]: meta });

    this.dek = dek;
    await this.stashDekToSession();

    // Seed default settings + empty profile.
    const emptyProfile: Profile = { aliasMap: {}, canonicalData: {}, sensitiveKeys: [] };
    await this.set('settings', DEFAULT_SETTINGS);
    await this.set('profile', emptyProfile);
    await this.set('stories', []);
    await this.set('history', []);
    await this.set('logs', []);

    return { recoveryPhrase: phrase };
  }

  async unlockWithPassword(password: string): Promise<boolean> {
    const meta = await this.getMeta();
    if (!meta) throw new Error('not initialized');
    const salt = b64decode(meta.kdf.saltBase64);
    const kek = await deriveKek(password, salt, meta.kdf.iterations);
    try {
      this.dek = await unwrapDek(meta.wrappedDek, kek);
    } catch {
      this.dek = null;
      return false;
    }
    await this.stashDekToSession();
    return true;
  }

  async unlockWithPhrase(phrase: string): Promise<boolean> {
    const meta = await this.getMeta();
    if (!meta) throw new Error('not initialized');
    if (!meta.recovery) return false; // user opted out at onboarding
    const salt = b64decode(meta.recovery.saltBase64);
    const kek = await deriveKek(normalizeRecoveryPhrase(phrase), salt, meta.recovery.iterations);
    try {
      this.dek = await unwrapDek(meta.recovery.wrappedDek, kek);
    } catch {
      this.dek = null;
      return false;
    }
    await this.stashDekToSession();
    return true;
  }

  async lock(): Promise<void> {
    this.dek = null;
    await chrome.storage.session.remove(SESSION_KEYS.dekRawBase64);
  }

  /**
   * Re-wrap the existing DEK under a new password. Verifies the old credential
   * before changing anything; on failure (auth-tag mismatch) leaves meta intact.
   * The recovery-phrase wrap is preserved — phrase remains valid after a
   * password change.
   *
   * `verifyVia.kind === 'password'` re-derives the KEK from the supplied
   * `current` and unwraps the DEK; `verifyVia.kind === 'phrase'` does the
   * same against the recovery wrap. Either succeeds independently of whether
   * the vault is currently unlocked, so this can be invoked from a locked
   * state too.
   */
  async changePassword(
    verifyVia: { kind: 'password'; current: string } | { kind: 'phrase'; phrase: string },
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; reason: 'wrong-credential' | 'no-recovery' | 'too-short' }> {
    if (newPassword.length < 8) return { ok: false, reason: 'too-short' };
    const meta = await this.getMeta();
    if (!meta) throw new Error('not initialized');

    // 1. Recover the DEK with the supplied credential.
    let dek: CryptoKey;
    try {
      if (verifyVia.kind === 'password') {
        const salt = b64decode(meta.kdf.saltBase64);
        const kek = await deriveKek(verifyVia.current, salt, meta.kdf.iterations);
        dek = await unwrapDek(meta.wrappedDek, kek);
      } else {
        if (!meta.recovery) return { ok: false, reason: 'no-recovery' };
        const salt = b64decode(meta.recovery.saltBase64);
        const kek = await deriveKek(
          normalizeRecoveryPhrase(verifyVia.phrase),
          salt,
          meta.recovery.iterations
        );
        dek = await unwrapDek(meta.recovery.wrappedDek, kek);
      }
    } catch {
      return { ok: false, reason: 'wrong-credential' };
    }

    // 2. Re-wrap with a fresh password-derived KEK (new salt).
    const newSaltBytes = newSalt();
    const newKek = await deriveKek(newPassword, newSaltBytes, KDF_ITERATIONS);
    const newWrapped = await wrapDek(dek, newKek);

    const nextMeta: MetaBlob = {
      ...meta,
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: KDF_ITERATIONS,
        saltBase64: b64encode(newSaltBytes)
      },
      wrappedDek: newWrapped
      // meta.recovery untouched on purpose — the recovery phrase wraps the
      // same DEK and remains valid.
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.meta]: nextMeta });

    // 3. Adopt the verified DEK in-memory + stash for SW restart resumption.
    this.dek = dek;
    await this.stashDekToSession();
    return { ok: true };
  }

  async removeRecoveryPhrase(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const next: MetaBlob = { ...meta, recovery: undefined };
    delete (next as { recovery?: unknown }).recovery;
    await chrome.storage.local.set({ [STORAGE_KEYS.meta]: next });
  }

  // ----- typed get / set -----

  async get<K extends EncryptedKey>(key: K): Promise<EncryptedValueByKey[K] | null> {
    if (!this.dek) throw new Error('locked');
    const v = await chrome.storage.local.get(key);
    const blob = v[key] as StoredBlob | undefined;
    if (!blob) return null;
    return decryptBlob<EncryptedValueByKey[K]>(blob, this.dek);
  }

  async set<K extends EncryptedKey>(key: K, value: EncryptedValueByKey[K]): Promise<void> {
    if (!this.dek) throw new Error('locked');
    const blob = await encryptBlob(value, this.dek);
    await chrome.storage.local.set({ [key]: blob });
  }

  // ----- bulk reset -----

  async wipeAll(): Promise<void> {
    this.dek = null;
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  }
}

export const Store = new StoreImpl();
export type { MetaBlob };
