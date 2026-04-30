// Profile lookup against the alias map (§4.2).
//
// fuse.js with the user-configurable threshold; returns the canonical key
// that best matches the cleaned label, or null. Resolves aliases via
// `profile.aliasMap`.

import Fuse from 'fuse.js';
import { cleanLabel } from '$shared/clean';
import type { Profile } from '$shared/types';

export type AliasMatch = {
  alias: string;
  canonicalKey: string;
  score: number;
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
