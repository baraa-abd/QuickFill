// story_answer streaming (§4.4 steps 3–4) + max-length resolution + chooser
// + answer_length one-shots.
//
// The big public entry is `streamAnswer(args)` — async generator yielding
// tokens. `resolveMaxLength` and `runChooser` are exported for use in the
// matcher / fill-session machinery.

import { z } from 'zod';
import { resolvePromptTemplate, resolvePromptParams } from '$shared/constants';
import type {
  ActiveApplication,
  AnswerHistoryEntry,
  FieldType,
  Profile,
  Settings,
  Story
} from '$shared/types';
import { complete, streamWith } from './orchestrator';
import { extractJson, renderPrompt } from './prompts';
import {
  formatHistoryForPrompt,
  packWithinBudget,
  scoreHistory,
  tokenBudget
} from '../rag/retriever';
import type { StreamChunk } from './types';

// ───────────────────────── max length ─────────────────────────

const lengthResultSchema = z.object({}).passthrough();

/**
 * §4.4 step 3 max_length:
 *  - if the DOM has a non-zero `maxlength`, use that integer directly.
 *  - else run the `answer_length` one-shot.
 */
export async function resolveMaxLength(
  settings: Settings,
  fieldLabel: string,
  fieldType: FieldType,
  domMaxLength?: number
): Promise<{ ok: true; maxLength: number } | { ok: false; message: string; retryable: boolean }> {
  if (typeof domMaxLength === 'number' && domMaxLength > 0) {
    return { ok: true, maxLength: domMaxLength };
  }
  const template = resolvePromptTemplate('answer_length', settings.prompts);
  const prompt = renderPrompt(template, { field_label: fieldLabel, field_type: fieldType });
  const { temperature, maxTokens } = resolvePromptParams('answer_length', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'answer_length', vars: { field_label: fieldLabel, field_type: fieldType } }
  );
  if (!r.ok) return r;

  // Accept either a bare integer or a JSON wrapper.
  const direct = parseInt(r.text.trim(), 10);
  if (Number.isFinite(direct) && direct > 0) return { ok: true, maxLength: direct };
  const json = extractJson(r.text) as Record<string, unknown> | null;
  if (json) {
    lengthResultSchema.safeParse(json); // shape is open
    for (const v of Object.values(json)) {
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      if (Number.isFinite(n) && n > 0) return { ok: true, maxLength: n };
    }
  }
  // Fallback: 600 chars is a safe medium-answer default.
  return { ok: true, maxLength: 600 };
}

// ───────────────────────── chooser ─────────────────────────

/**
 * §4.2 chooser. Returns either an exact option string from the supplied
 * `options` list, or null on the literal `"No good options"` reply.
 */
export async function runChooser(
  settings: Settings,
  args: {
    fieldLabel: string;
    canonicalKey: string;
    storedValues: string[];
    options: string[];
  }
): Promise<
  | { ok: true; chosen: string | null }
  | { ok: false; message: string; retryable: boolean }
> {
  const template = resolvePromptTemplate('chooser', settings.prompts);
  const prompt = renderPrompt(template, {
    field_label: args.fieldLabel,
    canonical_key: args.canonicalKey,
    stored_values: args.storedValues.map((v) => `- ${v}`).join('\n') || '(none)',
    options: args.options.map((o) => `- ${o}`).join('\n')
  });
  const { temperature, maxTokens } = resolvePromptParams('chooser', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'chooser', vars: { field_label: args.fieldLabel, canonical_key: args.canonicalKey } }
  );
  if (!r.ok) return r;
  const t = r.text.trim();
  if (/^no good options\.?$/i.test(t)) return { ok: true, chosen: null };
  // Strip surrounding quotes / fences in case the model added them.
  const cleaned = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Verify the choice exists in the options list (case-insensitive).
  const match = args.options.find((o) => o.toLowerCase() === cleaned.toLowerCase());
  return { ok: true, chosen: match ?? null };
}

// ───────────────────────── story answer streaming ─────────────────────────

export type StreamAnswerArgs = {
  settings: Settings;
  activeApplication: ActiveApplication;
  profile: Profile;
  stories: Story[];
  history: AnswerHistoryEntry[];
  questionEmbedding: number[];
  fieldLabel: string;
  maxLength: number;
  signal?: AbortSignal;
};

