import { describe, expect, it } from 'vitest';
import { isEligible, packWithinBudget, scoreHistory, tokenBudget } from '../src/background/rag/retriever';
import { DEFAULT_SETTINGS, EMBEDDING_DIMS } from '../src/shared/constants';
import type { AnswerHistoryEntry, Settings } from '../src/shared/types';

function unitVec(seed: number): number[] {
  const v = new Array(EMBEDDING_DIMS).fill(0);
  v[seed % EMBEDDING_DIMS] = 1;
  return v;
}

function makeEntry(opts: {
  id: string;
  qSeed: number;
  gSeed: number;
  answer?: string;
  question?: string;
  badDim?: boolean;
}): AnswerHistoryEntry {
  const q = opts.badDim ? [1, 0, 0] : unitVec(opts.qSeed);
  const g = opts.badDim ? [0, 1, 0] : unitVec(opts.gSeed);
  return {
    id: opts.id,
    companyName: 'Acme',
    role: 'Eng',
    userBlurb: null,
    genericKey: `key-${opts.gSeed}`,
    genericKeyEmbedding: g,
    question: opts.question ?? `q-${opts.qSeed}`,
    questionEmbedding: q,
    answer: opts.answer ?? 'short',
    createdAt: 1,
    updatedAt: 1
  };
}

const settings: Settings = structuredClone(DEFAULT_SETTINGS);

describe('isEligible', () => {
  it('rejects entries with mismatched embedding dim', () => {
    expect(isEligible(makeEntry({ id: 'a', qSeed: 0, gSeed: 0, badDim: true }))).toBe(false);
  });
  it('accepts entries with the right dim', () => {
    expect(isEligible(makeEntry({ id: 'a', qSeed: 0, gSeed: 0 }))).toBe(true);
  });
});

describe('scoreHistory', () => {
  it('skips ineligible entries', () => {
    const history = [
      makeEntry({ id: 'a', qSeed: 0, gSeed: 0 }),
      makeEntry({ id: 'b', qSeed: 0, gSeed: 0, badDim: true })
    ];
    const out = scoreHistory({
      questionEmbedding: unitVec(0),
      genericKeyEmbedding: unitVec(0),
      history,
      settings
    });
    expect(out.length).toBe(1);
    expect(out[0].entry.id).toBe('a');
  });

  it('sorts by combined score descending', () => {
    const qe = unitVec(0);
    const ge = unitVec(1);
    const history = [
      makeEntry({ id: 'lowQ', qSeed: 5, gSeed: 1 }), // qSim=0, gSim=1
      makeEntry({ id: 'hiQ', qSeed: 0, gSeed: 5 })   // qSim=1, gSim=0
    ];
    const out = scoreHistory({ questionEmbedding: qe, genericKeyEmbedding: ge, history, settings });
    // w default 0.3 → hiQ score = 0.7, lowQ score = 0.3 → hiQ first.
    expect(out[0].entry.id).toBe('hiQ');
    expect(out[1].entry.id).toBe('lowQ');
  });

  it('genericKeyWeight changes ordering when overridden', () => {
    const qe = unitVec(0);
    const ge = unitVec(1);
    const history = [
      makeEntry({ id: 'lowQ', qSeed: 5, gSeed: 1 }),
      makeEntry({ id: 'hiQ', qSeed: 0, gSeed: 5 })
    ];
    const heavyG: Settings = { ...settings, rag: { ...settings.rag, historyGenericKeyWeight: 0.9 } };
    const out = scoreHistory({
      questionEmbedding: qe,
      genericKeyEmbedding: ge,
      history,
      settings: heavyG
    });
    // w=0.9 → lowQ score = 0.9, hiQ score = 0.1 → lowQ first.
    expect(out[0].entry.id).toBe('lowQ');
  });
});

describe('packWithinBudget', () => {
  const big = (id: string, tokens: number) =>
    ({ entry: makeEntry({ id, qSeed: 0, gSeed: 0 }), score: 1, qSim: 1, gSim: 1, tokens }) as const;

  it('returns empty for nonpositive budget', () => {
    expect(packWithinBudget([big('a', 10)], 0)).toEqual([]);
    expect(packWithinBudget([big('a', 10)], -1)).toEqual([]);
  });

  it('skips entries that do not fit but does NOT stop', () => {
    const scored = [big('huge', 1000), big('small', 50), big('tiny', 20)];
    const picked = packWithinBudget(scored, 100);
    // Skip-not-stop: huge skipped, small + tiny fit.
    expect(picked.map((p) => p.entry.id)).toEqual(['small', 'tiny']);
  });

  it('greedy from top of the list', () => {
    const scored = [big('a', 60), big('b', 60), big('c', 30)];
    const picked = packWithinBudget(scored, 100);
    // a fits → a; b doesn't fit (40 left), skip; c fits (30 ≤ 40) → a, c.
    expect(picked.map((p) => p.entry.id)).toEqual(['a', 'c']);
  });
});

describe('tokenBudget', () => {
  it('respects minTokens floor', () => {
    const s: Settings = {
      ...settings,
      rag: { historyGenericKeyWeight: 0, minTokens: 9999, contextPercent: 1 }
    };
    expect(tokenBudget('gemma4:e4b', s)).toBe(9999);
  });

  it('uses contextPercent of the model window otherwise', () => {
    const s: Settings = {
      ...settings,
      rag: { historyGenericKeyWeight: 0, minTokens: 0, contextPercent: 25 }
    };
    // gpt-4o-mini = 128k → 32000.
    expect(tokenBudget('gpt-4o-mini', s)).toBe(32_000);
  });
});
