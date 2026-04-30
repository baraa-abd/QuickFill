// Anthropic adapter — exercise the SSE event shapes the spec calls out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../src/background/llm/anthropic';
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
function ev(type: string, data: object | string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${type}\ndata: ${payload}\n\n`;
}

const baseReq: ChatRequest = {
  messages: [{ role: 'user', content: 'hi' }]
};
const baseCfg = { apiKey: 'sk-test', model: 'claude-3-haiku' };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('anthropicAdapter', () => {
  it('streams content_block_delta tokens then closes on message_stop', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        sseBody([
          ev('message_start', { type: 'message_start' }),
          ev('content_block_delta', {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hel' }
          }),
          ev('content_block_delta', {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'lo' }
          }),
          ev('message_stop', { type: 'message_stop' })
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    ) as typeof globalThis.fetch;

    const chunks = [];
    for await (const c of anthropicAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'token', text: 'Hel' },
      { kind: 'token', text: 'lo' },
      { kind: 'done', fullText: 'Hello' }
    ]);
  });

  it('surfaces HTTP 5xx as retryable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('err', { status: 503 })) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of anthropicAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(true);
  });

  it('surfaces HTTP 401 as non-retryable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of anthropicAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks[0].kind).toBe('error');
    if (chunks[0].kind === 'error') expect(chunks[0].retryable).toBe(false);
  });

  it('surfaces an in-stream error event as non-retryable', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        sseBody([
          ev('error', { type: 'error', error: { message: 'overloaded' } })
        ]),
        { status: 200 }
      )
    ) as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of anthropicAdapter(baseReq, baseCfg)) chunks.push(c);
    expect(chunks).toEqual([{ kind: 'error', message: 'overloaded', retryable: false }]);
  });

  it('sets x-api-key + anthropic headers', async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(sseBody([ev('message_stop', { type: 'message_stop' })]), { status: 200 })
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const chunks = [];
    for await (const c of anthropicAdapter(baseReq, baseCfg)) chunks.push(c);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect((init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe('true');
    void chunks;
  });
});
