// Profile lookup against the alias map (§4.2).
//
// Two surfaces:
//
//   matchAlias()   — legacy single-flat-canonical match (kept for tests +
//                    Alt+S append-to-existing-key flow).
//   matchTargets() — ranked list of candidates spanning flat keys AND group-
//                    template keys (with per-template-key aliases). Used by
//                    the FillSession to pick a routing target. When >1
//                    candidate exists, the FillSession escalates to the LLM
//                    classifier for disambiguation.
//
// fuse.js with the user-configurable threshold; aliases for both flat keys
// (Profile.aliasMap) and template keys (GroupTemplateKey.aliases) are searched
// together, so a label like "company" can match either a flat profile key, a
// Work Experience template's "company" slot, or both.

import Fuse from 'fuse.js';
import { cleanLabel } from '$shared/clean';
import type { Profile } from '$shared/types';

export type AliasMatch = {
  alias: string;
  canonicalKey: string;
  score: number;
};

/**
 * A single match target. Either a flat canonical key in the existing
 * `Profile.canonicalData`, or a (template, key) pair pointing inside one of
 * the group templates.
 */
export type MatchTarget =
  | { kind: 'flat'; canonicalKey: string }
  | { kind: 'template'; templateId: string; templateName: string; key: string };

export type MatchCandidate = {
  target: MatchTarget;
  /** Lower is a better match (fuse.js convention). 0 = exact identity. */
  score: number;
  /** The alias / key string that produced the match (cleaned). */
  matchedOn: string;
};

let cache: { aliasMap: Profile['aliasMap']; fuse: Fuse<{ alias: string }> } | null = null;

function fuseFor(aliasMap: Profile['aliasMap'], threshold: number): Fuse<{ alias: string }> {
  if (cache && cache.aliasMap === aliasMap) return cache.fuse;
  const list = Object.keys(aliasMap).map((a) => ({ alias: a }));
  const fuse = new Fuse(list, {
    keys: ['alias'],
    threshold,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2
  });
  cache = { aliasMap, fuse };
  return fuse;
}

export function matchAlias(
  rawLabel: string,
  profile: Profile,
  threshold: number
): AliasMatch | null {
  const cleaned = cleanLabel(rawLabel);
  if (!cleaned) return null;

  // Identity exact match shortcut — aliasMap always carries (K → K).
  if (cleaned in profile.aliasMap) {
    return { alias: cleaned, canonicalKey: profile.aliasMap[cleaned], score: 0 };
  }

  const fuse = fuseFor(profile.aliasMap, threshold);
  const hits = fuse.search(cleaned);
  if (hits.length === 0) return null;
  const top = hits[0];
  return {
    alias: top.item.alias,
    canonicalKey: profile.aliasMap[top.item.alias],
    score: top.score ?? 1
  };
}

/**
 * Search both flat aliases and every group template's per-key aliases. Returns
 * a sorted (best first) candidate list. Empty array when nothing matches.
 *
 * For each template, we synthesize an alias-map of `(cleaned alias → key)` for
 * THAT template only (so collisions across templates don't shadow each other),
 * then run fuse.js against it.
 */
export function matchTargets(
  rawLabel: string,
  profile: Profile,
  threshold: number
): MatchCandidate[] {
  const cleaned = cleanLabel(rawLabel);
  if (!cleaned) return [];

  const out: MatchCandidate[] = [];

  // ── Flat profile keys ─────────────────────────────────────────────
  if (cleaned in profile.aliasMap) {
    out.push({
      target: { kind: 'flat', canonicalKey: profile.aliasMap[cleaned] },
      score: 0,
      matchedOn: cleaned
    });
  } else {
    const fuse = fuseFor(profile.aliasMap, threshold);
    const hits = fuse.search(cleaned);
    if (hits.length > 0) {
      const top = hits[0];
      out.push({
        target: { kind: 'flat', canonicalKey: profile.aliasMap[top.item.alias] },
        score: top.score ?? 1,
        matchedOn: top.item.alias
      });
    }
  }

  // ── Each template's per-key alias list ────────────────────────────
  for (const tpl of profile.groupTemplates ?? []) {
    // Build a per-template flat alias map: cleaned-alias → key
    const aliasMap: Record<string, string> = {};
    for (const k of tpl.keys) {
      const cleanedKey = cleanLabel(k.key);
      if (!cleanedKey) continue;
      aliasMap[cleanedKey] = k.key; // identity
      for (const a of k.aliases ?? []) {
        const ca = cleanLabel(a);
        if (!ca) continue;
        if (!(ca in aliasMap)) aliasMap[ca] = k.key;
      }
    }
    if (Object.keys(aliasMap).length === 0) continue;

    let candidate: { matchedOn: string; key: string; score: number } | null = null;
    if (cleaned in aliasMap) {
      candidate = { matchedOn: cleaned, key: aliasMap[cleaned], score: 0 };
    } else {
      const list = Object.keys(aliasMap).map((a) => ({ alias: a }));
      const fuse = new Fuse(list, {
        keys: ['alias'],
        threshold,
        includeScore: true,
        ignoreLocation: true,
        minMatchCharLength: 2
      });
      const hits = fuse.search(cleaned);
      if (hits.length > 0) {
        const top = hits[0];
        candidate = {
          matchedOn: top.item.alias,
          key: aliasMap[top.item.alias],
          score: top.score ?? 1
        };
      }
    }
    if (candidate) {
      out.push({
        target: {
          kind: 'template',
          templateId: tpl.id,
          templateName: tpl.name,
          key: candidate.key
        },
        score: candidate.score,
        matchedOn: candidate.matchedOn
      });
    }
  }

  out.sort((a, b) => a.score - b.score);
  return out;
}

/**
 * For select / radio fields: try fuzzy-matching every stored value of the
 * canonical key against the available options. Returns the matching option
 * label or null if no value passes the threshold.
 */
export function pickMatchingOption(
  storedValues: string[],
  options: string[],
  threshold: number
): string | null {
  if (options.length === 0 || storedValues.length === 0) return null;
  const fuse = new Fuse(
    options.map((o) => ({ option: o })),
    { keys: ['option'], threshold, includeScore: true, ignoreLocation: true }
  );
  for (const v of storedValues) {
    const hits = fuse.search(v);
    if (hits.length > 0) return hits[0].item.option;
  }
  return null;
}

/** Append a value to a canonical key (case-insensitive dedup) — Alt+S support. */
export function appendValueDedup(existing: string[], value: string): string[] {
  const lower = value.trim().toLowerCase();
  if (!lower) return existing;
  for (const v of existing) if (v.trim().toLowerCase() === lower) return existing;
  return [...existing, value];
}

/** Reset the fuse.js cache. Call after profile mutation. */
export function invalidateMatcherCache(): void {
  cache = null;
}
