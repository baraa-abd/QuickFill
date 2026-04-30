// Adapter test against a fixture stream — never live network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ollamaAdapter } from '../src/background/llm/ollama';
import type { ChatRequest } from '../src/background/llm/types';

function jsonlBody(lines: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const o of lines) controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      controller.close();
    }
  });
}

const baseReq: ChatRequest = {
  messages: [{ role: 'user', content: 'hi' }]
};
const baseCfg = { baseUrl: 'http://localhost:11434', model: 'gemma4:e4b' };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ollamaAdapter', () => {
  it('streams tokens then a done chunk', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        jsonlBody([
          { message: { content: 'Hel' }, done: false },
          { message: { content: 'lo' }, done: false },
          { message: { content: '' }, done: true }
        ]),
        { status: 200 }
      )
    ) as typeof globalThis.fetch;

    const chunks = [];
    for await (const c of ollamaAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'token', text: 'Hel' },
      { kind: 'token', text: 'lo' },
      { kind: 'done', fullText: 'Hello' }
    ]);
  });

  it('surfaces HTTP 5xx as retryable error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('upstream is sad', { status: 503 })
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of ollamaAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks.length).toBe(1);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(true);
  });

  it('surfaces HTTP 401 as non-retryable error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('nope', { status: 401 })
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of ollamaAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(false);
  });

  it('surfaces a body { error: ... } line as non-retryable error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(jsonlBody([{ error: 'model not found' }]), { status: 200 })
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of ollamaAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([{ kind: 'error', message: 'model not found', retryable: false }]);
  });

  it('respects AbortSignal — yields nothing on pre-aborted request', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as typeof globalThis.fetch;
    const ac = new AbortController();
    ac.abort();
    const chunks = [];
    for await (const c of ollamaAdapter({ ...baseReq, signal: ac.signal }, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([]);
  });
});
