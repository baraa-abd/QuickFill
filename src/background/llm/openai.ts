// OpenAI adapter (§7.2).
//
// POST https://api.openai.com/v1/chat/completions with stream:true → SSE
// stream of `choices[0].delta.content` chunks. Stop on `data: [DONE]` or a
// `finish_reason !== null` final chunk.

import type { Adapter, ChatMessage } from './types';
import { errorChunk, readSseLines } from './stream';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const openaiAdapter: Adapter<'openai'> = async function* (req, cfg) {
  const messages: ChatMessage[] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) messages.push(m);

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    stream: true,
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.maxTokens === 'number' ? { max_tokens: req.maxTokens } : {})
  });

  let resp: Response;
  try {
    resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
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
      new Error(`OpenAI HTTP ${resp.status}: ${text || resp.statusText}`),
      retryableForStatus(resp.status)
    );
    return;
  }

  const full: string[] = [];
  try {
    for await (const ev of readSseLines(resp.body)) {
      if (req.signal?.aborted) return;
      if (!ev.data) continue;
      if (ev.data === '[DONE]') {
        yield { kind: 'done', fullText: full.join('') };
        return;
      }
      let parsed: OpenAiEvent | null = null;
      try {
        parsed = JSON.parse(ev.data) as OpenAiEvent;
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      if (!choice) continue;
      const tok = choice.delta?.content;
      if (typeof tok === 'string' && tok) {
        full.push(tok);
        yield { kind: 'token', text: tok };
      }
      if (choice.finish_reason) {
        yield { kind: 'done', fullText: full.join('') };
        return;
      }
    }
    yield { kind: 'done', fullText: full.join('') };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return;
    yield errorChunk(e, true);
  }
};

type OpenAiEvent = {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
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
