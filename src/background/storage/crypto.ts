import { AES_IV_BYTES, DEK_BITS, KDF_HASH, KDF_ITERATIONS, KDF_SALT_BYTES } from '$shared/constants';

// Web Crypto wrappers. All inputs/outputs that cross a context boundary
// are base64. Keep the helpers tiny and dependency-free.
//
// Note on `as BufferSource`: TS 5.6's lib defs type `Uint8Array` as
// `Uint8Array<ArrayBufferLike>`, where ArrayBufferLike could be a
// SharedArrayBuffer. Web Crypto's signatures want the narrower
// `BufferSource` (= `ArrayBufferView<ArrayBuffer> | ArrayBuffer`). Our
// Uint8Arrays come from `crypto.getRandomValues` and `TextEncoder.encode`
// which always allocate fresh ArrayBuffers, so the cast is safe.

type BS = BufferSource;
const asBS = (u: Uint8Array): BS => u as unknown as BS;

// ───────────────────────── base64 ─────────────────────────

export function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ───────────────────────── KDF ─────────────────────────

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
}

export function newIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
}

/**
 * Derive an AES-GCM KEK from a passphrase via PBKDF2-SHA256.
 * The KEK is non-extractable, usage-restricted to wrap/unwrap.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations = KDF_ITERATIONS
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    asBS(new TextEncoder().encode(passphrase.normalize('NFKC'))),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBS(salt), iterations, hash: KDF_HASH },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

// ───────────────────────── DEK ─────────────────────────

/**
 * Generate a fresh extractable AES-GCM DEK. Extractable so we can stash
 * its raw bytes in chrome.storage.session for SW-restart resumption.
 */
export async function newDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: DEK_BITS }, true, [
    'encrypt',
    'decrypt'
  ]);
}

export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  const buf = await crypto.subtle.exportKey('raw', dek);
  return new Uint8Array(buf);
}

export async function importDekRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBS(raw), { name: 'AES-GCM', length: DEK_BITS }, true, [
    'encrypt',
    'decrypt'
  ]);
}

// ───────────────────────── DEK wrap / unwrap ─────────────────────────

export type WrappedKey = {
  ivBase64: string;
  cipherBase64: string;
};

export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<WrappedKey> {
  const iv = newIv();
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv: asBS(iv)
  });
  return {
    ivBase64: b64encode(iv),
    cipherBase64: b64encode(wrapped)
  };
}

export async function unwrapDek(wrapped: WrappedKey, kek: CryptoKey): Promise<CryptoKey> {
  const iv = b64decode(wrapped.ivBase64);
  const cipher = b64decode(wrapped.cipherBase64);
  return crypto.subtle.unwrapKey(
    'raw',
    asBS(cipher),
    kek,
    { name: 'AES-GCM', iv: asBS(iv) },
    { name: 'AES-GCM', length: DEK_BITS },
    true,
    ['encrypt', 'decrypt']
  );
}

// ───────────────────────── Blob encrypt / decrypt ─────────────────────────

export type CipherBlob = {
  ivBase64: string;
  cipherBase64: string;
};

export async function encryptBlob(value: unknown, dek: CryptoKey): Promise<CipherBlob> {
  const iv = newIv();
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBS(iv) },
    dek,
    asBS(plaintext)
  );
  return { ivBase64: b64encode(iv), cipherBase64: b64encode(cipher) };
}

export async function decryptBlob<T = unknown>(blob: CipherBlob, dek: CryptoKey): Promise<T> {
  const iv = b64decode(blob.ivBase64);
  const cipher = b64decode(blob.cipherBase64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBS(iv) },
    dek,
    asBS(cipher)
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
