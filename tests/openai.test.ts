// OpenAI adapter — choices[0].delta.content streaming + finish_reason close.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../src/background/llm/openai';
import type { ChatRequest } from '../src/background/llm/types';

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    }
  });
}

const baseReq: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
const baseCfg = { apiKey: 'sk-test', model: 'gpt-4o-mini' };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('openaiAdapter', () => {
  it('streams delta content and stops on [DONE]', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        sseBody([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`,
          `data: [DONE]\n\n`
        ]),
        { status: 200 }
      )
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of openaiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'token', text: 'Hi' },
      { kind: 'token', text: ' there' },
      { kind: 'done', fullText: 'Hi there' }
    ]);
  });

  it('closes on a finish_reason without [DONE]', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        sseBody([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`
        ]),
        { status: 200 }
      )
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of openaiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[chunks.length - 1].kind).toBe('done');
  });

  it('surfaces 429 as retryable, 401 as non-retryable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('busy', { status: 429 })) as typeof globalThis.fetch;
    let chunks = [];
    for await (const c of openaiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as typeof globalThis.fetch;
    chunks = [];
    for await (const c of openaiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(false);
  });

  it('uses Authorization: Bearer <key>', async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(sseBody([`data: [DONE]\n\n`]), { status: 200 })
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of openaiAdapter(baseReq, baseCfg)) chunks.push(c);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    void chunks;
  });
});
