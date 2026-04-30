import { beforeEach, describe, expect, it } from 'vitest';
import {
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
  it('select options use label/text/value precedence', () => {
    document.body.innerHTML = `<select id="x"><option value="a">Apple</option><option value="b">Banana</option></select>`;
    expect(getOptions(document.getElementById('x')!, 'select')).toEqual(['Apple', 'Banana']);
  });

  it('radio options pull from associated labels', () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" id="r1" name="g" value="a"><label for="r1">Apple</label>
        <input type="radio" id="r2" name="g" value="b"><label for="r2">Banana</label>
      </form>`;
    expect(getOptions(document.querySelector('#r1')!, 'radio')).toEqual(['Apple', 'Banana']);
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
