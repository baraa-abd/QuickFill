// LLM classifier (§4.3).
//
// Branches the field into one of three categories. The default prompt is
// strict-JSON; we use the lenient extractor on the response and validate
// the shape with zod before trusting it.
//
// Group-template extension
// ────────────────────────
// When the matcher returns more than one candidate (e.g. a label like "company"
// that matches both a flat key AND a template's "company" slot, or matches the
// "company" slot of two different templates), the FillSession passes the
// candidates here for disambiguation. The classifier picks one of them — or
// escalates to `profile_update` / `story_answer` — based on the surrounding
// HTML, which is the strongest signal for which group/section the field
// belongs to.
//
// The classifier output schema accepts an optional `templateName` (or
// `templateId`) alongside `canonicalKey`. When present, we resolve to the
// matching template; when absent, the canonicalKey is treated as a flat key.

import { z } from 'zod';
import type { FieldType, GroupTemplate, Profile, Settings } from '$shared/types';
import { resolvePromptTemplate, resolvePromptParams } from '$shared/constants';
import { complete } from './llm/orchestrator';
import { extractJson, renderPrompt } from './llm/prompts';
import type { MatchCandidate, MatchTarget } from './matcher';

// ───────────────────────── Old prompt (preserved per user request) ─────────────────────────
//
// The previous classifier prompt — kept verbatim for reference so the user can
// diff against the new template-aware version in
// shared/constants.ts → DEFAULT_PROMPT_TEMPLATES.classifier.
//
// /*
// You are an expert data classification agent routing a job application form field into one of three strict categories.
//
// <categories>
// 1. "profile_existing_value": A basic personal data point already present in the existing profile keys.
// 2. "profile_update": A basic personal data point NOT yet in the profile (e.g., middle name, pronouns, personal website). Suggest a normalized key (lowercase, spaces only).
// 3. "story_answer": A narrative, open-ended, or experiential question requiring an essay or paragraph (e.g., "Tell us about a time...", "Why this company?").
// </categories>
//
// <context>
// Detector-produced label (heuristic — may be inaccurate): {{field_label}}
// Field type: {{field_type}}
// Available options (if any): {{field_options}}
// Existing canonical profile keys: {{profile_keys}}
//
// Focused element (the specific field the user wants to fill — use this to locate the target within the surrounding HTML):
// {{element_descriptor}}
//
// Surrounding HTML context (outerHTML of the grandparent element that contains the focused field and nearby labels/siblings — use this as the primary source of truth for what the field is actually asking):
// {{grandparent_html}}
// </context>
//
// <instructions>
// Determine what the focused field is asking by using the surrounding HTML as your primary source. The HTML shows the real DOM structure near the field, including labels, legends, aria attributes, and sibling content. Use the focused element descriptor to identify which specific element to fill within that HTML. Treat the detector-produced label as a secondary hint only — it may be wrong.
//
// Use the surrounding HTML to:
// - Identify the true question or label associated with the focused field
// - Understand whether the field expects a brief factual answer or a narrative response
// - Recognize explicit labels, fieldset legends, aria-labelledby targets, or text nodes adjacent to the element
// </instructions>
//
// <rules>
// Output raw, unformatted JSON only. Begin your response with { and end it with }.
// Match exactly one of these output templates:
//
// Template 1 (Existing Value):
// {"category": "profile_existing_value", "canonicalKey": "exact_matched_key"}
//
// Template 2 (New Value):
// {"category": "profile_update", "canonicalKey": "suggested_lowercase_key"}
//
// Template 3 (Story Required):
// {"category": "story_answer"}
// </rules>
//
// <examples>
// If you recognize the Label as "Legal First Name", with existing keys: ["first name", "last name", "email"], then:
// Output: {"category":"profile_existing_value","canonicalKey":"first name"}
//
// If you recognize the Label as "Portfolio URL", with existing keys: ["first name", "last name", "email"], then:
// Output: {"category":"profile_update","canonicalKey":"personal website"}
//
// If you recognize the Label as "Describe a complex technical challenge you solved", with existing keys: ["first name"], then:
// Output: {"category":"story_answer"}
// </examples>
//
// Output:
// */

const matchTargetSchema = z.union([
  z.object({ kind: z.literal('flat'), canonicalKey: z.string() }),
  z.object({
    kind: z.literal('template'),
    templateId: z.string().optional(),
    templateName: z.string().optional(),
    key: z.string()
  })
]);

const classifierResultSchema = z.discriminatedUnion('category', [
  // profile_existing_value: backwards-compat — accept both the legacy
  // {canonicalKey: "..."} (treated as flat) and the new
  // {target: {kind, ...}} shape.
  z.object({
    category: z.literal('profile_existing_value'),
    canonicalKey: z.string().optional(),
    templateName: z.string().optional(),
    templateId: z.string().optional(),
    target: matchTargetSchema.optional()
  }),
  z.object({ category: z.literal('profile_update'), canonicalKey: z.string() }),
  z.object({ category: z.literal('story_answer') })
]);

type RawClassifierResult = z.infer<typeof classifierResultSchema>;

export type ClassifierResult =
  | { category: 'profile_existing_value'; target: MatchTarget }
  | { category: 'profile_update'; canonicalKey: string }
  | { category: 'story_answer' };

