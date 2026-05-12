import { z } from 'zod';

// ───────────────────────── Atoms ─────────────────────────

export const backendSchema = z.enum(['anthropic', 'openai', 'gemini', 'ollama']);

export const promptTaskNameSchema = z.enum([
  'classifier',
  'chooser',
  'answer_length',
  'story_answer_prompt',
  'resume_parse',
  'story_discovery',
  'generic_key',
  'alias_judge'
]);

export const fieldTypeSchema = z.enum([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'password',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'contenteditable',
  'unknown'
]);

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

// ───────────────────────── Profile ─────────────────────────

export const profileValueSchema = z.object({
  id: z.string(),
  values: z.array(z.string()),
  defaultValueIndex: z.number().int().min(0),
  updatedAt: z.number()
});

export const groupTemplateKeyTypeSchema = z.enum(['string', 'number', 'boolean', 'array']);

export const groupTemplateKeySchema = z.object({
  key: z.string(),
  type: groupTemplateKeyTypeSchema,
  aliases: z.array(z.string()).catch([]),
  sensitive: z.boolean().catch(false)
});

export const groupRecordSchema = z.object({
  id: z.string(),
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const groupTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  keys: z.array(groupTemplateKeySchema),
  records: z.array(groupRecordSchema),
  defaultRecordId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const profileSchema = z.object({
  aliasMap: z.record(z.string(), z.string()),
  canonicalData: z.record(z.string(), profileValueSchema),
  sensitiveKeys: z.array(z.string()),
  // Backwards-compat: pre-template profiles parse cleanly with []
  groupTemplates: z.array(groupTemplateSchema).catch([])
});

// ───────────────────────── History ─────────────────────────

export const answerHistoryEntrySchema = z.object({
  id: z.string(),
  companyName: z.string(),
  role: z.string(),
  userBlurb: z.string().nullable(),
  genericKey: z.string(),
  genericKeyEmbedding: z.array(z.number()),
  question: z.string(),
  questionEmbedding: z.array(z.number()),
  answer: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
});

// ───────────────────────── Story ─────────────────────────

export const storySchema = z.object({
  id: z.string(),
  content: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number()
});

// ───────────────────────── Settings ─────────────────────────

export const promptParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional()
});

export const settingsSchema = z.object({
  activeBackend: backendSchema,
  backends: z.object({
    anthropic: z.object({ apiKey: z.string(), model: z.string() }),
    openai: z.object({ apiKey: z.string(), model: z.string() }),
    gemini: z.object({ apiKey: z.string(), model: z.string() }),
    ollama: z.object({ baseUrl: z.string(), model: z.string() })
  }),
  prompts: z.record(promptTaskNameSchema, z.string()),
  // .catch({}) so existing stored settings without this field parse cleanly.
  promptParams: z.record(promptTaskNameSchema, promptParamsSchema).catch({}),
  matching: z.object({
    fuseThreshold: z.number()
  }),
  rag: z.object({
    historyGenericKeyWeight: z.number(),
    minTokens: z.number(),
    contextPercent: z.number()
  }),
  dedup: z.object({
    questionSimilarityThreshold: z.number(),
    genericKeySimilarityThreshold: z.number()
  }),
  logging: z.object({
    enabled: z.boolean(),
    logPayloads: z.boolean(),
    showDiagnostics: z.boolean().catch(false)
  }),
  // Backwards-compat: stored settings from before the session-timeout setting
  // landed don't carry this object — `.catch({…})` falls back to the default.
  session: z
    .object({
      inactivityMinutes: z.number().min(1).max(720)
    })
    .catch({ inactivityMinutes: 15 }),
  // Backwards-compat: older stored settings lack this object.
  // Navigator shortcuts. Each must be a single non-empty character.
  navigator: z
    .object({
      prevKey: z.string().min(1).max(1),
      nextKey: z.string().min(1).max(1)
    })
    .catch({ prevKey: ',', nextKey: '.' }),
  // Backwards-compat: older stored settings lack this object.
  detector: z
    .object({
      maxAncestorHtml:               z.number().int().min(1000).max(100000),
      maxAncestorInnerText:          z.number().int().min(50).max(2000),
      maxAncestorLevels:             z.number().int().min(1).max(20),
      // Defaults to 2 if missing.
      extraAncestorLevelsAfterMatch: z.number().int().min(0).max(20).catch(2),
      maxAttrValueLen:               z.number().int().min(20).max(500),
      // Defaults to 12 if missing (older stored settings predate this knob).
      classifierMaxContextLevels:    z.number().int().min(0).max(30).catch(12)
    })
    .catch({
      maxAncestorHtml:               15000,
      maxAncestorInnerText:          300,
      maxAncestorLevels:             3,
      extraAncestorLevelsAfterMatch: 2,
      maxAttrValueLen:               120,
      classifierMaxContextLevels:    12
    }),
  customContextWindows: z.record(z.string(), z.number())
});

// ───────────────────────── Active application ─────────────────────────

export const activeApplicationSchema = z.object({
  companyName: z.string(),
  role: z.string(),
  userBlurb: z.string().nullable(),
  genericKey: z.string(),
  genericKeyEmbedding: z.array(z.number()),
  setAt: z.number()
});

// ───────────────────────── Fill plan ─────────────────────────

export const fillPlanSchema = z.object({
  question: z.string().nullable(),
  fieldType: fieldTypeSchema,
  options: z.array(z.string()).nullable(),
  currentValue: z.string(),
  pageContext: z.object({
    title: z.string(),
    hostname: z.string(),
    siteName: z.string().nullable(),
    h1: z.string().nullable()
  }),
  ancestorHtml: z.string().nullable().catch(null),
  ancestorInnerText: z.string().nullable().catch(null),
  // Backwards-compat: older content scripts won't include this field.
  additionalAncestorContexts: z.array(
    z.object({ html: z.string().nullable(), innerText: z.string().nullable() })
  ).catch([]),
  elementDescriptor: z.string().catch(''),
  elementRef: z.string(),
  tabId: z.number(),
  frameId: z.number()
});

// ───────────────────────── Logs ─────────────────────────

export const logEntrySchema = z.object({
  ts: z.number(),
  level: logLevelSchema,
  tag: z.string(),
  message: z.string(),
  payload: z.unknown().optional()
});

// ───────────────────────── Backup envelope ─────────────────────────

export const backupEnvelopeSchema = z.object({
  format: z.literal('backup/v1'),
  version: z.number(),
  exportedAt: z.number(),
  kdf: z.object({
    algorithm: z.literal('PBKDF2'),
    hash: z.literal('SHA-256'),
    iterations: z.number(),
    saltBase64: z.string()
  }),
  payload: z.object({
    cipherTextBase64: z.string(),
    ivBase64: z.string()
  })
});

export const backupBundleSchema = z.object({
  version: z.number(),
  exportedAt: z.number(),
  profile: profileSchema,
  stories: z.array(storySchema),
  history: z.array(answerHistoryEntrySchema),
  settings: settingsSchema
});

// ───────────────────────── Result ─────────────────────────

export function okSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({ ok: z.literal(true), value });
}

export const errSchema = z.object({
  ok: z.literal(false),
  kind: z.string(),
  message: z.string()
});

export function resultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('ok', [okSchema(value), errSchema]);
}
