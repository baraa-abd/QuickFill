// Provider-agnostic LLM types (§7.1).

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatRequest = {
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type StreamChunk =
  | { kind: 'token'; text: string }
  | { kind: 'done'; fullText: string }
  | { kind: 'error'; message: string; retryable: boolean };

import type { Backend, BackendConfig } from '$shared/types';

export type Adapter<B extends Backend> = (
  req: ChatRequest,
  config: BackendConfig[B]
) => AsyncGenerator<StreamChunk, void, void>;
