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
  | 'generic_key'
  | 'alias_judge';

// ───────────────────────── Profile ─────────────────────────

export type ProfileValue = {
  id: string; // canonical key (cleaned).
  values: string[];
  defaultValueIndex: number;
  updatedAt: number;
};

// Group templates (e.g. "Work Experience", "Education") — schema-typed lists
// of records. Each template defines an ordered list of keys; each record is a
// "filling-in" of those keys. One record is the default; the rest are
// reachable via the side-panel navigator (Alt+, / Alt+.).
//
// Per-template-key aliases live on the key (NOT in the global Profile.aliasMap)
// to avoid collisions when a label like "company" exists in both flat profile
// and one or more templates. The matcher consults flat aliases first, then
// each template's per-key aliases, returning a ranked candidate list.
export type GroupTemplateKeyType = 'string' | 'number' | 'boolean' | 'array';

export type GroupTemplateKey = {
  /** Cleaned canonical key for this slot, e.g. 'job title'. */
  key: string;
  /** Hint for the Profile editor widget + fill-time coercion. Storage is still
   *  a string (or string[] for array). */
  type: GroupTemplateKeyType;
  /** Cleaned aliases, NOT including the identity entry (key itself). */
  aliases: string[];
  /** Excluded from cloud-LLM prompts, same as Profile.sensitiveKeys. */
  sensitive: boolean;
};

export type GroupRecord = {
  id: string;
  /** Single value per (record, key). For 'array' typed keys, stored as string[].
   *  Missing keys mean "no value yet." */
  values: Record<string, string | string[]>;
  createdAt: number;
  updatedAt: number;
};

export type GroupTemplate = {
  id: string;
  /** User-visible name, e.g. 'Work Experience'. */
  name: string;
  /** Ordered for display in the editor + the navigator card. */
  keys: GroupTemplateKey[];
  /** Ordered for display + navigator step order. */
  records: GroupRecord[];
  /** Initial record shown in the navigator on first match. Null when there
   *  are no records yet. */
  defaultRecordId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Profile = {
  // alias label → canonical key. Includes identity entry (K → K) for every K.
  aliasMap: Record<string, string>;
  canonicalData: Record<string, ProfileValue>;
  sensitiveKeys: string[];
  /** Group templates (work experience, education, …). Empty for fresh installs
   *  and for backups produced before group-template support landed. */
  groupTemplates: GroupTemplate[];
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
  session: {
    /** Session-inactivity ceiling in minutes. The fill session auto-aborts
     *  after this many minutes without any panel/content event. The timer is
     *  reset on every inbound port event (panel button, manual-highlight
     *  selection, navigator key, panel keepalive heartbeat, …) so user
     *  activity holds the session open indefinitely. */
    inactivityMinutes: number;
  };
  /** Keyboard shortcuts for the group-template record navigator. The Alt
   *  modifier is fixed; only the key character is rebindable. These are NOT
   *  Chrome commands (the manifest is at the 4-shortcut cap) — they're
   *  intercepted by keydown listeners in the content script and side panel. */
  navigator: {
    /** Default ','. */
    prevKey: string;
    /** Default '.'. */
    nextKey: string;
  };
  detector: {
    /** Max characters of cleaned ancestor outerHTML sent to the classifier.  */
    maxAncestorHtml: number;
    /** Max characters of ancestor innerText sidecar.  */
    maxAncestorInnerText: number;
    /** Max ancestor levels climbed during the *initial* scrape when searching
     *  for an ancestor whose subtree contains a different form control.
     *  This is now only the initial-scrape ceiling; additional context is
     *  captured progressively as the classifier requests more (see
     *  `classifierMaxContextLevels`). */
    maxAncestorLevels: number;
    /** Once an ancestor containing a second form control is found during the
     *  initial scrape, climb this many more levels before snapshotting.
     *  Clamped at runtime by `maxAncestorLevels - matchedIndex`. */
    extraAncestorLevelsAfterMatch: number;
    /** Attribute values longer than this are truncated during HTML cleaning. */
    maxAttrValueLen: number;
    /** Maximum number of times the classifier may request a wider ancestor
     *  context (Template 4 / need_more_context response) before the session
     *  falls back to story_answer. Each request provides one
     *  additional DOM level above the previous snapshot. */
    classifierMaxContextLevels: number;
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
  /** Cleaned + pruned outerHTML of a smartly chosen ancestor — structural context for the classifier. The focused element is tagged with `data-quickfill-focus="1"`. */
  ancestorHtml: string | null;
  /** Plain-text innerText of the same ancestor (capped) as a noise-free sidecar. */
  ancestorInnerText: string | null;
  /** Progressive wider-ancestor snapshots for the agentic classifier loop.
   *  Index 0 is one DOM level above the initial ancestor, index 1 is two levels
   *  above, etc. Each entry is capped the same as ancestorHtml/ancestorInnerText. */
  additionalAncestorContexts: { html: string | null; innerText: string | null }[];
  /** Compact tag + key attributes identifying the focused field — fallback when ancestorHtml is null. */
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
