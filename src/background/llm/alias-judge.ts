// Alias judge — separate, narrow LLM call that runs after a classifier-routed
// profile_existing_value match. Decides whether the field label seen on the
// form is a genuine alias for the resolved canonical key (so it should be
// remembered for future matches), or whether it's too peculiar/general to
// generalize. Kept separate from the classifier prompt to keep that one
// focused; runs fire-and-forget so it never blocks a commit.

import { z } from 'zod';
import type { Settings } from '$shared/types';
import { resolvePromptTemplate, resolvePromptParams } from '$shared/constants';
import { complete } from './orchestrator';
import { extractJson, renderPrompt } from './prompts';

const aliasJudgeResultSchema = z.object({ isAlias: z.boolean() });

export async function judgeAlias(
  settings: Settings,
  args: {
    canonicalKey: string;
    fieldLabel: string;
    ancestorHtml: string | null;
  }
): Promise<
  | { ok: true; isAlias: boolean }
  | { ok: false; message: string; retryable: boolean }
> {
  const template = resolvePromptTemplate('alias_judge', settings.prompts);
  const prompt = renderPrompt(template, {
    canonical_key: args.canonicalKey,
    field_label: args.fieldLabel,
    ancestor_html: args.ancestorHtml ?? '(not available)'
  });
  const { temperature, maxTokens } = resolvePromptParams('alias_judge', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    {
      tag: 'alias_judge',
      vars: {
        canonical_key: args.canonicalKey,
        field_label: args.fieldLabel
      }
    }
  );
  if (!r.ok) return r;

  const json = extractJson(r.text);
  const parsed = aliasJudgeResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Alias judge JSON did not match schema: ${parsed.error.message}`,
      retryable: false
    };
  }
  return { ok: true, isAlias: parsed.data.isAlias };
}
