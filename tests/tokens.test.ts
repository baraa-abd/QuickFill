import { describe, expect, it } from 'vitest';
import { estimateTokens, getContextWindow } from '../src/shared/tokens';

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('over-counts vs cl100k (intentional)', () => {
    // 35 chars / 3.5 = 10.
    const s = 'a'.repeat(35);
    expect(estimateTokens(s)).toBe(10);
  });

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/3.5 = 0.857 → 1
  });
});

describe('getContextWindow', () => {
  it('falls back to 8192 for unknown models', () => {
    expect(getContextWindow('not-a-real-model')).toBe(8192);
  });

  it('looks up known models', () => {
    expect(getContextWindow('gpt-4o-mini')).toBe(128_000);
    expect(getContextWindow('claude-sonnet-4-6')).toBe(200_000);
  });

  it('honors custom overrides', () => {
    expect(getContextWindow('weird:model', { 'weird:model': 4096 })).toBe(4096);
  });

  it('overrides win over known', () => {
    // User can override even known defaults.
    expect(getContextWindow('gpt-4o-mini', { 'gpt-4o-mini': 32_000 })).toBe(32_000);
  });
});
