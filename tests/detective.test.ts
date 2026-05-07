import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureAncestorContext,
  capturePageContext,
  classifyFieldType,
  climbForLabel,
  getCurrentValue,
  getOptions
} from '../src/content/detective';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'AutoFill test';
});

describe('climbForLabel — priority order', () => {
  it('1. aria-labelledby resolves and joins', () => {
    document.body.innerHTML = `
      <span id="a">Why</span><span id="b">us?</span>
      <input aria-labelledby="a b" id="x">`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Why us?');
  });

  it('2. aria-label wins when no labelledby', () => {
    document.body.innerHTML = `<input aria-label="Email address" id="x">`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Email address');
  });

  it('3. ancestor <label>', () => {
    document.body.innerHTML = `<label>Phone <input id="x"></label>`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Phone');
  });

  it('3b. <label for=id>', () => {
    document.body.innerHTML = `<label for="x">First name</label><input id="x">`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('First name');
  });

  it('4. preceding sibling first non-empty line', () => {
    document.body.innerHTML = `<div>Why this company?</div><input id="x">`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Why this company?');
  });

  it('5. ancestor data-label', () => {
    document.body.innerHTML = `<div data-label="Years of experience"><input id="x"></div>`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Years of experience');
  });

  it('5b. ancestor direct child <legend>', () => {
    document.body.innerHTML = `<fieldset><legend>Citizenship</legend><div><input id="x"></div></fieldset>`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Citizenship');
  });

  it('6. returns null when nothing fits', () => {
    document.body.innerHTML = `<input id="x">`;
    expect(climbForLabel(document.getElementById('x')!)).toBeNull();
  });

  it('respects priority — aria-label beats ancestor <label>', () => {
    document.body.innerHTML = `<label>Wrong <input id="x" aria-label="Right"></label>`;
    expect(climbForLabel(document.getElementById('x')!)).toBe('Right');
  });
});

describe('classifyFieldType', () => {
  it('rejects disabled input', () => {
    document.body.innerHTML = `<input id="x" disabled>`;
    const r = classifyFieldType(document.getElementById('x')!);
    expect(r.rejected).toBe('disabled');
  });

  it('rejects readonly input', () => {
    document.body.innerHTML = `<input id="x" readonly>`;
    expect(classifyFieldType(document.getElementById('x')!).rejected).toBe('readonly');
  });

  it('rejects type=file', () => {
    document.body.innerHTML = `<input id="x" type="file">`;
    expect(classifyFieldType(document.getElementById('x')!).rejected).toBe('file');
  });

  it('classifies email/tel/url/number/date/password', () => {
    for (const t of ['email', 'tel', 'url', 'number', 'date', 'password']) {
      document.body.innerHTML = `<input id="x" type="${t}">`;
      expect(classifyFieldType(document.getElementById('x')!).fieldType).toBe(t);
    }
  });

  it('classifies textarea', () => {
    document.body.innerHTML = `<textarea id="x"></textarea>`;
    expect(classifyFieldType(document.getElementById('x')!).fieldType).toBe('textarea');
  });

  it('classifies select / checkbox / radio', () => {
    document.body.innerHTML = `<select id="s"></select>`;
    expect(classifyFieldType(document.getElementById('s')!).fieldType).toBe('select');
    document.body.innerHTML = `<input id="c" type="checkbox">`;
    expect(classifyFieldType(document.getElementById('c')!).fieldType).toBe('checkbox');
    document.body.innerHTML = `<input id="r" type="radio" name="g">`;
    expect(classifyFieldType(document.getElementById('r')!).fieldType).toBe('radio');
  });

  it('classifies contenteditable', () => {
    document.body.innerHTML = `<div id="x" contenteditable="true"></div>`;
    expect(classifyFieldType(document.getElementById('x')!).fieldType).toBe('contenteditable');
  });
});

