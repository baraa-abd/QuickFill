// Resume parser — fold logic only. The LLM call itself is exercised via the
// orchestrator; here we feed canned LLM JSON shapes to the pure folder.

import { describe, expect, it } from 'vitest';
import { foldResumeIntoProfile } from '../src/background/resume/parser';

describe('foldResumeIntoProfile', () => {
  it('cleans canonical keys before storing', () => {
    const out = foldResumeIntoProfile({
      profile: { 'First Name!!!': 'Ada', '  Last  NAME ': 'Lovelace' },
      stories: []
    });
    expect(Object.keys(out.profile.canonicalData).sort()).toEqual(['first name', 'last name']);
    expect(out.profile.canonicalData['first name']?.values).toEqual(['Ada']);
    expect(out.profile.aliasMap['first name']).toBe('first name');
  });

  it('auto-flags entries whose cleaned key matches SENSITIVE_CANONICAL_KEYS', () => {
    const out = foldResumeIntoProfile({
      profile: {
        'first name': 'Ada',
        'phone number': '555-0100',
        ssn: '111-22-3333'
      },
      stories: []
    });
    expect(out.profile.sensitiveKeys.sort()).toEqual(['phone number', 'ssn']);
  });

  it('skips empty values and empty cleaned keys', () => {
    const out = foldResumeIntoProfile({
      profile: { '': 'x', '!!!!': 'y', 'first name': '' },
      stories: []
    });
    expect(Object.keys(out.profile.canonicalData)).toEqual([]);
  });

  it('produces Story[] with stable shape and skips empty stories', () => {
    const out = foldResumeIntoProfile({
      profile: {},
      stories: [
        { content: ' Led migration. ', keywords: ['leadership'] },
        { content: '   ' }, // empty after trim
        { content: 'Mentored juniors.' } // missing keywords
      ]
    });
    expect(out.stories).toHaveLength(2);
    expect(out.stories[0].keywords).toEqual(['leadership']);
    expect(out.stories[1].keywords).toEqual([]);
    expect(out.stories[0].id).toBeTruthy();
    expect(out.stories[0].content).toBe('Led migration.');
  });

  it('coerces numeric / boolean profile values to strings', () => {
    const out = foldResumeIntoProfile({
      profile: { 'years experience': 7, 'has us authorization': true },
      stories: []
    });
    expect(out.profile.canonicalData['years experience']?.values).toEqual(['7']);
    expect(out.profile.canonicalData['has us authorization']?.values).toEqual(['true']);
  });

  it('dedupes a duplicate value into the same canonical key (collisions on different rawKey casings)', () => {
    const out = foldResumeIntoProfile({
      profile: { 'first name': 'Ada', 'First Name': 'Ada' },
      stories: []
    });
    // Same cleaned key, same value → dedupes to one value.
    expect(out.profile.canonicalData['first name']?.values).toEqual(['Ada']);
  });
});
