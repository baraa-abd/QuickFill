// commit.ts uses native HTML element prototype setters — jsdom provides
// HTMLInputElement / HTMLTextAreaElement / HTMLSelectElement so these run
// the actual code path. Real browsers (React, Vue) need the prototype-setter
// trick; jsdom doesn't, but we still verify the events fire and the value
// lands.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coerceBool, commitValue, isSupportedFieldType } from '../src/content/commit';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('coerceBool', () => {
  it('treats "yes"/"true"/"1"/"checked" as true (case-insensitive)', () => {
    for (const v of ['yes', 'YES', 'true', 'True', '1', 'checked', 'CHECKED']) {
      expect(coerceBool(v)).toBe(true);
    }
  });
  it('everything else is false', () => {
    for (const v of ['no', 'false', '0', 'unchecked', '', '   ', 'maybe']) {
      expect(coerceBool(v)).toBe(false);
    }
  });
});

describe('isSupportedFieldType', () => {
  it('rejects only "unknown"', () => {
    expect(isSupportedFieldType('unknown')).toBe(false);
    for (const t of ['text', 'email', 'tel', 'url', 'number', 'date', 'password', 'textarea', 'select', 'radio', 'checkbox', 'contenteditable'] as const) {
      expect(isSupportedFieldType(t)).toBe(true);
    }
  });
});

describe('commitValue', () => {
  it('writes text input via the native setter and dispatches input + change', async () => {
    document.body.innerHTML = `<input id="x" type="text">`;
    const el = document.getElementById('x') as HTMLInputElement;
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    const r = await commitValue(el, 'text', 'hello');
    expect(r).toEqual({ ok: true });
    expect(el.value).toBe('hello');
    expect(events).toEqual(['input', 'change']);
  });

  it('writes textarea', async () => {
    document.body.innerHTML = `<textarea id="x"></textarea>`;
    const el = document.getElementById('x') as HTMLTextAreaElement;
    const r = await commitValue(el, 'textarea', 'multi\nline');
    expect(r).toEqual({ ok: true });
    expect(el.value).toBe('multi\nline');
  });

  it('select: matches by option value', async () => {
    document.body.innerHTML = `<select id="x"><option value="us">United States</option><option value="uk">United Kingdom</option></select>`;
    const el = document.getElementById('x') as HTMLSelectElement;
    const r = await commitValue(el, 'select', 'United Kingdom');
    expect(r).toEqual({ ok: true });
    expect(el.value).toBe('uk');
  });

  it('select: no-matching-option returns typed error without writing', async () => {
    document.body.innerHTML = `<select id="x"><option value="a">A</option></select>`;
    const el = document.getElementById('x') as HTMLSelectElement;
    const r = await commitValue(el, 'select', 'Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('no-matching-option');
  });

  it('checkbox: coerces value and dispatches events', async () => {
    document.body.innerHTML = `<input id="x" type="checkbox">`;
    const el = document.getElementById('x') as HTMLInputElement;
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    expect(await commitValue(el, 'checkbox', 'yes')).toEqual({ ok: true });
    expect(el.checked).toBe(true);
    expect(events).toEqual(['input', 'change']);
    expect(await commitValue(el, 'checkbox', 'no')).toEqual({ ok: true });
    expect(el.checked).toBe(false);
  });

  it('radio: ticks the matching radio in the group', async () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" name="g" value="a"><label>Apple</label>
        <input type="radio" name="g" value="b"><label>Banana</label>
      </form>`;
    const radios = document.querySelectorAll<HTMLInputElement>('input[type=radio]');
    const r = await commitValue(radios[0], 'radio', 'b');
    expect(r).toEqual({ ok: true });
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
  });

  it('radio: no-matching-radio returns typed error', async () => {
    document.body.innerHTML = `<form><input type="radio" name="g" value="a"></form>`;
    const r = await commitValue(document.querySelector('input')!, 'radio', 'z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('no-matching-radio');
  });

  it('contenteditable: replaces content via textContent (no innerHTML)', async () => {
    document.body.innerHTML = `<div id="x" contenteditable="true">old</div>`;
    const el = document.getElementById('x') as HTMLElement;
    const r = await commitValue(el, 'contenteditable', '<script>x</script>');
    expect(r).toEqual({ ok: true });
    // The angle brackets must survive verbatim — XSS guard via textContent.
    expect(el.textContent).toBe('<script>x</script>');
    // No <script> child element should have been created.
    expect(el.querySelector('script')).toBeNull();
  });

  it('detached element rejects', async () => {
    const el = document.createElement('input');
    expect((await commitValue(el, 'text', 'x')).ok).toBe(false);
  });

  it('mismatched type returns unsupported-field', async () => {
    document.body.innerHTML = `<input id="x" type="text">`;
    const el = document.getElementById('x') as HTMLInputElement;
    expect((await commitValue(el, 'select', 'whatever')).ok).toBe(false);
  });
});

// Silence vi-imports-without-use warning if any (reserved for future spies).
void vi;
