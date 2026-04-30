import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendValueDedup,
  invalidateMatcherCache,
  matchAlias,
  pickMatchingOption
} from '../src/background/matcher';
import type { Profile } from '../src/shared/types';

function profileWith(canonical: Record<string, string[]>, aliases: Record<string, string> = {}): Profile {
  const data: Profile['canonicalData'] = {};
  const aliasMap: Profile['aliasMap'] = { ...aliases };
  const now = Date.now();
  for (const [k, vs] of Object.entries(canonical)) {
    data[k] = { id: k, values: vs, defaultValueIndex: 0, updatedAt: now };
    aliasMap[k] = k; // identity entry
  }
  return { aliasMap, canonicalData: data, sensitiveKeys: [] };
}

describe('matchAlias', () => {
  beforeEach(() => invalidateMatcherCache());

  it('returns null on empty cleaned label', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    expect(matchAlias('   !@#   ', p, 0.3)).toBeNull();
  });

  it('exact-match shortcut', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    const m = matchAlias('First Name', p, 0.3);
    expect(m).not.toBeNull();
    expect(m!.canonicalKey).toBe('first name');
  });

  it('fuzzy match within threshold', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    const m = matchAlias('First Nme:', p, 0.4);
    expect(m).not.toBeNull();
    expect(m!.canonicalKey).toBe('first name');
  });

  it('fuzzy miss when threshold tightens', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    expect(matchAlias('completely unrelated word', p, 0.1)).toBeNull();
  });

  it('resolves through alias map', () => {
    const p = profileWith({ 'first name': ['Ada'] }, { 'given name': 'first name' });
    const m = matchAlias('Given Name', p, 0.3);
    expect(m).not.toBeNull();
    expect(m!.canonicalKey).toBe('first name');
  });
});

describe('pickMatchingOption (select / radio)', () => {
  it('picks an option that matches a stored value', () => {
    const opts = ['United States', 'United Kingdom', 'Germany'];
    expect(pickMatchingOption(['United States'], opts, 0.3)).toBe('United States');
  });

  it('picks via fuzzy similarity', () => {
    const opts = ['United States', 'United Kingdom', 'Germany'];
    expect(pickMatchingOption(['Untied States'], opts, 0.4)).toBe('United States');
  });

  it('returns null on no match', () => {
    expect(pickMatchingOption(['France'], ['Germany', 'Italy'], 0.1)).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(pickMatchingOption([], ['a'], 0.3)).toBeNull();
    expect(pickMatchingOption(['x'], [], 0.3)).toBeNull();
  });
});

describe('appendValueDedup (Alt+S support)', () => {
  it('does not duplicate case-insensitively', () => {
    expect(appendValueDedup(['ada lovelace'], 'ADA LOVELACE')).toEqual(['ada lovelace']);
  });
  it('appends new values', () => {
    expect(appendValueDedup(['a'], 'b')).toEqual(['a', 'b']);
  });
  it('ignores empty/whitespace values', () => {
    expect(appendValueDedup(['a'], '   ')).toEqual(['a']);
  });
});
