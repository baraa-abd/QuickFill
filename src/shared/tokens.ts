import type { Backend } from './types';

// Universal heuristic — intentionally over-counts vs cl100k-base /
// Anthropic's tokenizer so we under-pack budgets rather than overflow.
// Per-provider tokenizers can be plugged in later via the `backend` arg.
export function estimateTokens(text: string, _backend?: Backend): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

// Known model → context window. Fallback 8192.
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-3.5-turbo': 16_385,
  // Gemini
  'gemini-1.5-pro': 1_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  // Ollama defaults (model-dependent; user can override via customContextWindows)
  'llama3.2': 131_072,
  'llama3.1': 131_072,
  'gemma3:4b': 8192,
  'gemma3:e4b': 8192,
  'gemma4:e4b': 8192
};

export function getContextWindow(
  modelId: string,
  customOverrides: Record<string, number> = {}
): number {
  if (modelId in customOverrides) return customOverrides[modelId];
  if (modelId in KNOWN_CONTEXT_WINDOWS) return KNOWN_CONTEXT_WINDOWS[modelId];
  return 8192;
}
