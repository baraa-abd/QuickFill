// Single source of truth for every shape that crosses any boundary.
// zod mirrors live in ./schemas.ts.

export type Backend = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export type PromptTaskName =
  | 'classifier'
  | 'chooser'
  | 'answer_length'
  | 'story_answer_prompt'
  | 'resume_parse'
  | 'story_discovery'
  | 'generic_key';

// ───────────────────────── Profile ─────────────────────────

export type ProfileValue = {
  id: string; // canonical key (cleaned).
  values: string[];
  defaultValueIndex: number;
  updatedAt: number;
};

export type Profile = {
  // alias label → canonical key. Includes identity entry (K → K) for every K.
  aliasMap: Record<string, string>;
  canonicalData: Record<string, ProfileValue>;
  sensitiveKeys: string[];
};

// ───────────────────────── Answer history ─────────────────────────

export type AnswerHistoryEntry = {
  id: string;

  companyName: string;
  role: string;
  userBlurb: string | null;

  genericKey: string;
  genericKeyEmbedding: number[];

  question: string;
  questionEmbedding: number[];
  answer: string;

  createdAt: number;
  updatedAt: number;
};

// ───────────────────────── Story ─────────────────────────

export type Story = {
  id: string;
  content: string;
  keywords: string[];
  createdAt: number;
  updatedAt: number;
};

// ───────────────────────── Settings ─────────────────────────

export type BackendConfig = {
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  gemini: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
};

export type PromptParams = {
  temperature?: number;
  maxTokens?: number;
};

export type Settings = {
  activeBackend: Backend;
  backends: BackendConfig;
  // empty / whitespace-only means "use the default from DEFAULT_PROMPT_TEMPLATES"
  prompts: Partial<Record<PromptTaskName, string>>;
  // per-prompt LLM params; missing keys fall back to DEFAULT_PROMPT_PARAMS
  promptParams: Partial<Record<PromptTaskName, PromptParams>>;
  matching: {
    fuseThreshold: number;
  };
  rag: {
    historyGenericKeyWeight: number;
    minTokens: number;
    contextPercent: number;
  };
  dedup: {
    questionSimilarityThreshold: number;
    genericKeySimilarityThreshold: number;
  };
  logging: {
    enabled: boolean;
    logPayloads: boolean;
    showDiagnostics: boolean;
  };
  customContextWindows: Record<string, number>;
};

// ───────────────────────── Active application (session) ─────────────────────────

export type ActiveApplication = {
  companyName: string;
  role: string;
  userBlurb: string | null;
  genericKey: string;
  genericKeyEmbedding: number[];
  setAt: number;
};

// ───────────────────────── Fill plan (content → SW) ─────────────────────────

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'password'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'contenteditable'
  | 'unknown';

export type FillPlan = {
  question: string | null; // null when tree-climbing fails.
  fieldType: FieldType;
  options: string[] | null;
  currentValue: string;
  pageContext: {
    title: string;
    hostname: string;
    siteName: string | null;
    h1: string | null;
  };
  /** outerHTML of the grandparent element (parent's parent) — structural context for the classifier. */
  grandparentHtml: string | null;
  /** Compact tag + key attributes identifying the focused field within grandparentHtml. */
  elementDescriptor: string;
  elementRef: string;
  tabId: number;
  frameId: number;
};

// ───────────────────────── Logs ─────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  ts: number;
  level: LogLevel;
  tag: string;
  message: string;
  payload?: unknown;
};

// ───────────────────────── Backup envelope ─────────────────────────

export type BackupEnvelope = {
  format: 'backup/v1';
  version: number;
  exportedAt: number;
  kdf: {
    algorithm: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    saltBase64: string;
  };
  payload: {
    cipherTextBase64: string;
    ivBase64: string;
  };
};

export type BackupBundle = {
  version: number;
  exportedAt: number;
  profile: Profile;
  stories: Story[];
  history: AnswerHistoryEntry[];
  settings: Settings;
};

// ───────────────────────── Diagnostics ─────────────────────────

export type DiagnosticResult = {
  swAlive: true;
  isInitialized: boolean;
  vaultUnlocked: boolean;
  embedding:
    | { ok: true; dims: number; elapsedMs: number }
    | { ok: false; error: string };
  ports: {
    panel: number;
    contentByTab: Record<number, number>;
    activeTabContent: number | null;
  };
  llm: {
    activeBackend: Backend;
    hasApiKey: boolean; // never the key itself
    model: string;
  };
};

// ───────────────────────── Result ─────────────────────────

export type Ok<T> = { ok: true; value: T };
export type Err<E extends string = string> = { ok: false; kind: E; message: string };
export type Result<T, E extends string = string> = Ok<T> | Err<E>;
