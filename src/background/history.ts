// Answer-history insert + dedup + merge-undo (§4.4 step 5).
//
// On commit:
//   - Embed the cleaned question.
//   - Among entries with matching embedding dim:
//       * compute qSim, gSim
//       * duplicate iff qSim ≥ Tq AND gSim ≥ Tg
//       * pick best by 0.7 qSim + 0.3 gSim → MERGE into it
//         (keep id + createdAt; overwrite the rest; updatedAt = now)
//   - Otherwise insert a new entry with a fresh uuid.
//   - Return enough info for the panel to show the merge-undo toast and for
//     the SW to actually revert if the user clicks Undo.

import type {
  ActiveApplication,
  AnswerHistoryEntry,
  Settings
} from '$shared/types';
import { isEligible } from './rag/retriever';
import { cosine } from './rag/similarity';

export type IngestArgs = {
  history: AnswerHistoryEntry[];
  questionCleaned: string;
  questionEmbedding: number[];
  answer: string;
  activeApplication: ActiveApplication;
  settings: Settings;
};

export type IngestResult =
  | { kind: 'inserted'; nextHistory: AnswerHistoryEntry[]; newEntry: AnswerHistoryEntry }
  | {
      kind: 'merged';
      nextHistory: AnswerHistoryEntry[];
      mergedInto: AnswerHistoryEntry;       // post-merge entry
      undoSnapshot: AnswerHistoryEntry;     // pre-merge snapshot to allow undo
    };

export function ingest(args: IngestArgs): IngestResult {
  const { history, questionCleaned, questionEmbedding, answer, activeApplication, settings } = args;
  const Tq = settings.dedup.questionSimilarityThreshold;
  const Tg = settings.dedup.genericKeySimilarityThreshold;

  let bestIdx = -1;
  let bestCombined = -1;
  let bestQSim = 0;
  let bestGSim = 0;

  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (!isEligible(e)) continue;
    const qSim = cosine(questionEmbedding, e.questionEmbedding);
    const gSim = cosine(activeApplication.genericKeyEmbedding, e.genericKeyEmbedding);
    if (qSim < Tq || gSim < Tg) continue;
    const combined = 0.7 * qSim + 0.3 * gSim;
    if (combined > bestCombined) {
      bestCombined = combined;
      bestIdx = i;
      bestQSim = qSim;
      bestGSim = gSim;
    }
  }

  const now = Date.now();

  if (bestIdx === -1) {
    const newEntry: AnswerHistoryEntry = {
      id: uuid(),
      companyName: activeApplication.companyName,
      role: activeApplication.role,
      userBlurb: activeApplication.userBlurb,
      genericKey: activeApplication.genericKey,
      genericKeyEmbedding: activeApplication.genericKeyEmbedding,
      question: questionCleaned,
      questionEmbedding,
      answer,
      createdAt: now,
      updatedAt: now
    };
    return { kind: 'inserted', nextHistory: [...history, newEntry], newEntry };
  }

  const older = history[bestIdx];
  const undoSnapshot: AnswerHistoryEntry = { ...older };
  const merged: AnswerHistoryEntry = {
    ...older,
    companyName: activeApplication.companyName,
    role: activeApplication.role,
    userBlurb: activeApplication.userBlurb,
    answer,
    question: questionCleaned,
    questionEmbedding,
    genericKey: activeApplication.genericKey,
    genericKeyEmbedding: activeApplication.genericKeyEmbedding,
    updatedAt: now
  };
  const next = history.slice();
  next[bestIdx] = merged;
  // Use the qSim/gSim values for telemetry, keep them out of the persisted shape.
  void bestQSim;
  void bestGSim;
  return { kind: 'merged', nextHistory: next, mergedInto: merged, undoSnapshot };
}

/**
 * Restore the older entry from the undo snapshot. The new (merged-in) answer
 * is discarded — per spec: "the new answer produced this turn is discarded
 * from history (it is not stored as a separate entry)".
 *
 * The form field is not touched — that's the SW's job to leave alone.
 */
export function applyUndo(
  history: AnswerHistoryEntry[],
  snapshot: AnswerHistoryEntry
): AnswerHistoryEntry[] {
  const idx = history.findIndex((e) => e.id === snapshot.id);
  if (idx === -1) return history; // someone deleted it in the meantime
  const next = history.slice();
  next[idx] = snapshot;
  return next;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
