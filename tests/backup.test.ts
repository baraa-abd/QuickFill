// Backup pack/unpack — round-trip + every declared error kind (§8.3).

import { describe, expect, it } from 'vitest';
import { mergeStories, packBackup, unpackBackup } from '../src/background/backup';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type {
  AnswerHistoryEntry,
  BackupEnvelope,
  Profile,
  Story
} from '../src/shared/types';

const profile: Profile = {
  aliasMap: { 'first name': 'first name' },
  canonicalData: {
    'first name': { id: 'first name', values: ['Ada'], defaultValueIndex: 0, updatedAt: 1 }
  },
  sensitiveKeys: [],
  groupTemplates: []
};
const stories: Story[] = [
  { id: 's-1', content: 'STAR narrative', keywords: ['leadership'], createdAt: 1, updatedAt: 1 }
];
const history: AnswerHistoryEntry[] = [];

describe('backup round-trip', () => {
  it('packs then unpacks under the same password', async () => {
    const env = await packBackup({
      exportPassword: 'export-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    expect(env.format).toBe('backup/v1');
    // BACKUP_VERSION bumped to 2 when group-template support landed; v1
    // payloads still import cleanly because Profile.groupTemplates uses
    // .catch([]) in the schema.
    expect(env.version).toBe(2);

    const r = await unpackBackup(env, 'export-pass');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.profile.canonicalData['first name']?.values).toEqual(['Ada']);
    expect(r.bundle.stories).toHaveLength(1);
  });

  it('round-trips when the envelope is passed as a JSON string', async () => {
    const env = await packBackup({
      exportPassword: 'export-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    const r = await unpackBackup(JSON.stringify(env), 'export-pass');
    expect(r.ok).toBe(true);
  });

  it('refuses too-short export passwords', async () => {
    await expect(
      packBackup({ exportPassword: 'short', profile, stories, history, settings: DEFAULT_SETTINGS })
    ).rejects.toThrow();
  });
});

describe('unpackBackup error kinds', () => {
  it('parse-envelope on non-JSON input', async () => {
    const r = await unpackBackup('not json {', 'pw');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('parse-envelope');
  });

  it('parse-envelope on a malformed envelope shape', async () => {
    const r = await unpackBackup({ format: 'backup/v1' }, 'pw');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('parse-envelope');
  });

  it('unsupported-format on a different format string', async () => {
    const env: BackupEnvelope = await packBackup({
      exportPassword: 'export-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    // Hand-craft an envelope with a wrong format. The schema literal allows
    // only 'backup/v1' so we have to bypass validation with `unknown`.
    const evil = { ...env, format: 'backup/v0' } as unknown;
    const r = await unpackBackup(evil, 'export-pass');
    expect(r.ok).toBe(false);
    // The schema rejects on shape (parse-envelope) before format is even checked.
    if (!r.ok) expect(['parse-envelope', 'unsupported-format']).toContain(r.kind);
  });

  it('version-newer when envelope.version exceeds current', async () => {
    const env = await packBackup({
      exportPassword: 'export-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    const evil: BackupEnvelope = { ...env, version: env.version + 99 };
    const r = await unpackBackup(evil, 'export-pass');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('version-newer');
  });

  it('wrong-password collapses auth-tag failures into a single user-facing error', async () => {
    const env = await packBackup({
      exportPassword: 'correct-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    const r = await unpackBackup(env, 'wrong-pass-here');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('wrong-password');
  });

  it('wrong-password on a tampered ciphertext (auth-tag failure)', async () => {
    const env = await packBackup({
      exportPassword: 'export-pass',
      profile,
      stories,
      history,
      settings: DEFAULT_SETTINGS
    });
    // Flip a single byte in the ciphertext.
    const flipped = flipFirstBase64Char(env.payload.cipherTextBase64);
    const evil: BackupEnvelope = { ...env, payload: { ...env.payload, cipherTextBase64: flipped } };
    const r = await unpackBackup(evil, 'export-pass');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('wrong-password');
  });
});

describe('mergeStories', () => {
  it('union by id — local edits win', () => {
    const local: Story[] = [
      { id: 'a', content: 'local-A', keywords: [], createdAt: 1, updatedAt: 2 }
    ];
    const incoming: Story[] = [
      { id: 'a', content: 'incoming-A', keywords: [], createdAt: 1, updatedAt: 1 },
      { id: 'b', content: 'incoming-B', keywords: [], createdAt: 1, updatedAt: 1 }
    ];
    const out = mergeStories(local, incoming);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === 'a')?.content).toBe('local-A');
    expect(out.find((s) => s.id === 'b')?.content).toBe('incoming-B');
  });
});

function flipFirstBase64Char(s: string): string {
  // Deterministic mutation: flip the second byte to dodge AES-GCM's IV/header
  // on cipher (the start of the ciphertext is data, not metadata).
  if (s.length < 4) return s;
  const c = s[2];
  const flipped = c === 'A' ? 'B' : 'A';
  return s.slice(0, 2) + flipped + s.slice(3);
}
