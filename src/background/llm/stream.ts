// SSE + JSONL line stream parsers shared across provider adapters.

export async function* readSseLines(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<{ event: string; data: string }, void, void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data) {
            yield { event, data };
            event = 'message';
            data = '';
          }
          continue;
        }
        if (line.startsWith(':')) continue; // SSE comment
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = val;
        else if (field === 'data') data = data ? data + '\n' + val : val;
        // ignore id / retry
      }
    }
    if (data) yield { event, data };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* */
    }
  }
}

export async function* readJsonlLines(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<unknown, void, void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* skip malformed line */
        }
      }
    }
    const tail = buf.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* */
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* */
    }
  }
}

/** Map any thrown fetch / parse error to a `{ kind: 'error' }` chunk. */
export function errorChunk(e: unknown, retryable: boolean): {
  kind: 'error';
  message: string;
  retryable: boolean;
} {
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: 'error', message: msg, retryable };
}
