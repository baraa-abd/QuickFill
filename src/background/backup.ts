// Backup pack / unpack (§8.3).
//
// Envelope: { format: 'backup/v1', version, exportedAt, kdf, payload }.
// Plaintext bundle: { version, exportedAt, profile, stories, history, settings }.
// Encryption: AES-GCM under a KEK derived from the user-supplied
// **export password** (separate from the master password) via PBKDF2.
//
// Import errors are discriminated per spec — wrong-password collapses any
// AES-GCM auth-tag failure and any post-decrypt JSON parse failure into a
// single user-facing message (same remediation: try a different password).

import { KDF_HASH, KDF_ITERATIONS } from '$shared/constants';
import { backupBundleSchema, backupEnvelopeSchema } from '$shared/schemas';
import type {
  AnswerHistoryEntry,
  BackupBundle,
  BackupEnvelope,
  Profile,
  Settings,
  Story
} from '$shared/types';
import { b64decode, b64encode, newIv, newSalt } from './storage/crypto';

export const BACKUP_FORMAT = 'backup/v1' as const;
// Bumped to 2 when group-template support landed. Older v1 backups still
// import cleanly because Profile.groupTemplates uses `.catch([])` in the zod
// schema — older payloads simply produce empty templates.
export const BACKUP_VERSION = 2;

type BS = BufferSource;
const asBS = (u: Uint8Array): BS => u as unknown as BS;

// ───────────────────────── Pack ─────────────────────────

export type PackArgs = {
  exportPassword: string;
  profile: Profile;
  stories: Story[];
  history: AnswerHistoryEntry[];
  settings: Settings;
};

export async function packBackup(args: PackArgs): Promise<BackupEnvelope> {
  if (args.exportPassword.length < 8) {
    throw new Error('export password must be at least 8 characters');
  }
  const bundle: BackupBundle = {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    profile: args.profile,
    stories: args.stories,
    history: args.history,
    settings: args.settings
  };
  const salt = newSalt();
  const kek = await deriveExportKey(args.exportPassword, salt);
  const iv = newIv();
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBS(iv) },
    kek,
    asBS(plaintext)
  );
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: bundle.exportedAt,
    kdf: {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations: KDF_ITERATIONS,
      saltBase64: b64encode(salt)
    },
    payload: {
      cipherTextBase64: b64encode(cipher),
      ivBase64: b64encode(iv)
    }
  };
}

// ───────────────────────── Unpack ─────────────────────────

export type ImportErrorKind =
  | 'parse-envelope'
  | 'unsupported-format'
  | 'version-newer'
  | 'wrong-password'
  | 'parse-payload'
  | 'storage-failed';

export type ImportError = { ok: false; kind: ImportErrorKind; message: string };

export async function unpackBackup(
  raw: unknown,
  exportPassword: string
): Promise<{ ok: true; bundle: BackupBundle } | ImportError> {
  // 1. Envelope shape.
  let envelope: BackupEnvelope;
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, kind: 'parse-envelope', message: 'File is not valid JSON.' };
    }
    const v = backupEnvelopeSchema.safeParse(parsed);
    if (!v.success) return { ok: false, kind: 'parse-envelope', message: 'Backup envelope is malformed.' };
    envelope = v.data;
  } else {
    const v = backupEnvelopeSchema.safeParse(raw);
    if (!v.success) return { ok: false, kind: 'parse-envelope', message: 'Backup envelope is malformed.' };
    envelope = v.data;
  }

  // 2. Format gate.
  if (envelope.format !== BACKUP_FORMAT) {
    return { ok: false, kind: 'unsupported-format', message: `Unsupported backup format: ${envelope.format}` };
  }
  if (envelope.version > BACKUP_VERSION) {
    return {
      ok: false,
      kind: 'version-newer',
      message: 'This backup was made by a newer extension version. Update first, then re-import.'
    };
  }

  // 3. Decrypt — auth-tag failure and post-decrypt JSON-parse failure both
  //    surface as a single "wrong-password" message (same remediation).
  let plaintext: ArrayBuffer;
  try {
    const salt = b64decode(envelope.kdf.saltBase64);
    const kek = await deriveExportKey(exportPassword, salt, envelope.kdf.iterations);
    const iv = b64decode(envelope.payload.ivBase64);
    const cipher = b64decode(envelope.payload.cipherTextBase64);
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBS(iv) },
      kek,
      asBS(cipher)
    );
  } catch {
    return { ok: false, kind: 'wrong-password', message: 'Wrong password or the backup file was tampered with.' };
  }

  // 4. Parse + validate plaintext bundle.
  let bundleRaw: unknown;
  try {
    bundleRaw = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return { ok: false, kind: 'wrong-password', message: 'Wrong password or the backup file was tampered with.' };
  }
  const v = backupBundleSchema.safeParse(bundleRaw);
  if (!v.success) {
    return { ok: false, kind: 'parse-payload', message: `Backup payload failed schema: ${v.error.message}` };
  }
  return { ok: true, bundle: v.data };
}

// ───────────────────────── Merge ─────────────────────────

/**
 * Merge an imported story list into the current one by **id** — local edits
 * win on collisions. Used by import mode "Merge stories".
 */
export function mergeStories(local: Story[], incoming: Story[]): Story[] {
  const known = new Set(local.map((s) => s.id));
  const out = local.slice();
  for (const s of incoming) {
    if (!known.has(s.id)) {
      out.push(s);
      known.add(s.id);
    }
  }
  return out;
}

// ───────────────────────── helpers ─────────────────────────

async function deriveExportKey(
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
    ['encrypt', 'decrypt']
  );
}