describe('getOptions', () => {
  it('select options use label/text/value precedence', async () => {
    document.body.innerHTML = `<select id="x"><option value="a">Apple</option><option value="b">Banana</option></select>`;
    expect(await getOptions(document.getElementById('x')!, 'select')).toEqual(['Apple', 'Banana']);
  });

  it('radio options pull from associated labels', async () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" id="r1" name="g" value="a"><label for="r1">Apple</label>
        <input type="radio" id="r2" name="g" value="b"><label for="r2">Banana</label>
      </form>`;
    expect(await getOptions(document.querySelector('#r1')!, 'radio')).toEqual(['Apple', 'Banana']);
  });
});

describe('getCurrentValue', () => {
  it('reads input value', () => {
    document.body.innerHTML = `<input id="x" value="hi">`;
    expect(getCurrentValue(document.getElementById('x')!)).toBe('hi');
  });
  it('reads checkbox as "true"/"false"', () => {
    document.body.innerHTML = `<input id="x" type="checkbox" checked>`;
    expect(getCurrentValue(document.getElementById('x')!)).toBe('true');
  });
  it('reads selected radio in the group', () => {
    document.body.innerHTML = `<form><input type="radio" name="g" value="a"><input type="radio" name="g" value="b" checked></form>`;
    const first = document.querySelector('input')!;
    expect(getCurrentValue(first)).toBe('b');
  });
});

describe('captureAncestorContext', () => {
  it('climbs to first ancestor with a different field, then one more level', () => {
    document.body.innerHTML = `
      <section id="outer">
        <div id="row">
          <label>First name</label>
          <div id="wrap"><input id="x"></div>
          <div><input id="y"></div>
        </div>
      </section>`;
    const r = captureAncestorContext(document.getElementById('x')!);
    // #row contains the sibling input (#y), so we go up one more → #outer.
    expect(r.html).toContain('id="outer"');
    expect(r.html).toContain('data-quickfill-focus="1"');
  });

  it('falls back to the deepest reachable ancestor (capped at 6) when no sibling field exists', () => {
    document.body.innerHTML = `<div id="a"><div id="b"><div id="c"><input id="x"></div></div></div>`;
    const r = captureAncestorContext(document.getElementById('x')!);
    // No different input anywhere → climbs to body (max 6 levels up).
    expect(r.html).toContain('data-quickfill-focus="1"');
  });

  it('strips style/class/script and noisy attributes', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Citizenship</legend>
        <style>.a{color:red}</style>
        <div class="wrap" style="color:red" onclick="x()">
          <input id="x" class="ignored" type="text" placeholder="enter" data-something="z">
          <input id="y">
        </div>
      </fieldset>`;
    const html = captureAncestorContext(document.getElementById('x')!).html!;
    expect(html).not.toContain('style="color:red"');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('data-something');
    expect(html).toContain('placeholder="enter"');
    expect(html).toContain('Citizenship');
  });

  it('flattens cousin subtrees to their visible text but keeps their tags', () => {
    document.body.innerHTML = `
      <section>
        <div class="cousin"><span><b>Start date</b><i> required</i></span></div>
        <div class="me"><input id="x"></div>
        <div class="other"><input id="y"></div>
      </section>`;
    const html = captureAncestorContext(document.getElementById('x')!).html!;
    expect(html).toContain('Start date required');
    // Inner <span>/<b>/<i> should have been flattened away.
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
  });

  it('returns innerText snapshot of the chosen ancestor, capped at 300 chars', () => {
    document.body.innerHTML = `
      <section>
        <label>Email</label>
        <div><input id="x"></div>
        <div><input id="y"></div>
      </section>`;
    const r = captureAncestorContext(document.getElementById('x')!);
    expect(r.innerText).toContain('Email');
    expect(r.innerText!.length).toBeLessThanOrEqual(300);
  });

  it('returns null html when the element has no parent', () => {
    const orphan = document.createElement('input');
    expect(captureAncestorContext(orphan).html).toBeNull();
  });

  // ── detector settings params ──────────────────────────────────────────────

  it('maxAncestorLevels restricts how far up the tree we climb', () => {
    // input is 3 levels deep: input > c > b > a > body
    document.body.innerHTML = `<div id="a"><div id="b"><div id="c"><input id="x"></div></div></div>`;
    // With default (6) we reach #a; with maxAncestorLevels=2 we stop at #b.
    const rDefault = captureAncestorContext(document.getElementById('x')!);
    expect(rDefault.html).toContain('id="a"');

    const rCapped = captureAncestorContext(document.getElementById('x')!, { maxAncestorLevels: 2, maxAncestorInnerText: 300, maxAncestorHtml: 15000, maxAttrValueLen: 120 });
    expect(rCapped.html).toContain('id="b"');
    expect(rCapped.html).not.toContain('id="a"');
  });

  it('maxAncestorInnerText caps the innerText sidecar at the supplied value', () => {
    const longText = 'x'.repeat(200);
    document.body.innerHTML = `
      <section>
        <div>${longText}</div>
        <div><input id="x"></div>
        <div><input id="y"></div>
      </section>`;
    const r = captureAncestorContext(document.getElementById('x')!, { maxAncestorLevels: 6, maxAncestorInnerText: 50, maxAncestorHtml: 15000, maxAttrValueLen: 120 });
    expect(r.innerText).not.toBeNull();
    expect(r.innerText!.length).toBeLessThanOrEqual(50);
  });

  it('maxAttrValueLen truncates attribute values in the cleaned HTML', () => {
    const longPlaceholder = 'A'.repeat(40);
    document.body.innerHTML = `
      <div>
        <input id="x" placeholder="${longPlaceholder}">
        <input id="y">
      </div>`;
    // With maxAttrValueLen=10 the placeholder should be sliced to 10 chars.
    const r = captureAncestorContext(document.getElementById('x')!, { maxAncestorLevels: 6, maxAncestorInnerText: 300, maxAncestorHtml: 15000, maxAttrValueLen: 10 });
    expect(r.html).toContain(`placeholder="${'A'.repeat(10)}"`);
    expect(r.html).not.toContain(longPlaceholder);
  });

  it('maxAncestorHtml truncates the output HTML at the supplied character limit', () => {
    // Build a wide, attribute-heavy ancestor so the cleaned HTML is predictably large.
    const labels = Array.from({ length: 20 }, (_, i) => `<label for="f${i}">Label number ${i}</label><input id="f${i}">`).join('\n');
    document.body.innerHTML = `<section><div id="inner">${labels}<input id="x"></div></section>`;
    const full = captureAncestorContext(document.getElementById('x')!);
    const fullLen = full.html?.length ?? 0;

    // Use a cap that is smaller than the full output but large enough to reach the focused element.
    const cap = Math.max(100, Math.floor(fullLen / 2));
    const capped = captureAncestorContext(document.getElementById('x')!, { maxAncestorLevels: 6, maxAncestorInnerText: 300, maxAncestorHtml: cap, maxAttrValueLen: 120 });
    expect(capped.html).not.toBeNull();
    expect(capped.html!.length).toBeLessThanOrEqual(cap + '…[truncated]…'.length);
    expect(capped.html).toContain('data-quickfill-focus="1"');
  });
});

describe('capturePageContext', () => {
  it('captures title + hostname; siteName/h1 null when absent', () => {
    document.title = 'My App';
    const ctx = capturePageContext();
    expect(ctx.title).toBe('My App');
    expect(ctx.hostname).toBe(location.hostname);
    expect(ctx.siteName).toBeNull();
    expect(ctx.h1).toBeNull();
  });
  it('captures og:site_name and h1 when present', () => {
    document.head.innerHTML = `<meta property="og:site_name" content="Acme">`;
    document.body.innerHTML = `<h1>Welcome</h1>`;
    const ctx = capturePageContext();
    expect(ctx.siteName).toBe('Acme');
    expect(ctx.h1).toBe('Welcome');
  });
});
