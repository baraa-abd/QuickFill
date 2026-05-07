// Tree-climbing label discovery + page context capture (§4.1).
//
// Returns `{ question, fieldType, options, currentValue, pageContext }` for
// a given element. The element ref must be captured synchronously by the
// caller BEFORE any await — see content/index.ts.

import type { FieldType, Settings } from '$shared/types';
import { ancestorsUpTo, closestAncestor, resolveIdRefs, waitForElement } from './shadow';

export type DetectiveResult = {
  question: string | null;
  fieldType: FieldType;
  options: string[] | null;
  currentValue: string;
  pageContext: {
    title: string;
    hostname: string;
    siteName: string | null;
    h1: string | null;
  };
  /**
   * Cleaned + pruned outerHTML of a smartly chosen ancestor of the focused
   * element (climb up to the first ancestor containing a *different* input
   * field, plus one more level, capped at 6 levels). The focused element
   * carries a `data-quickfill-focus="1"` marker so the classifier can locate
   * it inside the snippet. Capped at MAX_ANCESTOR_HTML chars.
   */
  ancestorHtml: string | null;
  /** Plain-text innerText of the same ancestor, capped at MAX_ANCESTOR_INNER_TEXT chars. */
  ancestorInnerText: string | null;
  /** Compact tag + key attributes for the focused element — fallback identifier when ancestorHtml is null. */
  elementDescriptor: string;
  rejected: 'disabled' | 'readonly' | 'file' | null;
};

const MAX_DATA_ATTR_LEN = 200;

// ───────────────────────── tree climbing ─────────────────────────

export function climbForLabel(el: Element): string | null {
  // 1. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refs = resolveIdRefs(el, labelledBy);
    if (refs.length) {
      const joined = refs.map((r) => textOf(r)).filter(Boolean).join(' ').trim();
      if (joined) return joined;
    }
  }
  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();
  // 3. ancestor <label>
  const label = closestAncestor(el, 'label');
  if (label) {
    const t = textOf(label);
    if (t) return t;
  }
  // also: <label for="id"> living elsewhere
  if (el.id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const matches = (root as Document).querySelectorAll
      ? (root as Document).querySelectorAll(`label[for="${cssEscape(el.id)}"]`)
      : null;
    if (matches && matches.length) {
      const t = textOf(matches[0]);
      if (t) return t;
    }
  }
  // 4. up to 3 preceding siblings — first non-empty line of innerText
  let sib: Element | null = el.previousElementSibling;
  for (let i = 0; i < 3 && sib; i++) {
    const line = firstLine(textOf(sib));
    if (line) return line;
    sib = sib.previousElementSibling;
  }
  // 5. up to 5 ancestor levels, data-*/legend/label/h1-h6
  for (const anc of ancestorsUpTo(el, 5)) {
    for (const attr of ['data-label', 'data-question', 'data-field-label', 'data-testid'] as const) {
      const v = anc.getAttribute(attr);
      if (v && v.trim()) return v.trim().slice(0, MAX_DATA_ATTR_LEN);
    }
    const direct = anc.querySelector(':scope > legend, :scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
    if (direct) {
      const t = textOf(direct);
      if (t) return t;
    }
  }
  // 6. give up
  return null;
}

function textOf(el: Element): string {
  // innerText on HTMLElement gives a layout-aware rendering; on SVG/MathML it
  // doesn't exist — fall back to textContent.
  const v = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return v.replace(/\s+/g, ' ').trim();
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? s;
}