export type ClassifyArgs = {
  fieldLabel: string;
  fieldType: FieldType;
  options: string[] | null;
  profile: Profile;
  settings: Settings;
  /** Cleaned + pruned outerHTML of the chosen ancestor; the focused element carries a `data-quickfill-focus="1"` marker. May be null. */
  ancestorHtml: string | null;
  /** Plain-text innerText of the same ancestor (capped). May be null. */
  ancestorInnerText: string | null;
  /** Compact tag + key attributes identifying the focused field — fallback identifier when ancestorHtml is null. */
  elementDescriptor: string;
  /** Optional matcher candidates. When non-empty, the prompt asks the model to
   *  pick one (or escalate). When empty, behaves like the legacy classifier. */
  matchCandidates?: MatchCandidate[];
};

export async function classifyField(
  args: ClassifyArgs
): Promise<
  | { ok: true; result: ClassifierResult }
  | { ok: false; message: string; retryable: boolean }
> {
  const template = resolvePromptTemplate('classifier', args.settings.prompts);
  const profileKeys = Object.keys(args.profile.canonicalData);
  const templates = args.profile.groupTemplates ?? [];
  const prompt = renderPrompt(template, {
    field_label: args.fieldLabel,
    field_type: args.fieldType,
    field_options: args.options ? args.options.map((o) => `- ${o}`).join('\n') : '(n/a)',
    profile_keys: profileKeys.length ? profileKeys.map((k) => `- ${k}`).join('\n') : '(none)',
    group_templates: formatGroupTemplates(templates),
    match_candidates: formatMatchCandidates(args.matchCandidates ?? []),
    element_descriptor: args.elementDescriptor || '(not available)',
    ancestor_html: args.ancestorHtml ?? '(not available)',
    ancestor_inner_text: args.ancestorInnerText ?? '(not available)'
  });

  const { temperature, maxTokens } = resolvePromptParams('classifier', args.settings.promptParams);
  const r = await complete(
    args.settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    {
      tag: 'classifier',
      vars: {
        field_label: args.fieldLabel,
        field_type: args.fieldType,
        options_count: args.options?.length ?? 0,
        templates_count: templates.length,
        candidates_count: args.matchCandidates?.length ?? 0,
        element_descriptor: args.elementDescriptor,
        ancestor_html: args.ancestorHtml ?? '',
        ancestor_inner_text: args.ancestorInnerText ?? ''
      }
    }
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

  // Normalize the raw result into the structured ClassifierResult.
  const normalized = normalizeClassifierResult(parsed.data, args.profile);
  if (!normalized) {
    // Unresolvable — treat as story_answer fallback (matches legacy
    // "trust-but-verify" behavior for unknown flat keys).
    return { ok: true, result: { category: 'story_answer' } };
  }
  return { ok: true, result: normalized };
}

/**
 * Convert the raw zod-parsed classifier output into a ClassifierResult.
 * Returns null when the result references something we can't resolve (e.g.
 * profile_existing_value pointing to an unknown flat key or unknown template).
 */
function normalizeClassifierResult(
  raw: RawClassifierResult,
  profile: Profile
): ClassifierResult | null {
  if (raw.category === 'profile_update') {
    return { category: 'profile_update', canonicalKey: raw.canonicalKey };
  }
  if (raw.category === 'story_answer') {
    return { category: 'story_answer' };
  }
  // profile_existing_value
  let target: MatchTarget | null = null;
  if (raw.target) {
    if (raw.target.kind === 'flat') {
      if (raw.target.canonicalKey in profile.canonicalData) {
        target = { kind: 'flat', canonicalKey: raw.target.canonicalKey };
      }
    } else {
      target = resolveTemplateTarget(
        profile,
        raw.target.templateId,
        raw.target.templateName,
        raw.target.key
      );
    }
  } else if (raw.templateName || raw.templateId) {
    if (raw.canonicalKey) {
      target = resolveTemplateTarget(profile, raw.templateId, raw.templateName, raw.canonicalKey);
    }
  } else if (raw.canonicalKey) {
    if (raw.canonicalKey in profile.canonicalData) {
      target = { kind: 'flat', canonicalKey: raw.canonicalKey };
    }
  }
  if (!target) return null;
  return { category: 'profile_existing_value', target };
}

function resolveTemplateTarget(
  profile: Profile,
  templateId: string | undefined,
  templateName: string | undefined,
  key: string
): MatchTarget | null {
  const templates = profile.groupTemplates ?? [];
  let tpl: GroupTemplate | undefined;
  if (templateId) tpl = templates.find((t) => t.id === templateId);
  if (!tpl && templateName) {
    const wanted = templateName.toLowerCase();
    tpl = templates.find((t) => t.name.toLowerCase() === wanted);
  }
  if (!tpl) return null;
  const keyExists = tpl.keys.some((k) => k.key === key);
  if (!keyExists) return null;
  return { kind: 'template', templateId: tpl.id, templateName: tpl.name, key };
}

function formatGroupTemplates(templates: GroupTemplate[]): string {
  if (templates.length === 0) return '(none)';
  const lines: string[] = [];
  for (const t of templates) {
    lines.push(`- Template "${t.name}" (id: ${t.id}); keys:`);
    for (const k of t.keys) {
      const aliasLine = k.aliases?.length ? ` (aliases: ${k.aliases.join(', ')})` : '';
      lines.push(`    - ${k.key} [${k.type}]${aliasLine}`);
    }
  }
  return lines.join('\n');
}

function formatMatchCandidates(candidates: MatchCandidate[]): string {
  if (candidates.length === 0) return '(none)';
  return candidates
    .map((c, i) => {
      if (c.target.kind === 'flat') {
        return `${i + 1}. flat key "${c.target.canonicalKey}" (matched on "${c.matchedOn}", score=${c.score.toFixed(3)})`;
      }
      return `${i + 1}. template "${c.target.templateName}" / key "${c.target.key}" (matched on "${c.matchedOn}", score=${c.score.toFixed(3)})`;
    })
    .join('\n');
}
