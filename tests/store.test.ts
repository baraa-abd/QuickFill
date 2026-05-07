import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/background/storage/store';
import { DEFAULT_SETTINGS } from '../src/shared/constants';

describe('Store (encrypted, end-to-end)', () => {
  beforeEach(async () => {
    // Each test gets a fresh chrome.storage (reset by setup.ts) AND a fresh
    // in-memory DEK on the singleton.
    await Store.lock();
  });

  it('isInitialized=false on a fresh storage', async () => {
    expect(await Store.isInitialized()).toBe(false);
  });

  it('setupMaster initializes everything and unlocks the vault', async () => {
    const { recoveryPhrase } = await Store.setupMaster('correct-horse-battery');
    expect(recoveryPhrase.split(/\s+/).filter(Boolean).length).toBeGreaterThan(0);
    expect(await Store.isInitialized()).toBe(true);
    expect(Store.isUnlocked()).toBe(true);

    const settings = await Store.get('settings');
    expect(settings).toEqual(DEFAULT_SETTINGS);

    const profile = await Store.get('profile');
    expect(profile).toEqual({
      aliasMap: {},
      canonicalData: {},
      sensitiveKeys: [],
      groupTemplates: []
    });
  });

  it('lock then unlock with the same password recovers data', async () => {
    await Store.setupMaster('p4ssword!');
    await Store.set('stories', [
      { id: '1', content: 'x', keywords: [], createdAt: 1, updatedAt: 1 }
    ]);
    await Store.lock();
    expect(Store.isUnlocked()).toBe(false);

    const ok = await Store.unlockWithPassword('p4ssword!');
    expect(ok).toBe(true);
    expect(Store.isUnlocked()).toBe(true);

    const stories = await Store.get('stories');
    expect(stories?.[0]?.id).toBe('1');
  });

  it('wrong password fails to unlock and leaves the vault locked', async () => {
    await Store.setupMaster('right-pass-1234');
    await Store.lock();
    const ok = await Store.unlockWithPassword('wrong-pass-1234');
    expect(ok).toBe(false);
    expect(Store.isUnlocked()).toBe(false);
  });

  it('recovery phrase unlocks the vault', async () => {
    const { recoveryPhrase } = await Store.setupMaster('p4ssword!');
    await Store.lock();
    const ok = await Store.unlockWithPhrase(recoveryPhrase);
    expect(ok).toBe(true);
    expect(Store.isUnlocked()).toBe(true);
  });

  it('removeRecoveryPhrase makes phrase-unlock fail forever', async () => {
    const { recoveryPhrase } = await Store.setupMaster('p4ssword!');
    await Store.removeRecoveryPhrase();
    await Store.lock();
    const ok = await Store.unlockWithPhrase(recoveryPhrase);
    expect(ok).toBe(false);
    // Password still works.
    const okPw = await Store.unlockWithPassword('p4ssword!');
    expect(okPw).toBe(true);
  });

  it('forgotten password AND no recovery phrase = unrecoverable', async () => {
    await Store.setupMaster('p4ssword!');
    await Store.removeRecoveryPhrase();
    await Store.lock();
    const a = await Store.unlockWithPassword('wrong');
    const b = await Store.unlockWithPhrase('any phrase that exists in the wordlist would still fail because the wrap is gone');
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it('stashes the DEK to session storage on unlock (for SW-restart resumption)', async () => {
    await Store.setupMaster('p4ssword!');
    const sess = await chrome.storage.session.get(null);
    const present = Object.values(sess).some((v) => typeof v === 'string' && v.length > 16);
    expect(present).toBe(true);
  });

  it('tryResumeFromSession returns false when no session blob exists', async () => {
    // Fresh storage, no setup → nothing in session.
    expect(await Store.tryResumeFromSession()).toBe(false);
  });

  describe('changePassword', () => {
    it('rotates the password (verified via current password) and preserves data', async () => {
      await Store.setupMaster('old-password-1');
      await Store.set('stories', [
        { id: 'a', content: 'x', keywords: [], createdAt: 1, updatedAt: 1 }
      ]);

      const r = await Store.changePassword(
        { kind: 'password', current: 'old-password-1' },
        'new-password-2'
      );
      expect(r.ok).toBe(true);

      // Old password no longer unlocks.
      await Store.lock();
      expect(await Store.unlockWithPassword('old-password-1')).toBe(false);
      // New one does.
      expect(await Store.unlockWithPassword('new-password-2')).toBe(true);
      // Data preserved.
      const stories = await Store.get('stories');
      expect(stories?.[0]?.id).toBe('a');
    });

    it('rotates the password (verified via recovery phrase) and preserves data', async () => {
      const { recoveryPhrase } = await Store.setupMaster('old-pw-12345');
      const r = await Store.changePassword(
        { kind: 'phrase', phrase: recoveryPhrase },
        'fresh-pw-12345'
      );
      expect(r.ok).toBe(true);

      await Store.lock();
      expect(await Store.unlockWithPassword('old-pw-12345')).toBe(false);
      expect(await Store.unlockWithPassword('fresh-pw-12345')).toBe(true);

      // Recovery phrase still works.
      await Store.lock();
      expect(await Store.unlockWithPhrase(recoveryPhrase)).toBe(true);
    });

    it('rejects wrong current password', async () => {
      await Store.setupMaster('right-pw');
      const r = await Store.changePassword(
        { kind: 'password', current: 'wrong-pw' },
        'new-pw-12345'
      );
      expect(r).toEqual({ ok: false, reason: 'wrong-credential' });
      // Original password still works.
      await Store.lock();
      expect(await Store.unlockWithPassword('right-pw')).toBe(true);
    });

    it('rejects too-short new passwords', async () => {
      await Store.setupMaster('correct-pw-1');
      const r = await Store.changePassword(
        { kind: 'password', current: 'correct-pw-1' },
        'short'
      );
      expect(r).toEqual({ ok: false, reason: 'too-short' });
    });

    it('rejects phrase route when recovery was opted out', async () => {
      const { recoveryPhrase } = await Store.setupMaster('correct-pw-1');
      await Store.removeRecoveryPhrase();
      const r = await Store.changePassword(
        { kind: 'phrase', phrase: recoveryPhrase },
        'new-pw-12345'
      );
      expect(r).toEqual({ ok: false, reason: 'no-recovery' });
    });
  });

  it('lock() clears the session blob so the next page-load does not auto-unlock', async () => {
    await Store.setupMaster('p4ssword!');
    await Store.lock();
    const sess = await chrome.storage.session.get(null);
    const present = Object.values(sess).some((v) => typeof v === 'string' && v.length > 16);
    expect(present).toBe(false);
  });
});
