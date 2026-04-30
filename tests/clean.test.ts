import { describe, expect, it } from 'vitest';
import { cleanLabel } from '../src/shared/clean';

describe('cleanLabel', () => {
  it('lowercases', () => {
    expect(cleanLabel('First Name')).toBe('first name');
  });

  it('drops punctuation', () => {
    expect(cleanLabel('What is your favorite color?!')).toBe('what is your favorite color');
  });

  it('collapses internal whitespace and trims', () => {
    expect(cleanLabel('  hello   world  ')).toBe('hello world');
  });

  it('NFKC normalizes (fullwidth → ASCII)', () => {
    // Fullwidth ＡＤＤＲＥＳＳ → ADDRESS → address.
    expect(cleanLabel('ＡＤＤＲＥＳＳ')).toBe('address');
  });

  it('NFKC normalizes ligatures', () => {
    // ﬁ (U+FB01) → fi.
    expect(cleanLabel('Ofﬁce')).toBe('office');
  });

  it('handles empty input', () => {
    expect(cleanLabel('')).toBe('');
    expect(cleanLabel('   ')).toBe('');
  });

  it('treats hyphens, slashes, and underscores as separators', () => {
    expect(cleanLabel('first-name')).toBe('first name');
    expect(cleanLabel('first_name')).toBe('first name');
    expect(cleanLabel('first/name')).toBe('first name');
  });

  it('preserves digits', () => {
    expect(cleanLabel('Question 4 of 10:')).toBe('question 4 of 10');
  });

  it('idempotent', () => {
    const a = cleanLabel('Why this Company?  ');
    expect(cleanLabel(a)).toBe(a);
  });
});