function cssEscape(s: string): string {
  return (window.CSS && (window.CSS as { escape?: (s: string) => string }).escape)
    ? (window.CSS as { escape: (s: string) => string }).escape(s)
    : s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

// ───────────────────────── field type + options + current value ─────────────────────────

function isAriaListboxButton(el: Element): el is HTMLButtonElement {
  return el instanceof HTMLButtonElement && el.getAttribute('aria-haspopup') === 'listbox';
}

export function classifyFieldType(el: Element): { fieldType: FieldType; rejected: DetectiveResult['rejected'] } {
  if (el instanceof HTMLButtonElement) {
    if (el.disabled) return { fieldType: 'unknown', rejected: 'disabled' };
    if (el.getAttribute('aria-haspopup') === 'listbox') return { fieldType: 'select', rejected: null };
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled) return { fieldType: 'unknown', rejected: 'disabled' };
    if (el.readOnly) return { fieldType: 'unknown', rejected: 'readonly' };
    const t = (el.type || 'text').toLowerCase();
    if (t === 'file') return { fieldType: 'unknown', rejected: 'file' };
    if (t === 'checkbox') return { fieldType: 'checkbox', rejected: null };
    if (t === 'radio') return { fieldType: 'radio', rejected: null };
    if (['email', 'tel', 'url', 'number', 'date', 'password'].includes(t))
      return { fieldType: t as FieldType, rejected: null };
    return { fieldType: 'text', rejected: null };
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.disabled) return { fieldType: 'textarea', rejected: 'disabled' };
    if (el.readOnly) return { fieldType: 'textarea', rejected: 'readonly' };
    return { fieldType: 'textarea', rejected: null };
  }
  if (el instanceof HTMLSelectElement) {
    if (el.disabled) return { fieldType: 'select', rejected: 'disabled' };
    return { fieldType: 'select', rejected: null };
  }
  if (el instanceof HTMLElement && isContentEditableEl(el)) {
    return { fieldType: 'contenteditable', rejected: null };
  }
  return { fieldType: 'unknown', rejected: null };
}

/**
 * Robust contenteditable detection. Real Chrome populates
 * `el.isContentEditable`; jsdom does not. Fall back to the attribute, which
 * is the spec source of truth: the `contentEditable` IDL attribute is
 * derived from the `contenteditable` content attribute (per HTML §6.6).
 */
function isContentEditableEl(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const attr = el.getAttribute('contenteditable');
  if (attr == null) return false;
  const v = attr.toLowerCase();
  return v === '' || v === 'true' || v === 'plaintext-only';
}

export async function getOptions(el: Element, fieldType: FieldType): Promise<string[] | null> {
  if (fieldType === 'select' && el instanceof HTMLSelectElement) {
    return Array.from(el.options).map((o) => o.label || o.text || o.value);
  }
  if (fieldType === 'select' && isAriaListboxButton(el)) {
    return extractListboxOptions(el);
  }
  if (fieldType === 'radio' && el instanceof HTMLInputElement && el.name) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const formScope = el.form ?? root;
    const all = (formScope as Document).querySelectorAll
      ? Array.from(
          (formScope as Document).querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${cssEscape(el.name)}"]`
          )
        )
      : [];
    return all.map((r) => labelForRadio(r));
  }
  return null;
}

async function extractListboxOptions(button: HTMLButtonElement): Promise<string[]> {
  button.click();
  // Wait for options to be populated, not just the listbox container.
  const firstOption = await waitForElement('[role="option"]', 2000, button.ownerDocument);
  let options: string[] = [];
  if (firstOption) {
    // Prefer the listbox aria-controls points to; fall back to any listbox.
    const listboxId = button.getAttribute('aria-controls');
    const searchRoot = (listboxId ? button.ownerDocument.getElementById(listboxId) : null)
      ?? button.ownerDocument.querySelector('[role="listbox"]')
      ?? button.ownerDocument.documentElement;
    options = Array.from(searchRoot.querySelectorAll('[role="option"]'))
      .map((o) => (o as HTMLElement).textContent?.trim() ?? '')
      .filter(Boolean);
  }
  // Close by toggling — clicking the button again is more reliable than Escape.
  button.click();
  return options;
}

function labelForRadio(r: HTMLInputElement): string {
  // Associated <label> via for=, ancestor, or sibling text.
  if (r.id) {
    const root = r.getRootNode() as Document | ShadowRoot;
    const lbl = (root as Document).querySelector?.(`label[for="${cssEscape(r.id)}"]`);
    if (lbl) return (lbl.textContent ?? '').trim();
  }
  const anc = closestAncestor(r, 'label');
  if (anc) return (anc.textContent ?? '').trim();
  return r.value;
}

