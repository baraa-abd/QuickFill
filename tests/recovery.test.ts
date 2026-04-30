import { describe, expect, it } from 'vitest';
import {
  generateRecoveryPhrase,
  looksLikeRecoveryPhrase,
  normalizeRecoveryPhrase
} from '../src/background/storage/recovery';
import { WORDLIST } from '../src/background/storage/wordlist';
import { RECOVERY_PHRASE_WORD_COUNT } from '../src/shared/constants';
import {
  decryptBlob,
  deriveKek,
  encryptBlob,
  newDek,
  newSalt,
  unwrapDek,
  wrapDek
} from '../src/background/storage/crypto';

describe('wordlist', () => {
  it('has exactly 256 entries', () => {
    expect(WORDLIST.length).toBe(256);
  });

  it('has no duplicates', () => {
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
  });

  it('every word is lowercase ASCII', () => {
    for (const w of WORDLIST) expect(w).toMatch(/^[a-z]+$/);
  });
});

describe('generateRecoveryPhrase', () => {
  it('produces 16 words from the wordlist', () => {
    const set = new Set(WORDLIST);
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');
    expect(words.length).toBe(RECOVERY_PHRASE_WORD_COUNT);
    for (const w of words) expect(set.has(w)).toBe(true);
  });

  it('produces variation across calls (not the same phrase)', () => {
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    expect(a).not.toBe(b);
  });
});

describe('normalizeRecoveryPhrase', () => {
  it('lowercases, NFKC normalizes, collapses whitespace, trims', () => {
    const raw = '  ABILITY   action  \n  ABOUT  ';
    expect(normalizeRecoveryPhrase(raw)).toBe('ability action about');
  });
});

describe('looksLikeRecoveryPhrase', () => {
  it('accepts a valid generated phrase', () => {
    expect(looksLikeRecoveryPhrase(generateRecoveryPhrase())).toBe(true);
  });

  it('rejects wrong word count', () => {
    expect(looksLikeRecoveryPhrase('ability action about')).toBe(false);
  });

  it('rejects unknown words', () => {
    const words = Array(RECOVERY_PHRASE_WORD_COUNT).fill('zebra').join(' ');
    expect(looksLikeRecoveryPhrase(words)).toBe(false);
  });
});

describe('phrase wraps the same DEK as a password', () => {
  it('phrase-derived KEK and password-derived KEK both unwrap a single DEK', async () => {
    const password = 'super-secret-master';
    const phrase = generateRecoveryPhrase();

    const passSalt = newSalt();
    const phraseSalt = newSalt();

    const passKek = await deriveKek(password, passSalt);
    const phraseKek = await deriveKek(normalizeRecoveryPhrase(phrase), phraseSalt);

    const dek = await newDek();
    const wrappedByPass = await wrapDek(dek, passKek);
    const wrappedByPhrase = await wrapDek(dek, phraseKek);

    // Recover via password.
    const passKek2 = await deriveKek(password, passSalt);
    const dek1 = await unwrapDek(wrappedByPass, passKek2);
    // Recover via phrase.
    const phraseKek2 = await deriveKek(normalizeRecoveryPhrase(phrase), phraseSalt);
    const dek2 = await unwrapDek(wrappedByPhrase, phraseKek2);

    // Functional equivalence: encrypt with one, decrypt with the other.
    const blob = await encryptBlob({ ok: true }, dek1);
    const out = await decryptBlob<{ ok: boolean }>(blob, dek2);
    expect(out).toEqual({ ok: true });
  });
});
