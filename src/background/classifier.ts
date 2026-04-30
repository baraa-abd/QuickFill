// LLM classifier (§4.3).
//
// Branches the field into one of three categories. The default prompt is
// strict-JSON; we use the lenient extractor on the response and validate
// the shape with zod before trusting it.

import { z } from 'zod';
import type { FieldType, Profile, Settings } from '$shared/types';
import { resolvePromptTemplate, resolvePromptParams } from '$shared/constants';
import { complete } from './llm/orchestrator';
import { extractJson, renderPrompt } from './llm/prompts';

const classifierResultSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('profile_existing_value'), canonicalKey: z.string() }),
  z.object({ category: z.literal('profile_update'), canonicalKey: z.string() }),
  z.object({ category: z.literal('story_answer') })
]);

export type ClassifierResult = z.infer<typeof classifierResultSchema>;

export type ClassifyArgs = {
  fieldLabel: string;
  fieldType: FieldType;
  options: string[] | null;
  profile: Profile;
  settings: Settings;
  /** outerHTML of the grandparent element — structural context for the classifier. May be null if the field has no grandparent. */
  grandparentHtml: string | null;
  /** Compact tag + key attributes identifying the focused field within grandparentHtml. */
  elementDescriptor: string;
};

export async function classifyField(
  args: ClassifyArgs
): Promise<
  | { ok: true; result: ClassifierResult }
  | { ok: false; message: string; retryable: boolean }
> {
  const template = resolvePromptTemplate('classifier', args.settings.prompts);
  const profileKeys = Object.keys(args.profile.canonicalData);
  const prompt = renderPrompt(template, {
    field_label: args.fieldLabel,
    field_type: args.fieldType,
    field_options: args.options ? args.options.map((o) => `- ${o}`).join('\n') : '(n/a)',
    profile_keys: profileKeys.length ? profileKeys.map((k) => `- ${k}`).join('\n') : '(none)',
    element_descriptor: args.elementDescriptor || '(not available)',
    grandparent_html: args.grandparentHtml ?? '(not available)'
  });

  const { temperature, maxTokens } = resolvePromptParams('classifier', args.settings.promptParams);
  const r = await complete(
    args.settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'classifier', vars: { field_label: args.fieldLabel, field_type: args.fieldType, options_count: args.options?.length ?? 0, element_descriptor: args.elementDescriptor, grandparent_html: args.grandparentHtml ?? '' } }
  );
  if (!r.ok) return r;

  const json = extractJson(r.text);
  if (json == null) {
    return { ok: false, message: 'Classifier returned non-JSON output.', retryable: false };
  }
  const parsed = classifierResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Classifier JSON did not match schema: ${parsed.error.message}`,
      retryable: false
    };
  }
  // Trust-but-verify: if profile_existing_value points to an unknown key, treat as story_answer.
  if (parsed.data.category === 'profile_existing_value') {
    if (!(parsed.data.canonicalKey in args.profile.canonicalData)) {
      return { ok: true, result: { category: 'story_answer' } };
    }
  }
  return { ok: true, result: parsed.data };
}
