// Resume parser (§9 step 5).
//
// Onboarding extracts the raw text from the user's `.docx` / `.txt` file in
// the onboarding page (mammoth needs DOMParser, which the SW lacks) and
// hands the text to this module via the `parse-resume` RPC. We:
//   1. render the `resume_parse` prompt and run it one-shot,
//   2. lenient-extract JSON from the model's reply,
//   3. validate the shape with zod,
//   4. fold extracted entries into a `Profile` (with sensitive auto-flagging),
//   5. produce a Story[] from the suggested STAR narratives.
//
// The fold runs through the shared `cleanLabel()` recipe so canonical keys
// match what the matcher (and later the Profile options page) write.

import { z } from 'zod';
import { cleanLabel } from '$shared/clean';
import { resolvePromptTemplate, resolvePromptParams, SENSITIVE_CANONICAL_KEYS } from '$shared/constants';
import type {
  GroupRecord,
  GroupTemplate,
  GroupTemplateKey,
  GroupTemplateKeyType,
  Profile,
  ProfileValue,
  Settings,
  Story
} from '$shared/types';
import { complete } from '../llm/orchestrator';
import { extractJson, renderPrompt } from '../llm/prompts';

const sensitiveSet = new Set(SENSITIVE_CANONICAL_KEYS.map((k) => cleanLabel(k)));

const resumeKeySchema = z.object({
  key: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array']).optional(),
  aliases: z.array(z.string()).optional(),
  sensitive: z.boolean().optional()
});

const resumeRecordSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.null()])
);

const resumeGroupTemplateSchema = z.object({
  name: z.string(),
  keys: z.array(resumeKeySchema),
  records: z.array(resumeRecordSchema).optional()
});

const resumeParseResultSchema = z.object({
  // Accept arrays and objects in addition to scalars — LLMs often return list-type fields
  // (languages, skills, etc.) as arrays or keyed objects. foldResumeIntoProfile coerces them.
  profile: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
    )
    .optional(),
  stories: z
    .array(
      z.object({
        content: z.string().min(1),
        keywords: z.array(z.string()).optional()
      })
    )
    .optional(),
  // Group templates extracted from the resume — typically Work Experience and
  // Education, but the LLM may also propose Activities, Publications, Projects,
  // etc. The fold will create one template per group.
  groupTemplates: z.array(resumeGroupTemplateSchema).optional()
});

export type ResumeParsed = {
  profile: Profile;
  stories: Story[];
};

