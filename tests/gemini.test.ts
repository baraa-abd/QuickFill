// Gemini adapter — candidates[0].content.parts[].text and finishReason close.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geminiAdapter } from '../src/background/llm/gemini';
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
const baseCfg = { apiKey: 'gem-key', model: 'gemini-2.0-flash' };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('geminiAdapter', () => {
  it('concatenates parts[].text and stops on a real finishReason', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        sseBody([
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }]
          })}\n\n`,
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'C' }] },
                finishReason: 'STOP'
              }
            ]
          })}\n\n`
        ]),
        { status: 200 }
      )
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of geminiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'token', text: 'A' },
      { kind: 'token', text: 'B' },
      { kind: 'token', text: 'C' },
      { kind: 'done', fullText: 'ABC' }
    ]);
  });

  it('surfaces HTTP errors with retryability buckets', async () => {
    globalThis.fetch = vi.fn(async () => new Response('busy', { status: 503 })) as typeof globalThis.fetch;
    let chunks = [];
    for await (const c of geminiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 })) as typeof globalThis.fetch;
    chunks = [];
    for await (const c of geminiAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(false);
  });

  it('attaches the api key as a query param (?key=)', async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        sseBody([
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }]
          })}\n\n`
        ]),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of geminiAdapter(baseReq, baseCfg)) chunks.push(c);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('key=gem-key');
    expect(url).toContain('streamGenerateContent');
    void chunks;
  });
});
