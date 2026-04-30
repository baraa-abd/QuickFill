import { describe, expect, it } from 'vitest';
import {
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
} from '../src/background/storage/crypto';

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 42, 99]);
    expect(b64decode(b64encode(bytes))).toEqual(bytes);
  });
});

describe('blob encryption (AES-GCM)', () => {
  it('round-trips a JSON value', async () => {
    const dek = await newDek();
    const v = { hello: 'world', n: 42, arr: [1, 2, 3] };
    const blob = await encryptBlob(v, dek);
    const out = await decryptBlob<typeof v>(blob, dek);
    expect(out).toEqual(v);
  });

  it('uses a fresh IV per write (no reuse)', async () => {
    const dek = await newDek();
    const a = await encryptBlob({ a: 1 }, dek);
    const b = await encryptBlob({ a: 1 }, dek);
    expect(a.ivBase64).not.toBe(b.ivBase64);
    expect(a.cipherBase64).not.toBe(b.cipherBase64);
  });

  it('decrypt with wrong key throws (auth-tag verifier)', async () => {
    const dek1 = await newDek();
    const dek2 = await newDek();
    const blob = await encryptBlob({ secret: 1 }, dek1);
    await expect(decryptBlob(blob, dek2)).rejects.toBeTruthy();
  });

  it('tampered IV throws', async () => {
    const dek = await newDek();
    const blob = await encryptBlob({ s: 1 }, dek);
    const tampered = { ...blob, ivBase64: b64encode(new Uint8Array(12)) };
    await expect(decryptBlob(tampered, dek)).rejects.toBeTruthy();
  });

  it('tampered ciphertext throws', async () => {
    const dek = await newDek();
    const blob = await encryptBlob({ s: 'abc' }, dek);
    const bytes = b64decode(blob.cipherBase64);
    bytes[0] ^= 0xff;
    const tampered = { ...blob, cipherBase64: b64encode(bytes) };
    await expect(decryptBlob(tampered, dek)).rejects.toBeTruthy();
  });
});

describe('DEK wrap / unwrap', () => {
  it('wrap then unwrap with the same KEK recovers the DEK (functionally)', async () => {
    const password = 'correct horse battery staple';
    const salt = newSalt();
    const kek = await deriveKek(password, salt);
    const dek = await newDek();
    const wrapped = await wrapDek(dek, kek);

    // Re-derive the KEK fresh from the same password+salt and unwrap.
    const kek2 = await deriveKek(password, salt);
    const unwrapped = await unwrapDek(wrapped, kek2);

    // Confirm functional equivalence by encrypting with one and decrypting with the other.
    const blob = await encryptBlob({ x: 1 }, dek);
    const out = await decryptBlob<{ x: number }>(blob, unwrapped);
    expect(out).toEqual({ x: 1 });
  });

  it('wrong password yields a KEK that cannot unwrap (auth-tag fails)', async () => {
    const salt = newSalt();
    const kek = await deriveKek('right-password', salt);
    const dek = await newDek();
    const wrapped = await wrapDek(dek, kek);

    const wrongKek = await deriveKek('WRONG-password', salt);
    await expect(unwrapDek(wrapped, wrongKek)).rejects.toBeTruthy();
  });
});

describe('exportable DEK', () => {
  it('export → import round-trips for session resumption', async () => {
    const dek = await newDek();
    const raw = await exportDekRaw(dek);
    expect(raw.length).toBe(32); // 256-bit AES key
    const imported = await importDekRaw(raw);
    const blob = await encryptBlob({ a: 1 }, dek);
    const out = await decryptBlob<{ a: number }>(blob, imported);
    expect(out).toEqual({ a: 1 });
  });
});
