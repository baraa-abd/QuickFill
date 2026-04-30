// Native-setter commits + revert capture (§4.2 commit notes).
//
// For React / Vue / Angular host pages, assigning `element.value = ...`
// directly is silently overwritten on the next render because those frameworks
// monkey-patch the property descriptor for change detection. The fix is to
// resolve the *prototype* setter via Object.getOwnPropertyDescriptor and call
// it explicitly.

import type { FieldType } from '$shared/types';
import { closestAncestor } from './shadow';

// Pre-cached prototype setters. These exist regardless of any framework patching.
const inputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value'
)?.set;
const textareaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value'
)?.set;
const checkboxCheckedSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'checked'
)?.set;
const selectValueSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value'
)?.set;

function fire(el: Element, type: 'input' | 'change'): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

export type CommitError = {
  ok: false;
  kind: 'unsupported-field' | 'no-setter' | 'no-matching-radio' | 'no-matching-option' | 'detached';
  message: string;
};

export type CommitOk = { ok: true };

export type CommitResult = CommitOk | CommitError;

/**
 * Commit `value` to the element using the native prototype setter. Returns
 * a typed error instead of partially writing on failure.
 *
 * For checkboxes and radios, `value` is interpreted/matched per spec.
 * For selects, the value must match an option's `value` (the chooser prompt
 * upstream is responsible for picking a viable string).
 */
export function commitValue(el: Element, fieldType: FieldType, value: string): CommitResult {
  if (!el.isConnected) {
    return { ok: false, kind: 'detached', message: 'element is detached from the document' };
  }

  const previousActive = (el.ownerDocument?.activeElement as HTMLElement | null) ?? null;

  try {
    switch (fieldType) {
      case 'text':
      case 'email':
      case 'tel':
      case 'url':
      case 'number':
      case 'date':
      case 'password': {
        if (!(el instanceof HTMLInputElement)) {
          return { ok: false, kind: 'unsupported-field', message: 'expected HTMLInputElement' };
        }
        if (!inputValueSetter) {
          return { ok: false, kind: 'no-setter', message: 'no native input value setter' };
        }
        inputValueSetter.call(el, value);
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      case 'textarea': {
        if (!(el instanceof HTMLTextAreaElement)) {
          return { ok: false, kind: 'unsupported-field', message: 'expected HTMLTextAreaElement' };
        }
        if (!textareaValueSetter) {
          return { ok: false, kind: 'no-setter', message: 'no native textarea value setter' };
        }
        textareaValueSetter.call(el, value);
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      case 'select': {
        if (!(el instanceof HTMLSelectElement)) {
          return { ok: false, kind: 'unsupported-field', message: 'expected HTMLSelectElement' };
        }
        if (!selectValueSetter) {
          return { ok: false, kind: 'no-setter', message: 'no native select value setter' };
        }
        // Find the option that matches by value, label or text — case-insensitive.
        const target = matchSelectOption(el, value);
        if (!target) {
          return {
            ok: false,
            kind: 'no-matching-option',
            message: `no <option> matches "${value}"`
          };
        }
        selectValueSetter.call(el, target.value);
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      case 'checkbox': {
        if (!(el instanceof HTMLInputElement)) {
          return { ok: false, kind: 'unsupported-field', message: 'expected checkbox input' };
        }
        if (!checkboxCheckedSetter) {
          return { ok: false, kind: 'no-setter', message: 'no native checked setter' };
        }
        checkboxCheckedSetter.call(el, coerceBool(value));
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      case 'radio': {
        if (!(el instanceof HTMLInputElement) || !el.name) {
          return { ok: false, kind: 'unsupported-field', message: 'expected named radio input' };
        }
        const root = el.getRootNode() as Document | ShadowRoot;
        const scope = el.form ?? root;
        const list = (scope as Document).querySelectorAll
          ? Array.from(
              (scope as Document).querySelectorAll<HTMLInputElement>(
                `input[type="radio"][name="${cssEscape(el.name)}"]`
              )
            )
          : [];
        const target = matchRadio(list, value);
        if (!target) {
          return {
            ok: false,
            kind: 'no-matching-radio',
            message: `no radio in group "${el.name}" matches "${value}"`
          };
        }
        if (checkboxCheckedSetter) checkboxCheckedSetter.call(target, true);
        else target.checked = true;
        fire(target, 'input');
        fire(target, 'change');
        return { ok: true };
      }
      case 'contenteditable': {
        const isCe =
          el instanceof HTMLElement &&
          (el.isContentEditable ||
            (() => {
              const a = el.getAttribute('contenteditable');
              if (a == null) return false;
              const v = a.toLowerCase();
              return v === '' || v === 'true' || v === 'plaintext-only';
            })());
        if (!isCe) {
          return { ok: false, kind: 'unsupported-field', message: 'expected contenteditable' };
        }
        // Replace content safely (no innerHTML — XSS risk per spec).
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(document.createTextNode(value));
        // Move caret to end.
        const sel = el.ownerDocument!.getSelection();
        if (sel) {
          const range = el.ownerDocument!.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      default:
        return {
          ok: false,
          kind: 'unsupported-field',
          message: `field type ${fieldType} is not supported`
        };
    }
  } finally {
    // Best-effort focus restoration if a commit blurred the field.
    if (previousActive && previousActive.isConnected && document.activeElement !== previousActive) {
      try {
        previousActive.focus();
      } catch {
        /* */
      }
    }
  }
}

function matchSelectOption(sel: HTMLSelectElement, value: string): HTMLOptionElement | null {
  const target = value.trim().toLowerCase();
  for (const o of Array.from(sel.options)) {
    if (
      o.value.toLowerCase() === target ||
      (o.label || '').toLowerCase() === target ||
      (o.text || '').toLowerCase() === target
    ) {
      return o;
    }
  }
  return null;
}

function matchRadio(list: HTMLInputElement[], value: string): HTMLInputElement | null {
  const target = value.trim().toLowerCase();
  for (const r of list) {
    if (r.value.toLowerCase() === target) return r;
    // Compare against associated label text.
    let labelText: string | null = null;
    if (r.id) {
      const root = r.getRootNode() as Document | ShadowRoot;
      const lbl = (root as Document).querySelector?.(`label[for="${cssEscape(r.id)}"]`);
      labelText = lbl?.textContent?.trim().toLowerCase() ?? null;
    }
    if (!labelText) {
      const anc = closestAncestor(r, 'label');
      labelText = anc?.textContent?.trim().toLowerCase() ?? null;
    }
    if (labelText && labelText === target) return r;
  }
  return null;
}

export function coerceBool(v: string): boolean {
  return ['yes', 'true', '1', 'checked'].includes(v.trim().toLowerCase());
}

function cssEscape(s: string): string {
  return (window.CSS && (window.CSS as { escape?: (s: string) => string }).escape)
    ? (window.CSS as { escape: (s: string) => string }).escape(s)
    : s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

/**
 * Whether a field type can be filled programmatically. The "yet" wording
 * matches the spec — `unknown` is the only catch-all.
 */
export function isSupportedFieldType(t: FieldType): boolean {
  return t !== 'unknown';
}