export async function* streamAnswer(args: StreamAnswerArgs): AsyncGenerator<StreamChunk, void, void> {
  const template = resolvePromptTemplate('story_answer_prompt', args.settings.prompts);

  // RAG retrieval (genericKey already embedded on the active application).
  const scored = scoreHistory({
    questionEmbedding: args.questionEmbedding,
    genericKeyEmbedding: args.activeApplication.genericKeyEmbedding,
    history: args.history,
    settings: args.settings
  });
  const budget = tokenBudget(args.settings.backends[args.settings.activeBackend].model, args.settings);
  const picked = packWithinBudget(scored, budget);

  // Sensitive-key filtered profile rendering.
  const sensitiveSet = new Set(args.profile.sensitiveKeys);
  const profileLines: string[] = [];
  for (const [key, val] of Object.entries(args.profile.canonicalData)) {
    if (sensitiveSet.has(key)) continue;
    const v = val.values[val.defaultValueIndex] ?? val.values[0] ?? '';
    if (!v) continue;
    profileLines.push(`- ${key}: ${v}`);
  }

  const storiesBlock =
    args.stories.length === 0
      ? '(no stories captured yet)'
      : args.stories
          .map((s, i) => `--- story ${i + 1} (tags: ${s.keywords.join(', ') || 'none'}) ---\n${s.content}`)
          .join('\n\n');

  const appBlock =
    `Company: ${args.activeApplication.companyName}\n` +
    `Role: ${args.activeApplication.role}\n` +
    `Generic key: ${args.activeApplication.genericKey}\n` +
    (args.activeApplication.userBlurb ? `Notes: ${args.activeApplication.userBlurb}` : '');

  const prompt = renderPrompt(template, {
    active_application: appBlock,
    profile: profileLines.join('\n') || '(no profile fields available)',
    stories: storiesBlock,
    history: formatHistoryForPrompt(picked),
    field_label: args.fieldLabel,
    max_length: args.maxLength
  });

  const storyParams = resolvePromptParams('story_answer_prompt', args.settings.promptParams);
  // If the user hasn't set a custom maxTokens, derive it from the character budget.
  const storyMaxTokens = args.settings.promptParams.story_answer_prompt?.maxTokens
    ?? Math.max(256, Math.ceil(args.maxLength / 2));
  yield* streamWith(args.settings, {
    messages: [{ role: 'user', content: prompt }],
    temperature: storyParams.temperature,
    maxTokens: storyMaxTokens,
    signal: args.signal
  });
}

// ───────────────────────── story discovery ─────────────────────────

const storyDiscoveryResultSchema = z.discriminatedUnion('proposeStory', [
  z.object({ proposeStory: z.literal(false) }),
  z.object({
    proposeStory: z.literal(true),
    content: z.string().min(1),
    keywords: z.array(z.string())
  })
]);

export type StoryDiscoveryProposal =
  | { propose: false }
  | { propose: true; content: string; keywords: string[] };

export async function runStoryDiscovery(
  settings: Settings,
  args: {
    activeApplication: ActiveApplication;
    fieldLabel: string;
    answer: string;
    stories: Story[];
  }
): Promise<StoryDiscoveryProposal | { error: string }> {
  const template = resolvePromptTemplate('story_discovery', settings.prompts);
  const prompt = renderPrompt(template, {
    active_application: `Company: ${args.activeApplication.companyName}\nRole: ${args.activeApplication.role}\nGeneric key: ${args.activeApplication.genericKey}`,
    field_label: args.fieldLabel,
    answer: args.answer,
    stories: args.stories.map((s) => `- ${s.content}`).join('\n') || '(none)'
  });
  const { temperature, maxTokens } = resolvePromptParams('story_discovery', settings.promptParams);
  const r = await complete(
    settings,
    { messages: [{ role: 'user', content: prompt }], temperature, maxTokens },
    { tag: 'story_discovery', vars: { field_label: args.fieldLabel } }
  );
  if (!r.ok) return { error: r.message };
  const parsed = storyDiscoveryResultSchema.safeParse(extractJson(r.text));
  if (!parsed.success) return { error: 'invalid story_discovery JSON' };
  if (parsed.data.proposeStory === false) return { propose: false };
  return { propose: true, content: parsed.data.content, keywords: parsed.data.keywords };
}
