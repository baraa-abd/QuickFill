import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendValueDedup,
  invalidateMatcherCache,
  matchAlias,
  matchTargets,
  pickMatchingOption
} from '../src/background/matcher';
import type { GroupTemplate, Profile } from '../src/shared/types';

function profileWith(canonical: Record<string, string[]>, aliases: Record<string, string> = {}): Profile {
  const data: Profile['canonicalData'] = {};
  const aliasMap: Profile['aliasMap'] = { ...aliases };
  const now = Date.now();
  for (const [k, vs] of Object.entries(canonical)) {
    data[k] = { id: k, values: vs, defaultValueIndex: 0, updatedAt: now };
    aliasMap[k] = k; // identity entry
  }
  return { aliasMap, canonicalData: data, sensitiveKeys: [], groupTemplates: [] };
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

// ───────────────────────── matchTargets (flat + templates) ─────────────────────────

function workExperienceTemplate(): GroupTemplate {
  const now = Date.now();
  return {
    id: 'tpl-work',
    name: 'Work Experience',
    keys: [
      { key: 'job title', type: 'string', aliases: ['title', 'position', 'role'], sensitive: false },
      { key: 'company', type: 'string', aliases: ['employer', 'organization'], sensitive: false },
      { key: 'start date', type: 'string', aliases: ['from'], sensitive: false }
    ],
    records: [],
    defaultRecordId: null,
    createdAt: now,
    updatedAt: now
  };
}

function educationTemplate(): GroupTemplate {
  const now = Date.now();
  return {
    id: 'tpl-edu',
    name: 'Education',
    keys: [
      { key: 'school', type: 'string', aliases: ['university', 'institution'], sensitive: false },
      { key: 'degree', type: 'string', aliases: [], sensitive: false }
    ],
    records: [],
    defaultRecordId: null,
    createdAt: now,
    updatedAt: now
  };
}

describe('matchTargets', () => {
  beforeEach(() => invalidateMatcherCache());

  it('returns empty when no flat or template match exists', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    expect(matchTargets('completely unrelated word', p, 0.1)).toEqual([]);
  });

  it('returns a single flat candidate for flat-only matches', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    const cs = matchTargets('First Name', p, 0.3);
    expect(cs).toHaveLength(1);
    expect(cs[0].target).toEqual({ kind: 'flat', canonicalKey: 'first name' });
  });

  it('finds a template-key match when no flat match exists', () => {
    const p = profileWith({ 'first name': ['Ada'] });
    p.groupTemplates = [workExperienceTemplate()];
    const cs = matchTargets('Job Title', p, 0.3);
    expect(cs).toHaveLength(1);
    expect(cs[0].target).toEqual({
      kind: 'template',
      templateId: 'tpl-work',
      templateName: 'Work Experience',
      key: 'job title'
    });
  });

  it('resolves a template-key match through a per-key alias', () => {
    const p = profileWith({});
    p.groupTemplates = [workExperienceTemplate()];
    const cs = matchTargets('Position', p, 0.3);
    expect(cs).toHaveLength(1);
    expect(cs[0].target).toEqual({
      kind: 'template',
      templateId: 'tpl-work',
      templateName: 'Work Experience',
      key: 'job title'
    });
    expect(cs[0].matchedOn).toBe('position');
  });

  it('returns multiple candidates when both flat AND template keys match the label', () => {
    const p = profileWith({ company: ['Acme Inc'] }); // flat 'company'
    p.groupTemplates = [workExperienceTemplate()];   // template 'company'
    const cs = matchTargets('Company', p, 0.3);
    expect(cs.length).toBeGreaterThanOrEqual(2);
    const kinds = cs.map((c) => c.target.kind).sort();
    expect(kinds).toContain('flat');
    expect(kinds).toContain('template');
  });

  it('returns multiple candidates when two templates share a slot name (e.g. start date)', () => {
    const p = profileWith({});
    p.groupTemplates = [
      workExperienceTemplate(),
      // Education with a 'start date' slot too
      {
        ...educationTemplate(),
        keys: [
          ...educationTemplate().keys,
          { key: 'start date', type: 'string', aliases: [], sensitive: false }
        ]
      }
    ];
    const cs = matchTargets('Start Date', p, 0.3);
    expect(cs.length).toBe(2);
    const tplIds = cs.map((c) =>
      c.target.kind === 'template' ? c.target.templateId : null
    );
    expect(tplIds).toContain('tpl-work');
    expect(tplIds).toContain('tpl-edu');
  });

  it('returns empty when label is empty / unmatched', () => {
    const p = profileWith({});
    p.groupTemplates = [workExperienceTemplate()];
    expect(matchTargets('  ', p, 0.3)).toEqual([]);
  });
});
