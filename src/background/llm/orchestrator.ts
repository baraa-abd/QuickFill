// Backend-dispatching orchestrator for LLM calls (§7.1).
//
// `streamWith(settings, req)` picks the adapter for `settings.activeBackend`
// and yields its StreamChunks. `complete(...)` drains the stream and returns
// `{ ok, text }` for one-shot callers (classifier, chooser, generic_key,
// answer_length, story_discovery, resume_parse).

import type { Backend, Settings } from '$shared/types';
import { logger } from '../logger';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { ollamaAdapter } from './ollama';
import { openaiAdapter } from './openai';
import type { ChatRequest, StreamChunk } from './types';

export async function* streamWith(
  settings: Settings,
  req: ChatRequest
): AsyncGenerator<StreamChunk, void, void> {
  switch (settings.activeBackend) {
    case 'ollama':
      yield* ollamaAdapter(req, settings.backends.ollama);
      return;
    case 'anthropic':
      if (!settings.backends.anthropic.apiKey) {
        yield {
          kind: 'error',
          message: 'No Anthropic API key set. Open Options → Models to add one.',
          retryable: false
        };
        return;
      }
      yield* anthropicAdapter(req, settings.backends.anthropic);
      return;
    case 'openai':
      if (!settings.backends.openai.apiKey) {
        yield {
          kind: 'error',
          message: 'No OpenAI API key set. Open Options → Models to add one.',
          retryable: false
        };
        return;
      }
      yield* openaiAdapter(req, settings.backends.openai);
      return;
    case 'gemini':
      if (!settings.backends.gemini.apiKey) {
        yield {
          kind: 'error',
          message: 'No Gemini API key set. Open Options → Models to add one.',
          retryable: false
        };
        return;
      }
      yield* geminiAdapter(req, settings.backends.gemini);
      return;
    default: {
      const _exhaustive: never = settings.activeBackend;
      yield { kind: 'error', message: `unknown backend: ${String(_exhaustive)}`, retryable: false };
    }
  }
}

export async function complete(
  settings: Settings,
  req: ChatRequest,
  logCtx?: { tag: string; vars?: Record<string, unknown> }
): Promise<{ ok: true; text: string } | { ok: false; message: string; retryable: boolean }> {
  if (logCtx) logger.debug(logCtx.tag, 'llm-call', logCtx.vars);
  let text = '';
  for await (const chunk of streamWith(settings, req)) {
    if (chunk.kind === 'token') text += chunk.text;
    else if (chunk.kind === 'done') {
      const result = chunk.fullText || text;
      if (logCtx) logger.debug(logCtx.tag, 'llm-response', { response: result.slice(0, 500) });
      return { ok: true, text: result };
    } else if (chunk.kind === 'error')
      return { ok: false, message: chunk.message, retryable: chunk.retryable };
  }
  if (logCtx) logger.debug(logCtx.tag, 'llm-response', { response: text.slice(0, 500) });
  return { ok: true, text };
}

export function isCloud(b: Backend): boolean {
  return b !== 'ollama';
}