export function getCurrentValue(el: Element): string {
  if (isAriaListboxButton(el)) {
    // Prefer the companion hidden text input (Workday pattern); fall back to
    // the button's own value attribute, which Workday also keeps in sync.
    const companion = el.parentElement?.querySelector<HTMLInputElement>('input[type="text"]');
    return companion?.value.trim() ?? el.value.trim();
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    if (el.type === 'radio') {
      // Find which radio in this group is currently checked.
      if (el.name) {
        const root = el.getRootNode() as Document | ShadowRoot;
        const formScope = el.form ?? root;
        const checked = (formScope as Document).querySelector?.(
          `input[type="radio"][name="${cssEscape(el.name)}"]:checked`
        ) as HTMLInputElement | null;
        return checked?.value ?? '';
      }
      return el.checked ? el.value : '';
    }
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLSelectElement) return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText;
  return '';
}

// ───────────────────────── ancestor HTML + element descriptor ─────────────────────────

// Fallback defaults used when no detector settings are supplied.
const DEFAULT_MAX_ANCESTOR_HTML = 15000;
const DEFAULT_MAX_ANCESTOR_INNER_TEXT = 300;
const DEFAULT_MAX_ANCESTOR_LEVELS = 7;
const DEFAULT_EXTRA_ANCESTOR_LEVELS_AFTER_MATCH = 2;
const DEFAULT_MAX_ATTR_VALUE_LEN = 120;

const FOCUS_MARKER_ATTR = 'data-quickfill-focus';

export type DetectorSettings = Settings['detector'];

// Form controls that count as "a different input field" when looking for the
// smallest ancestor that bundles the focused field with a sibling field.
// Plain <button>s (e.g. submit/back/menu) are intentionally excluded — they're
// not data-entry fields.
const FORM_CONTROL_SELECTOR =
  'input:not([type="hidden"]),textarea,select,'
  + 'button[aria-haspopup="listbox"],button[role="combobox"],'
  + '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

// Tags whose subtrees carry no useful context for the classifier.
const STRIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META',
  'SVG', 'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'PICTURE', 'SOURCE'
]);

// Attributes worth keeping. Everything else (style, class, srcset, on*, most
// data-*, framework noise) is dropped during cleaning.
const KEEP_ATTRS = new Set([
  'id', 'name', 'type', 'placeholder', 'value', 'role',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required',
  'aria-haspopup', 'aria-checked', 'aria-selected', 'aria-disabled',
  'for', 'checked', 'selected', 'disabled', 'readonly', 'required',
  'min', 'max', 'step', 'pattern', 'maxlength', 'minlength',
  'data-label', 'data-question', 'data-field-label', 'data-testid',
  FOCUS_MARKER_ATTR,
  'href', 'alt', 'title'
]);

export type AncestorContext = {
  html: string | null;
  innerText: string | null;
};

/**
 * Capture structural + textual context for the classifier.
 *
 * 1. Climb up to the smallest ancestor whose subtree contains a *different*
 *    form control than the focused element, then go `extraAncestorLevelsAfterMatch`
 *    levels beyond it (capped at MAX_ANCESTOR_LEVELS). This adapts depth to
 *    the actual form structure rather than using a fixed level.
 * 2. Clone the chosen ancestor so all subsequent edits are off-DOM.
 * 3. Tag the focused element's clone with `data-quickfill-focus="1"` so the
 *    classifier can locate it inside the snippet without relying on
 *    elementDescriptor matching being unambiguous.
 * 4. Clean: drop noise tags (script/style/svg/...), drop comments, strip all
 *    attributes except a small allowlist, truncate long attribute values.
 * 5. Prune (text-preserving): elements *not* on the focused element's
 *    ancestor spine are flattened to their visible text — wrapper tag is
 *    kept so nearby labels remain locatable, but their nested structure
 *    (deep cousin branches) is discarded.
 * 6. Truncate: if the result still exceeds MAX_ANCESTOR_HTML, take a window
 *    ending right after the focused element's closing tag and extending
 *    backward as far as possible (information before the focus is more
 *    important — the focus is typically near the bottom of its own
 *    subtree).
 *
 * The plain-text `innerText` of the same ancestor (capped) is returned
 * alongside as a dense sidecar that's robust to HTML noise.
 */
