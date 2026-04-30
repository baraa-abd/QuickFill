import { describe, expect, it } from 'vitest';
import { readJsonlLines, readSseLines } from '../src/background/llm/stream';

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    }
  });
}

function multiChunk(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    }
  });
}

describe('readJsonlLines', () => {
  it('parses one line per JSON object', async () => {
    const out: unknown[] = [];
    for await (const o of readJsonlLines(streamFromString('{"a":1}\n{"a":2}\n'))) out.push(o);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles a tail line without a trailing newline', async () => {
    const out: unknown[] = [];
    for await (const o of readJsonlLines(streamFromString('{"a":1}\n{"a":2}'))) out.push(o);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reassembles split chunks', async () => {
    const out: unknown[] = [];
    for await (const o of readJsonlLines(multiChunk(['{"a":', '1}\n{"b":2}\n']))) out.push(o);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips malformed lines', async () => {
    const out: unknown[] = [];
    for await (const o of readJsonlLines(streamFromString('{"a":1}\nNOT JSON\n{"b":2}\n'))) out.push(o);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('readSseLines', () => {
  it('emits an event after a blank line', async () => {
    const body = 'data: hello\n\ndata: world\n\n';
    const out: { event: string; data: string }[] = [];
    for await (const e of readSseLines(streamFromString(body))) out.push(e);
    expect(out).toEqual([
      { event: 'message', data: 'hello' },
      { event: 'message', data: 'world' }
    ]);
  });

  it('honors event: field', async () => {
    const body = 'event: ping\ndata: pong\n\n';
    const out: { event: string; data: string }[] = [];
    for await (const e of readSseLines(streamFromString(body))) out.push(e);
    expect(out).toEqual([{ event: 'ping', data: 'pong' }]);
  });

  it('joins multi-line data with newlines', async () => {
    const body = 'data: one\ndata: two\n\n';
    const out: { event: string; data: string }[] = [];
    for await (const e of readSseLines(streamFromString(body))) out.push(e);
    expect(out).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('skips comment lines (leading `:`)', async () => {
    const body = ':keepalive\ndata: hi\n\n';
    const out: { event: string; data: string }[] = [];
    for await (const e of readSseLines(streamFromString(body))) out.push(e);
    expect(out).toEqual([{ event: 'message', data: 'hi' }]);
  });
});
