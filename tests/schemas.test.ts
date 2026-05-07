import { describe, expect, it } from 'vitest';
import {
  activeApplicationSchema,
  answerHistoryEntrySchema,
  backupBundleSchema,
  backupEnvelopeSchema,
  fillPlanSchema,
  logEntrySchema,
  profileSchema,
  settingsSchema,
  storySchema
} from '../src/shared/schemas';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';

describe('schemas round-trip', () => {
  it('settingsSchema accepts DEFAULT_SETTINGS', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('settingsSchema back-fills detector defaults when the field is absent (backwards compat)', () => {
    // Simulate a stored settings blob that pre-dates the detector field.
    const old: Omit<Settings, 'detector'> = {
      activeBackend: 'ollama',
      backends: DEFAULT_SETTINGS.backends,
      prompts: {},
      promptParams: {},
      matching: { fuseThreshold: 0.1 },
      rag: { historyGenericKeyWeight: 0.3, minTokens: 1024, contextPercent: 25 },
      dedup: { questionSimilarityThreshold: 0.85, genericKeySimilarityThreshold: 0.75 },
      logging: { enabled: true, logPayloads: false, showDiagnostics: false },
      session: { inactivityMinutes: 15 },
      customContextWindows: {}
    };
    const result = settingsSchema.safeParse(old);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.detector).toEqual(DEFAULT_SETTINGS.detector);
    }
  });

  it('settingsSchema back-fills detector defaults when the detector object is invalid', () => {
    const bad = { ...DEFAULT_SETTINGS, detector: { maxAncestorHtml: 'not-a-number' } };
    const result = settingsSchema.safeParse(bad);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.detector).toEqual(DEFAULT_SETTINGS.detector);
    }
  });

  it('profileSchema accepts an empty profile', () => {
    expect(
      profileSchema.safeParse({ aliasMap: {}, canonicalData: {}, sensitiveKeys: [] }).success
    ).toBe(true);
  });

  it('storySchema accepts a valid story', () => {
    const s = {
      id: 'a',
      content: 'I shipped X.',
      keywords: ['shipping'],
      createdAt: 1,
      updatedAt: 1
    };
    expect(storySchema.safeParse(s).success).toBe(true);
  });

  it('answerHistoryEntrySchema accepts a valid entry', () => {
    const e = {
      id: 'a',
      companyName: 'Acme',
      role: 'Eng',
      userBlurb: null,
      genericKey: 'mid-stage SaaS, eng',
      genericKeyEmbedding: [0, 1, 0],
      question: 'why us?',
      questionEmbedding: [1, 0, 0],
      answer: 'because',
      createdAt: 1,
      updatedAt: 1
    };
    expect(answerHistoryEntrySchema.safeParse(e).success).toBe(true);
  });

  it('activeApplicationSchema accepts userBlurb=null', () => {
    expect(
      activeApplicationSchema.safeParse({
        companyName: 'A',
        role: 'B',
        userBlurb: null,
        genericKey: 'k',
        genericKeyEmbedding: [],
        setAt: 1
      }).success
    ).toBe(true);
  });

  it('fillPlanSchema accepts question=null and options=null', () => {
    expect(
      fillPlanSchema.safeParse({
        question: null,
        fieldType: 'unknown',
        options: null,
        currentValue: '',
        pageContext: { title: '', hostname: '', siteName: null, h1: null },
        elementRef: 'uuid',
        tabId: 1,
        frameId: 0
      }).success
    ).toBe(true);
  });

  it('logEntrySchema rejects unknown level', () => {
    expect(
      logEntrySchema.safeParse({ ts: 1, level: 'verbose', tag: 't', message: 'm' }).success
    ).toBe(false);
  });

  it('backupEnvelopeSchema requires the literal format string', () => {
    const env = {
      format: 'wrong/v0',
      version: 1,
      exportedAt: 1,
      kdf: { algorithm: 'PBKDF2', hash: 'SHA-256', iterations: 1, saltBase64: 'a' },
      payload: { cipherTextBase64: 'a', ivBase64: 'a' }
    };
    expect(backupEnvelopeSchema.safeParse(env).success).toBe(false);
    env.format = 'backup/v1';
    expect(backupEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('backupBundleSchema accepts an empty bundle', () => {
    expect(
      backupBundleSchema.safeParse({
        version: 1,
        exportedAt: 1,
        profile: { aliasMap: {}, canonicalData: {}, sensitiveKeys: [] },
        stories: [],
        history: [],
        settings: DEFAULT_SETTINGS
      }).success
    ).toBe(true);
  });
});
