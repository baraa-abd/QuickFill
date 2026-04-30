// History RAG retriever (§4.4 step 2 + §6.3).
//
//   - Eligible entries: those whose embedding length matches the current
//     model dimension (EMBEDDING_DIMS). Mismatched entries are skipped both
//     here and in dedup (§4.4 step 5, §6.1).
//   - Score each eligible entry: (1 - w) * cosine(question, qEmb)
//                              + w        * cosine(genericKey, gEmb).
//   - Token budget: max(minTokens, floor(ctx * pct/100)).
//   - Greedy pack: sort desc by score; iterate; include if it fits;
//     **skip** entries that don't fit, do NOT stop early.

import { EMBEDDING_DIMS } from '$shared/constants';
import { estimateTokens, getContextWindow } from '$shared/tokens';
import type { AnswerHistoryEntry, Settings } from '$shared/types';
import { cosine } from './similarity';

export type RetrievedEntry = {
  entry: AnswerHistoryEntry;
  score: number;
  qSim: number;
  gSim: number;
  tokens: number;
};

export type RetrievalInput = {
  questionEmbedding: number[];
  genericKeyEmbedding: number[];
  history: AnswerHistoryEntry[];
  settings: Settings;
};

/**
 * Score every eligible entry. Does not pack.
 */
export function scoreHistory(input: RetrievalInput): RetrievedEntry[] {
  const w = input.settings.rag.historyGenericKeyWeight;
  const out: RetrievedEntry[] = [];
  for (const e of input.history) {
    if (!isEligible(e)) continue;
    const qSim = cosine(input.questionEmbedding, e.questionEmbedding);
    const gSim = cosine(input.genericKeyEmbedding, e.genericKeyEmbedding);
    const score = (1 - w) * qSim + w * gSim;
    out.push({ entry: e, score, qSim, gSim, tokens: estimateEntryTokens(e) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Pack top-K entries within the token budget. Greedy with skip-not-stop.
 */
export function packWithinBudget(scored: RetrievedEntry[], budget: number): RetrievedEntry[] {
  if (budget <= 0) return [];
  const picked: RetrievedEntry[] = [];
  let remaining = budget;
  for (const r of scored) {
    if (r.tokens <= remaining) {
      picked.push(r);
      remaining -= r.tokens;
    }
    // else: skip and continue scanning the rest of the list (do NOT break).
  }
  return picked;
}

export function tokenBudget(modelId: string, settings: Settings): number {
  const ctx = getContextWindow(modelId, settings.customContextWindows);
  const pct = settings.rag.contextPercent;
  const fromPct = Math.floor((ctx * pct) / 100);
  return Math.max(settings.rag.minTokens, fromPct);
}

export function retrieve(input: RetrievalInput, modelId: string): RetrievedEntry[] {
  const scored = scoreHistory(input);
  const budget = tokenBudget(modelId, input.settings);
  return packWithinBudget(scored, budget);
}

// ───────────────────────── helpers ─────────────────────────

export function isEligible(e: AnswerHistoryEntry): boolean {
  return (
    Array.isArray(e.questionEmbedding) &&
    e.questionEmbedding.length === EMBEDDING_DIMS &&
    Array.isArray(e.genericKeyEmbedding) &&
    e.genericKeyEmbedding.length === EMBEDDING_DIMS
  );
}

function estimateEntryTokens(e: AnswerHistoryEntry): number {
  // We send Q + A + a small label header per entry. Approximate.
  return estimateTokens(e.question) + estimateTokens(e.answer) + 16;
}

/**
 * Format a packed retrieval set for inclusion in the story_answer_prompt's
 * `{{history}}` slot.
 */
export function formatHistoryForPrompt(picked: RetrievedEntry[]): string {
  if (picked.length === 0) return '(no past answers retrieved)';
  return picked
    .map((r, i) => {
      const date = new Date(r.entry.updatedAt || r.entry.createdAt).toISOString().slice(0, 10);
      return [
        `--- past answer ${i + 1} (date ${date}, generic key: ${r.entry.genericKey}) ---`,
        `Q: ${r.entry.question}`,
        `A: ${r.entry.answer}`
      ].join('\n');
    })
    .join('\n\n');
}
