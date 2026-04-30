import { describe, expect, it } from 'vitest';
import { cosine, dot, norm } from '../src/background/rag/similarity';

describe('similarity', () => {
  it('dot of orthogonal vectors is zero', () => {
    expect(dot([1, 0], [0, 1])).toBe(0);
  });

  it('cosine of identical unit vectors is 1', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('cosine of antiparallel vectors is -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('cosine of orthogonal vectors is 0', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('handles non-unit vectors via norm', () => {
    expect(cosine([2, 0], [3, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 1], [2, 0])).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('returns 0 for zero vectors instead of NaN', () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
  });

  it('returns 0 for length mismatch', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('norm of unit vector is 1', () => {
    expect(norm([1, 0, 0, 0])).toBe(1);
  });
});
