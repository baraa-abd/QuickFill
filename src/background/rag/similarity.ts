// Vector math. Embeddings are L2-normalized at the offscreen layer
// (pooling: 'mean', normalize: true), so cosine = dot product. We provide
// both helpers for clarity and robustness against future embedding model
// swaps that might not normalize.

export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const d = dot(a, b);
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return d / (na * nb);
}
