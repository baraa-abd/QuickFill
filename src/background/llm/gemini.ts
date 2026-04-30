// Gemini adapter (§7.2).
//
// POST .../v1beta/models/{model}:streamGenerateContent?alt=sse&key=<key>.
// SSE event payload is a candidate-bearing JSON object; we concatenate
// `candidates[0].content.parts[].text`. Stop on a non-empty `finishReason`.

import type { Adapter } from './types';
import { errorChunk, readSseLines } from './stream';

export const geminiAdapter: Adapter<'gemini'> = async function* (req, cfg) {
  // Lift system messages out of the chat history into systemInstruction.
  const sysParts: string[] = [];
  if (req.systemPrompt) sysParts.push(req.systemPrompt);
  type GeminiContent = { role: 'user' | 'model'; parts: Array<{ text: string }> };
  const contents: GeminiContent[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      sysParts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  }

  const body = JSON.stringify({
    contents,
    ...(sysParts.length ? { systemInstruction: { parts: [{ text: sysParts.join('\n\n') }] } } : {}),
    generationConfig: {
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.maxTokens === 'number' ? { maxOutputTokens: req.maxTokens } : {})
    }
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
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
      new Error(`Gemini HTTP ${resp.status}: ${text || resp.statusText}`),
      retryableForStatus(resp.status)
    );
    return;
  }

  const full: string[] = [];
  try {
    for await (const ev of readSseLines(resp.body)) {
      if (req.signal?.aborted) return;
      if (!ev.data) continue;
      let parsed: GeminiEvent | null = null;
      try {
        parsed = JSON.parse(ev.data) as GeminiEvent;
      } catch {
        continue;
      }
      const cand = parsed?.candidates?.[0];
      if (!cand) continue;
      const parts = cand.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p?.text === 'string' && p.text) {
          full.push(p.text);
          yield { kind: 'token', text: p.text };
        }
      }
      if (cand.finishReason && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
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

type GeminiEvent = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string | null;
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
