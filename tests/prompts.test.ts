import { describe, expect, it } from 'vitest';
import { extractJson, renderPrompt } from '../src/background/llm/prompts';

describe('renderPrompt', () => {
  it('substitutes {{snake_case}} variables', () => {
    expect(renderPrompt('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  it('renders missing variables as empty string', () => {
    expect(renderPrompt('a {{x}} b', {})).toBe('a  b');
  });

  it('renders null and undefined as empty', () => {
    expect(renderPrompt('{{a}}-{{b}}', { a: null, b: undefined })).toBe('-');
  });

  it('coerces numbers', () => {
    expect(renderPrompt('len={{n}}', { n: 42 })).toBe('len=42');
  });

  it('does not match {{CamelCase}} or {{kebab-case}}', () => {
    expect(renderPrompt('{{Foo}} {{kebab-bar}}', { Foo: 'X' })).toBe('{{Foo}} {{kebab-bar}}');
  });

  it('whitespace inside the brackets is allowed', () => {
    expect(renderPrompt('{{  name  }}', { name: 'ok' })).toBe('ok');
  });
});

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare ``` fences', () => {
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it('finds the first balanced object after prose', () => {
    const txt = 'sure thing! here you go: {"category":"story_answer"} cheers';
    expect(extractJson(txt)).toEqual({ category: 'story_answer' });
  });

  it('respects double-quoted strings (braces inside strings do not nest)', () => {
    const txt = '{"k": "hello } world", "n": 1}';
    expect(extractJson(txt)).toEqual({ k: 'hello } world', n: 1 });
  });

  it('handles escaped quotes inside strings', () => {
    const txt = '{"k": "say \\"hi\\""}';
    expect(extractJson(txt)).toEqual({ k: 'say "hi"' });
  });

  it('returns null on unparseable input', () => {
    expect(extractJson('total nonsense without any braces')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('finds an array if no object is present', () => {
    expect(extractJson('here: [1,2,3] done')).toEqual([1, 2, 3]);
  });
});
