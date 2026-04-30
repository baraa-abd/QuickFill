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
import type { Profile, ProfileValue, Settings, Story } from '$shared/types';
import { complete } from '../llm/orchestrator';
import { extractJson, renderPrompt } from '../llm/prompts';

const sensitiveSet = new Set(SENSITIVE_CANONICAL_KEYS.map((k) => cleanLabel(k)));

const resumeParseResultSchema = z.object({
  // Accept arrays in addition to scalars — LLMs often return list-type fields
  // (languages, skills, etc.) as arrays. foldResumeIntoProfile joins them.
  profile: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown())])).optional(),
  stories: z
    .array(
      z.object({
        content: z.string().min(1),
        keywords: z.array(z.string()).optional()
      })
    )
    .optional()
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
  profile?: Record<string, string | number | boolean>;
  stories?: Array<{ content: string; keywords?: string[] }>;
}): ResumeParsed {
  const profile: Profile = { aliasMap: {}, canonicalData: {}, sensitiveKeys: [] };
  const now = Date.now();
  if (input.profile) {
    for (const [rawKey, rawVal] of Object.entries(input.profile)) {
      const key = cleanLabel(rawKey);
      if (!key) continue;
      // Coerce arrays (e.g. ["Python", "JS"]) → comma-separated string.
      const coerced = Array.isArray(rawVal)
        ? rawVal.filter((v) => v != null && v !== '').join(', ')
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