export async function parseResume(
  settings: Settings,
  resumeText: string
): Promise<{ ok: true; parsed: ResumeParsed } | { ok: false; message: string; retryable: boolean }> {
  const trimmed = resumeText.trim();
  if (!trimmed) {
    return { ok: false, message: 'Empty resume text.', retryable: false };
  }
  const template = resolvePromptTemplate('resume_parse', settings.prompts);
  const prompt = renderPrompt(template, { resume_text: trimmed });
  const { temperature, maxTokens } = resolvePromptParams('resume_parse', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'resume_parse', vars: { resume_text_chars: trimmed.length } }
  );
  if (!r.ok) return r;

  const json = extractJson(r.text);
  if (json == null) {
    return { ok: false, message: 'Resume parse returned non-JSON output.', retryable: false };
  }
  const parsed = resumeParseResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Resume JSON did not match schema: ${parsed.error.message}`,
      retryable: false
    };
  }
  return { ok: true, parsed: foldResumeIntoProfile(parsed.data) };
}

/**
 * Fold an LLM-extracted `{ profile, stories }` blob into a fresh `Profile`
 * + `Story[]`. Every key is run through `cleanLabel()`; every entry whose
 * cleaned key matches a `SENSITIVE_CANONICAL_KEYS` value is auto-flagged.
 *
 * Exported for the unit-test pass — keeps the LLM call out of the test loop.
 */
export function foldResumeIntoProfile(input: {
  profile?: Record<string, string | number | boolean | unknown[] | Record<string, unknown>>;
  stories?: Array<{ content: string; keywords?: string[] }>;
  groupTemplates?: Array<{
    name: string;
    keys: Array<{
      key: string;
      type?: GroupTemplateKeyType;
      aliases?: string[];
      sensitive?: boolean;
    }>;
    records?: Array<Record<string, string | number | boolean | unknown[] | null>>;
  }>;
}): ResumeParsed {
  const profile: Profile = {
    aliasMap: {},
    canonicalData: {},
    sensitiveKeys: [],
    groupTemplates: []
  };
  const now = Date.now();
  if (input.profile) {
    for (const [rawKey, rawVal] of Object.entries(input.profile)) {
      const key = cleanLabel(rawKey);
      if (!key) continue;
      // Coerce arrays → string. Items that are themselves objects (e.g. education
      // entries) are flattened to "key (value)" pairs and joined with "; " so
      // the comma-separated pairs within each entry stay readable.
      // Coerce top-level objects (e.g. {"Spanish": "beginner"}) → "key (value)" string.
      const coerced = Array.isArray(rawVal)
        ? rawVal
            .filter((v) => v != null && v !== '')
            .map((v) =>
              v !== null && typeof v === 'object' && !Array.isArray(v)
                ? Object.entries(v as Record<string, unknown>)
                    .map(([k, val]) => (val != null && val !== '' ? `${k} (${val})` : k))
                    .join(', ')
                : String(v)
            )
            .join('; ')
        : rawVal !== null && typeof rawVal === 'object'
          ? Object.entries(rawVal as Record<string, unknown>)
              .map(([k, v]) => (v != null && v !== '' ? `${k} (${v})` : k))
              .join(', ')
          : rawVal;
      const value = String(coerced ?? '').trim();
      if (!value) continue;
      const existing = profile.canonicalData[key];
      if (existing) {
        if (!existing.values.includes(value)) {
          existing.values.push(value);
          existing.updatedAt = now;
        }
      } else {
        const pv: ProfileValue = {
          id: key,
          values: [value],
          defaultValueIndex: 0,
          updatedAt: now
        };
        profile.canonicalData[key] = pv;
        profile.aliasMap[key] = key; // identity entry
      }
      if (sensitiveSet.has(key) && !profile.sensitiveKeys.includes(key)) {
        profile.sensitiveKeys.push(key);
      }
    }
  }
  if (input.groupTemplates) {
    for (const tplIn of input.groupTemplates) {
      const tplName = (tplIn.name ?? '').trim();
      if (!tplName || !Array.isArray(tplIn.keys) || tplIn.keys.length === 0) continue;
      const keys: GroupTemplateKey[] = [];
      const seenKeys = new Set<string>();
      for (const k of tplIn.keys) {
        const cleanedKey = cleanLabel(k.key ?? '');
        if (!cleanedKey || seenKeys.has(cleanedKey)) continue;
        seenKeys.add(cleanedKey);
        const aliases = (k.aliases ?? [])
          .map((a) => cleanLabel(a))
          .filter((a) => a && a !== cleanedKey);
        keys.push({
          key: cleanedKey,
          type: k.type ?? 'string',
          aliases: Array.from(new Set(aliases)),
          sensitive: !!k.sensitive
        });
      }
      if (keys.length === 0) continue;

      const records: GroupRecord[] = [];
      if (Array.isArray(tplIn.records)) {
        for (const recIn of tplIn.records) {
          const values: Record<string, string | string[]> = {};
          for (const k of keys) {
            // Try the cleaned key first, then any aliases (parsers sometimes
            // emit "Job Title" instead of the cleaned canonical).
            const candidates = [k.key, ...k.aliases, ...Object.keys(recIn)];
            let raw: unknown = undefined;
            for (const c of candidates) {
              const cc = cleanLabel(c);
              if (!cc) continue;
              for (const [rk, rv] of Object.entries(recIn)) {
                if (cleanLabel(rk) === cc) {
                  raw = rv;
                  break;
                }
              }
              if (raw !== undefined) break;
            }
            if (raw == null || raw === '') continue;
            if (k.type === 'array') {
              values[k.key] = Array.isArray(raw)
                ? raw.filter((v) => v != null && v !== '').map((v) => String(v))
                : [String(raw)];
            } else if (Array.isArray(raw)) {
              // Fall back to comma-joining for non-array typed keys.
              values[k.key] = raw.filter((v) => v != null && v !== '').map((v) => String(v)).join(', ');
            } else {
              values[k.key] = String(raw);
            }
          }
          if (Object.keys(values).length === 0) continue;
          records.push({ id: uuid(), values, createdAt: now, updatedAt: now });
        }
      }

      const tpl: GroupTemplate = {
        id: uuid(),
        name: tplName,
        keys,
        records,
        defaultRecordId: records[0]?.id ?? null,
        createdAt: now,
        updatedAt: now
      };
      profile.groupTemplates.push(tpl);
    }
  }

  const stories: Story[] = [];
  if (input.stories) {
    for (const s of input.stories) {
      const content = (s.content ?? '').trim();
      if (!content) continue;
      stories.push({
        id: uuid(),
        content,
        keywords: Array.isArray(s.keywords) ? s.keywords.filter((k) => typeof k === 'string') : [],
        createdAt: now,
        updatedAt: now
      });
    }
  }
  return { profile, stories };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
