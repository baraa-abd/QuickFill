// Ollama adapter (§7.2).
//
// POST {baseUrl}/api/chat with stream:true → JSONL response, each line
// `{ message: { content: "..." }, done: bool, ... }`. The user must launch
// Ollama with `OLLAMA_ORIGINS=chrome-extension://<id>` to allow the extension
// origin (CORS).

import type { Adapter, StreamChunk } from './types';
import { logger } from '../logger';
import { errorChunk, readJsonlLines } from './stream';

export const ollamaAdapter: Adapter<'ollama'> = async function* (req, cfg) {
  const messages: { role: string; content: string }[] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    stream: true,
    options: {
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.maxTokens === 'number' ? { num_predict: req.maxTokens } : {})
    }
  });

  let resp: Response;
  try {
    resp = await fetch(joinUrl(cfg.baseUrl, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: req.signal
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return;
    yield errorChunk(e, true);
    return;
  }

  if (!resp.ok) {
    const text = await safeText(resp);
    yield errorChunk(
      new Error(`Ollama HTTP ${resp.status}: ${text || resp.statusText}`),
      retryableForStatus(resp.status)
    );
    return;
  }

  const full: string[] = [];
  let lineCount = 0;
  try {
    for await (const raw of readJsonlLines(resp.body)) {
      if (req.signal?.aborted) return;
      lineCount++;
      const obj = raw as {
        message?: { content?: string };
        done?: boolean;
        error?: string;
      };
      if (typeof obj.error === 'string') {
        yield { kind: 'error', message: obj.error, retryable: false };
        return;
      }
      const tok = obj.message?.content ?? '';
      if (tok) {
        full.push(tok);
        yield { kind: 'token', text: tok } satisfies StreamChunk;
      }
      if (obj.done) {
        logger.debug('ollama', 'stream-done', { lines: lineCount, tokens: full.length, chars: full.join('').length });
        yield { kind: 'done', fullText: full.join('') };
        return;
      }
    }
    // Stream ended without a `done` line — emit `done` with whatever we have.
    logger.debug('ollama', 'stream-end-no-done', { lines: lineCount, tokens: full.length, chars: full.join('').length });
    yield { kind: 'done', fullText: full.join('') };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return;
    yield errorChunk(e, true);
  }
};

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function retryableForStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

/**
 * Cheap reachability check used by the Models options page. Returns
 * { ok, models } or { ok: false, error }. Never throws.
 */
export async function ollamaPresenceCheck(baseUrl: string, signal?: AbortSignal): Promise<
  { ok: true; models: string[] } | { ok: false; error: string }
> {
  try {
    const resp = await fetch(joinUrl(baseUrl, '/api/tags'), { signal });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const json = (await resp.json()) as { models?: { name: string }[] };
    const models = (json.models ?? []).map((m) => m.name);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}