export function captureAncestorContext(el: Element, ds?: DetectorSettings): AncestorContext {
  const maxLevels    = ds?.maxAncestorLevels    ?? DEFAULT_MAX_ANCESTOR_LEVELS;
  const extraLevels  = Math.max(
    0,
    ds?.extraAncestorLevelsAfterMatch ?? DEFAULT_EXTRA_ANCESTOR_LEVELS_AFTER_MATCH
  );
  const maxInnerText = ds?.maxAncestorInnerText ?? DEFAULT_MAX_ANCESTOR_INNER_TEXT;
  const maxHtml      = ds?.maxAncestorHtml      ?? DEFAULT_MAX_ANCESTOR_HTML;
  const maxAttrLen   = ds?.maxAttrValueLen      ?? DEFAULT_MAX_ATTR_VALUE_LEN;

  const ancestors: Element[] = [];
  let cur = el.parentElement;
  while (cur && ancestors.length < maxLevels) {
    ancestors.push(cur);
    cur = cur.parentElement;
  }
  if (ancestors.length === 0) return { html: null, innerText: null };

  // Climb to the smallest ancestor whose subtree contains a form control
  // distinct from the focused element, then continue `extraLevels` more
  // levels (some sites bury the question text high above the input).
  // Both steps are jointly capped by `maxLevels` via the `ancestors` array
  // length: even if extraLevels is large, we never read past the array end.
  let chosenIdx = ancestors.length - 1;
  for (let i = 0; i < ancestors.length; i++) {
    if (containsDifferentFormControl(ancestors[i], el)) {
      chosenIdx = Math.min(i + extraLevels, ancestors.length - 1);
      break;
    }
  }
  const ancestor = ancestors[chosenIdx];

  // Path from ancestor down to the focused element (childIndex per level).
  const path: number[] = [];
  let p: Element = el;
  while (p !== ancestor) {
    const parent = p.parentElement;
    if (!parent) return { html: null, innerText: null };
    path.unshift(Array.from(parent.children).indexOf(p));
    p = parent;
  }

  const rawText = ((ancestor as HTMLElement).innerText ?? ancestor.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const innerText = rawText ? rawText.slice(0, maxInnerText) : null;

  const clone = ancestor.cloneNode(true) as Element;
  let focusedClone: Element | null = clone;
  for (const idx of path) {
    const next: Element | undefined = focusedClone?.children[idx];
    if (!next) { focusedClone = null; break; }
    focusedClone = next;
  }
  if (!focusedClone) return { html: null, innerText };

  focusedClone.setAttribute(FOCUS_MARKER_ATTR, '1');
  cleanElement(clone, maxAttrLen);

  const spine = new Set<Element>();
  let n: Element | null = focusedClone;
  while (n) {
    spine.add(n);
    if (n === clone) break;
    n = n.parentElement;
  }
  pruneNonSpine(clone, spine);

  const fullHtml = clone.outerHTML;
  const html = truncateAroundFocus(fullHtml, focusedClone.outerHTML, maxHtml);
  return { html, innerText };
}

function containsDifferentFormControl(ancestor: Element, focused: Element): boolean {
  const matches = ancestor.querySelectorAll(FORM_CONTROL_SELECTOR);
  for (const m of matches) if (m !== focused) return true;
  return false;
}

function cleanElement(el: Element, maxAttrLen: number): void {
  // Walk children first so replacements/removals propagate up cleanly.
  for (const child of Array.from(el.children)) {
    if (STRIP_TAGS.has(child.tagName)) {
      child.remove();
      continue;
    }
    cleanElement(child, maxAttrLen);
  }
  // Remove comment nodes at this level.
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 8 /* COMMENT_NODE */) node.parentNode?.removeChild(node);
  }
  // Strip attributes not on the allowlist; truncate long values on those kept.
  for (const attr of Array.from(el.attributes)) {
    if (!KEEP_ATTRS.has(attr.name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (attr.value.length > maxAttrLen) {
      el.setAttribute(attr.name, attr.value.slice(0, maxAttrLen));
    }
  }
}

function pruneNonSpine(root: Element, spine: Set<Element>): void {
  for (const child of Array.from(root.children)) {
    if (spine.has(child)) {
      pruneNonSpine(child, spine);
      continue;
    }
    // Non-spine element: keep its tag + attrs but flatten its subtree to
    // visible text. Preserves labels/option text while discarding wrapper
    // depth and cousin nesting.
    const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
    while (child.firstChild) child.removeChild(child.firstChild);
    if (text) child.textContent = text;
  }
}

function truncateAroundFocus(fullHtml: string, focusOuter: string, maxHtml: number): string {
  if (fullHtml.length <= maxHtml) return fullHtml;
  const markerIdx = fullHtml.indexOf(`${FOCUS_MARKER_ATTR}="1"`);
  if (markerIdx < 0) {
    return fullHtml.slice(0, maxHtml) + '…[truncated]';
  }
  const tagStart = fullHtml.lastIndexOf('<', markerIdx);
  const tagEnd = tagStart >= 0 ? tagStart + focusOuter.length : markerIdx + focusOuter.length;
  const safeEnd = Math.min(tagEnd, fullHtml.length);
  const start = Math.max(0, safeEnd - maxHtml);
  const sliced = fullHtml.slice(start, safeEnd);
  return start > 0 ? '…[truncated]…' + sliced : sliced;
}

/**
 * Produces a compact one-line HTML tag (no children, no value) that uniquely
 * identifies the focused field. Used as a fallback identifier when the
 * ancestor HTML is unavailable. Includes key
 * attributes only: id, name, type, placeholder, aria-label, aria-labelledby,
 * data-testid. Class is intentionally omitted (too noisy with Tailwind etc.).
 */
export function buildElementDescriptor(el: Element): string {
  const ATTRS = ['id', 'name', 'type', 'placeholder', 'aria-label', 'aria-labelledby', 'data-testid'] as const;
  const parts: string[] = [];
  for (const attr of ATTRS) {
    const v = el.getAttribute(attr);
    if (v) parts.push(`${attr}="${v.slice(0, 100)}"`);
  }
  return `<${el.tagName.toLowerCase()}${parts.length ? ' ' + parts.join(' ') : ''}>`;
}

// ───────────────────────── page context ─────────────────────────

export function capturePageContext(): DetectiveResult['pageContext'] {
  const og = document.querySelector('meta[property="og:site_name"]');
  const h1 = document.querySelector('h1');
  return {
    title: document.title || '',
    hostname: location.hostname || '',
    siteName: og?.getAttribute('content') ?? null,
    h1: h1 ? (h1.textContent ?? '').trim() || null : null
  };
}

// ───────────────────────── public entry ─────────────────────────

export async function runDetective(el: Element, ds?: DetectorSettings): Promise<DetectiveResult> {
  const { fieldType, rejected } = classifyFieldType(el);
  const ancestor = rejected ? { html: null, innerText: null } : captureAncestorContext(el, ds);
  return {
    question: rejected ? null : climbForLabel(el),
    fieldType,
    options: rejected ? null : await getOptions(el, fieldType),
    currentValue: rejected ? '' : getCurrentValue(el),
    pageContext: capturePageContext(),
    ancestorHtml: ancestor.html,
    ancestorInnerText: ancestor.innerText,
    elementDescriptor: buildElementDescriptor(el),
    rejected
  };
}
