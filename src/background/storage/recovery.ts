import { RECOVERY_PHRASE_WORD_COUNT, RECOVERY_PHRASE_WORDLIST_SIZE } from '$shared/constants';
import { WORDLIST } from './wordlist';

// 16 words from a 256-word list ⇒ 8 bits per word ⇒ 128 bits of entropy.
// We sample uniformly with rejection sampling on a Uint32 to avoid modulo bias.
//
// The phrase is treated as a passphrase: NFKC normalize, lowercase, collapse
// whitespace, then PBKDF2 it identically to the master password.

export function generateRecoveryPhrase(wordCount = RECOVERY_PHRASE_WORD_COUNT): string {
  if (WORDLIST.length !== RECOVERY_PHRASE_WORDLIST_SIZE) {
    throw new Error(
      `WORDLIST length must be ${RECOVERY_PHRASE_WORDLIST_SIZE} (got ${WORDLIST.length}).`
    );
  }
  const out: string[] = [];
  for (let i = 0; i < wordCount; i++) out.push(WORDLIST[secureIndex(WORDLIST.length)]);
  return out.join(' ');
}

export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True iff every word in the (normalized) phrase exists in the wordlist
 * and the count matches. Useful to give early "this phrase looks wrong"
 * feedback before paying for a PBKDF2 derive.
 */
export function looksLikeRecoveryPhrase(phrase: string): boolean {
  const words = normalizeRecoveryPhrase(phrase).split(' ').filter(Boolean);
  if (words.length !== RECOVERY_PHRASE_WORD_COUNT) return false;
  const set = new Set(WORDLIST);
  for (const w of words) if (!set.has(w)) return false;
  return true;
}

// ───────────────────────── internals ─────────────────────────

/**
 * Uniformly random integer in [0, n). Rejection sampling on a Uint32 to
 * avoid modulo bias. n must be in (0, 2^32).
 */
function secureIndex(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new Error('bad bound');
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) return buf[0] % n;
  }
}
