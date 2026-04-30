import { describe, expect, it } from 'vitest';
import { redact } from '../src/background/logger';

describe('redact', () => {
  it('passes through primitives untouched', () => {
    expect(redact(42, 0)).toBe(42);
    expect(redact('hello', 0)).toBe('hello');
    expect(redact(null, 0)).toBe(null);
    expect(redact(undefined, 0)).toBe(undefined);
  });

  it('redacts `authorization` (case-insensitive)', () => {
    expect(redact({ Authorization: 'Bearer abc' }, 0)).toEqual({ Authorization: '[REDACTED]' });
    expect(redact({ AUTHORIZATION: 'x' }, 0)).toEqual({ AUTHORIZATION: '[REDACTED]' });
  });

  it('redacts `x-api-key`, `api_key`, `api-key`, `apikey`', () => {
    expect(redact({ 'x-api-key': 'k' }, 0)).toEqual({ 'x-api-key': '[REDACTED]' });
    expect(redact({ api_key: 'k' }, 0)).toEqual({ api_key: '[REDACTED]' });
    expect(redact({ 'api-key': 'k' }, 0)).toEqual({ 'api-key': '[REDACTED]' });
    expect(redact({ apikey: 'k' }, 0)).toEqual({ apikey: '[REDACTED]' });
  });

  it('redacts `cookie` and `set-cookie`', () => {
    expect(redact({ cookie: 'sid=1' }, 0)).toEqual({ cookie: '[REDACTED]' });
    expect(redact({ 'set-cookie': 'sid=1' }, 0)).toEqual({ 'set-cookie': '[REDACTED]' });
  });

  it('redacts `password`', () => {
    expect(redact({ password: 'hunter2' }, 0)).toEqual({ password: '[REDACTED]' });
  });

  it('redacts any key containing `secret` or `token`', () => {
    expect(redact({ mySecret: 1, accessToken: 'a' }, 0)).toEqual({
      mySecret: '[REDACTED]',
      accessToken: '[REDACTED]'
    });
    expect(redact({ refresh_token: 'r' }, 0)).toEqual({ refresh_token: '[REDACTED]' });
  });

  it('recurses into nested objects', () => {
    expect(redact({ headers: { Authorization: 'Bearer x' }, ok: true }, 0)).toEqual({
      headers: { Authorization: '[REDACTED]' },
      ok: true
    });
  });

  it('recurses into arrays', () => {
    expect(redact([{ password: 'x' }, { ok: 1 }], 0)).toEqual([{ password: '[REDACTED]' }, { ok: 1 }]);
  });

  it('caps recursion at LOG_REDACT_DEPTH_CAP', () => {
    let v: unknown = { ok: 1 };
    for (let i = 0; i < 20; i++) v = { nested: v };
    const out = JSON.stringify(redact(v, 0));
    // Once depth-capped, the deepest element is a sentinel string.
    expect(out).toContain('depth-capped');
  });

  it('does not mutate the input', () => {
    const input = { password: 'x', nested: { token: 'y' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redact(input, 0);
    expect(input).toEqual(snapshot);
  });
});
