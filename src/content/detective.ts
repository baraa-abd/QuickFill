// Tree-climbing label discovery + page context capture (§4.1).
//
// Returns `{ question, fieldType, options, currentValue, pageContext }` for
// a given element. The element ref must be captured synchronously by the
// caller BEFORE any await — see content/index.ts.

import type { FieldType } from '$shared/types';
import { ancestorsUpTo, closestAncestor, resolveIdRefs } from './shadow';

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
  /** outerHTML of el.parentElement?.parentElement, capped at MAX_GRANDPARENT_HTML chars. */
  grandparentHtml: string | null;
  /** Compact tag + key attributes for the focused element — enough to identify it inside grandparentHtml. */
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

export function classifyFieldType(el: Element): { fieldType: FieldType; rejected: DetectiveResult['rejected'] } {
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

export function getOptions(el: Element, fieldType: FieldType): string[] | null {
  if (fieldType === 'select' && el instanceof HTMLSelectElement) {
    return Array.from(el.options).map((o) => o.label || o.text || o.value);
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

// ───────────────────────── grandparent HTML + element descriptor ─────────────────────────

const MAX_GRANDPARENT_HTML = 3000;

/**
 * Returns the `outerHTML` of the focused element's grandparent (parent's
 * parent), hard-capped at MAX_GRANDPARENT_HTML characters. The grandparent
 * typically contains the question label, surrounding options, and the field
 * itself, giving the classifier rich structural context without sending the
 * entire page.
 */
export function captureGrandparentHtml(el: Element): string | null {
  const grandparent = el.parentElement?.parentElement;
  if (!grandparent) return null;
  const raw = grandparent.outerHTML;
  if (raw.length <= MAX_GRANDPARENT_HTML) return raw;
  return raw.slice(0, MAX_GRANDPARENT_HTML) + '…[truncated]';
}

/**
 * Produces a compact one-line HTML tag (no children, no value) that uniquely
 * identifies the focused field inside the grandparent HTML. Includes key
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

export function runDetective(el: Element): DetectiveResult {
  const { fieldType, rejected } = classifyFieldType(el);
  return {
    question: rejected ? null : climbForLabel(el),
    fieldType,
    options: rejected ? null : getOptions(el, fieldType),
    currentValue: rejected ? '' : getCurrentValue(el),
    pageContext: capturePageContext(),
    grandparentHtml: rejected ? null : captureGrandparentHtml(el),
    elementDescriptor: buildElementDescriptor(el),
    rejected
  };
}
