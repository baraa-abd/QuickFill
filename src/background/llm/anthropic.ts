// Anthropic adapter (§7.2).
//
// POST https://api.anthropic.com/v1/messages with stream:true → SSE stream.
// We consume `content_block_delta` (text deltas) and stop on `message_stop`.
// The `system` prompt rides in the top-level `system` field, NOT as a chat
// message. Browser-origin calls require the
// `anthropic-dangerous-direct-browser-access: true` header alongside the
// `anthropic-version` pin.

import type { Adapter } from './types';
import { errorChunk, readSseLines } from './stream';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicAdapter: Adapter<'anthropic'> = async function* (req, cfg) {
  // Anthropic disallows leading system messages in `messages`; lift them out.
  const sysParts: string[] = [];
  if (req.systemPrompt) sysParts.push(req.systemPrompt);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      sysParts.push(m.content);
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: req.maxTokens ?? 1024,
    stream: true,
    ...(sysParts.length ? { system: sysParts.join('\n\n') } : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    messages
  });

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
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
      new Error(`Anthropic HTTP ${resp.status}: ${text || resp.statusText}`),
      retryableForStatus(resp.status)
    );
    return;
  }

  const full: string[] = [];
  try {
    for await (const ev of readSseLines(resp.body)) {
      if (req.signal?.aborted) return;
      if (!ev.data || ev.data === '[DONE]') continue;
      let parsed: AnthropicEvent | null = null;
      try {
        parsed = JSON.parse(ev.data) as AnthropicEvent;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta;
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          full.push(delta.text);
          yield { kind: 'token', text: delta.text };
        }
        continue;
      }
      if (parsed.type === 'message_stop') {
        yield { kind: 'done', fullText: full.join('') };
        return;
      }
      if (parsed.type === 'error') {
        const msg =
          (parsed.error && typeof parsed.error.message === 'string' && parsed.error.message) ||
          'Anthropic streaming error';
        yield { kind: 'error', message: msg, retryable: false };
        return;
      }
    }
    yield { kind: 'done', fullText: full.join('') };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return;
    yield errorChunk(e, true);
  }
};

type AnthropicEvent = {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
};

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
