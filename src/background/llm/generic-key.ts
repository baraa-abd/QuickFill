// Generic-key derivation (§4.4 step 1).
//
// Renders the `generic_key` prompt with company / role / blurb, runs it
// through `complete`, parses strict JSON, returns the extracted phrase.

import { z } from 'zod';
import type { Settings } from '$shared/types';
import { resolvePromptTemplate, resolvePromptParams } from '$shared/constants';
import { complete } from './orchestrator';
import { extractJson, renderPrompt } from './prompts';

const genericKeyResultSchema = z.object({ genericKey: z.string().min(1) });

export async function deriveGenericKey(
  settings: Settings,
  args: { companyName: string; role: string; userBlurb: string | null }
): Promise<
  | { ok: true; genericKey: string }
  | { ok: false; message: string; retryable: boolean }
> {
  const template = resolvePromptTemplate('generic_key', settings.prompts);
  const prompt = renderPrompt(template, {
    company_name: args.companyName,
    role: args.role,
    user_blurb: args.userBlurb ?? ''
  });
  const { temperature, maxTokens } = resolvePromptParams('generic_key', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'generic_key', vars: { company_name: args.companyName, role: args.role } }
  );
  if (!r.ok) return r;

  const json = extractJson(r.text);
  const parsed = genericKeyResultSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, genericKey: parsed.data.genericKey.trim() };
  }

  // Fallback: use the raw LLM text if it looks like a short label, or derive from role + company.
  const stripped = r.text.replace(/[{}"'`\n]/g, ' ').trim();
  if (stripped.length > 0 && stripped.length <= 120 && !stripped.includes(':')) {
    return { ok: true, genericKey: stripped.toLowerCase() };
  }
  return {
    ok: true,
    genericKey: `${args.role} ${args.companyName}`.toLowerCase().slice(0, 80)
  };
}
