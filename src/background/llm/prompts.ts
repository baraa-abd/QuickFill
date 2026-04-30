// Prompt template rendering + lenient JSON extraction (§7.3).
//
//   - {{snake_case}} interpolation. Missing variables render as "".
//   - extractJson(text): strips ```code fences```, scans for the first
//     balanced { } or [ ] respecting string literals, returns null on failure.

const VAR_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export function renderPrompt(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(VAR_RE, (_, name) => {
    const v = vars[name];
    if (v == null) return '';
    return typeof v === 'string' ? v : String(v);
  });
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/m;

export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim();

  // Strip a single fenced block if it wraps the response.
  const m = s.match(FENCE_RE);
  if (m) s = m[1].trim();

  // Try parsing the whole thing first.
  const direct = tryParse<T>(s);
  if (direct != null) return direct;

  // Scan for the first balanced { } or [ ] respecting string literals.
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = findBalancedEnd(s, i);
    if (end < 0) continue;
    const slice = s.slice(i, end + 1);
    const parsed = tryParse<T>(slice);
    if (parsed != null) return parsed;
  }
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Returns the index of the matching `}` / `]` for the opener at `start`,
 * or -1 if not found. Respects double-quoted JSON strings (with backslash
 * escapes). Single-quoted strings are NOT JSON-legal but we treat them as
 * literal text (so we don't get confused by code samples).
 */
function findBalancedEnd(s: string, start: number): number {
  const opener = s[start];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
  if (!closer) return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
