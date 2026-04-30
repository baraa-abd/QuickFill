// Shared cleaning recipe. Single helper used everywhere a label or
// question is normalized. Save-side and retrieve-side embed against the
// output of this — drift here silently kills retrieval recall (§6.2).

export function cleanLabel(input: string): string {
  if (!input) return '';
  // 1. NFKC.
  let s = input.normalize('NFKC');
  // 2. lowercase.
  s = s.toLowerCase();
  // 3. delete every non-alphanumeric non-whitespace char.
  //    \p{L}/\p{N} would broaden; spec is alphanumeric (ASCII semantics for v1).
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  // 4. collapse whitespace.
  s = s.replace(/\s+/g, ' ');
  // 5. trim.
  s = s.trim();
  return s;
}
