import type { Settings, PromptTaskName, PromptParams } from './types';

// ───────────────────────── KDF / Crypto ─────────────────────────

export const KDF_ITERATIONS = 200_000;
export const KDF_HASH = 'SHA-256';
export const KDF_SALT_BYTES = 16;
export const AES_IV_BYTES = 12;
export const DEK_BITS = 256;

// ───────────────────────── Embeddings ─────────────────────────

export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

// ───────────────────────── Logger ─────────────────────────

export const LOG_RING_BUFFER_SIZE = 2000;
export const LOG_REDACT_DEPTH_CAP = 6;

// ───────────────────────── Recovery phrase ─────────────────────────

export const RECOVERY_PHRASE_WORD_COUNT = 16;
export const RECOVERY_PHRASE_WORDLIST_SIZE = 256;

// ───────────────────────── Sensitive canonical keys ─────────────────────────

// Auto-flagged at resume parse / onboarding (§8.4). Stored against the
// shared cleanLabel() output, so all keys here must be pre-cleaned.
export const SENSITIVE_CANONICAL_KEYS = [
  'phone',
  'phone number',
  'mobile phone',
  'address',
  'street address',
  'home address',
  'mailing address',
  'date of birth',
  'birth date',
  'dob',
  'ssn',
  'social security number',
  'tax id',
  'passport',
  'passport number',
  'driver license',
  'drivers license',
  'national id',
  'national insurance',
  'bank account',
  'iban',
  'salary',
  'current salary',
  'desired salary',
  'gender',
  'race',
  'ethnicity',
  'sexual orientation',
  'disability',
  'veteran status'
];

// ───────────────────────── Default settings ─────────────────────────

// ───────────────────────── Default prompt params ─────────────────────────

// Temperature and token budgets for each task. All default to temperature 0
// so local models produce deterministic, reproducible output. Users can
// override per-prompt in Options → Prompts.
export const DEFAULT_PROMPT_PARAMS: Record<PromptTaskName, Required<PromptParams>> = {
  classifier:           { temperature: 0, maxTokens: 512 },
  chooser:              { temperature: 0, maxTokens: 128 },
  answer_length:        { temperature: 0, maxTokens: 256 },
  story_answer_prompt:  { temperature: 0.2, maxTokens: 600 },
  resume_parse:         { temperature: 0, maxTokens: 2048 },
  story_discovery:      { temperature: 0, maxTokens: 768 },
  generic_key:          { temperature: 0, maxTokens: 512 }
};

export function resolvePromptParams(
  task: PromptTaskName,
  overrides: Partial<Record<PromptTaskName, PromptParams>>
): Required<PromptParams> {
  const defaults = DEFAULT_PROMPT_PARAMS[task];
  const o = overrides[task];
  return {
    temperature: o?.temperature ?? defaults.temperature,
    maxTokens:   o?.maxTokens   ?? defaults.maxTokens
  };
}

export const DEFAULT_SETTINGS: Settings = {
  activeBackend: 'ollama',
  backends: {
    anthropic: { apiKey: '', model: 'claude-sonnet-4-6' },
    openai: { apiKey: '', model: 'gpt-5-mini' },
    gemini: { apiKey: '', model: 'gemini-3-flash-preview' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'gemma4:e4b' }
  },
  prompts: {},
  promptParams: {},
  matching: {
    fuseThreshold: 0.1
  },
  rag: {
    historyGenericKeyWeight: 0.3,
    minTokens: 1024,
    contextPercent: 25
  },
  dedup: {
    questionSimilarityThreshold: 0.85,
    genericKeySimilarityThreshold: 0.75
  },
  logging: {
    enabled: true,
    logPayloads: false,
    showDiagnostics: false
  },
  customContextWindows: {}
};

// ───────────────────────── Default prompt templates ─────────────────────────

// {{snake_case}} variables — missing renders as "".

export const DEFAULT_PROMPT_TEMPLATES: Record<PromptTaskName, string> = {
  classifier: `You are an expert data classification agent routing a job application form field into one of three strict categories.

<categories>
1. "profile_existing_value": A basic personal data point already present in the existing profile keys.
2. "profile_update": A basic personal data point NOT yet in the profile (e.g., middle name, pronouns, personal website). Suggest a normalized key (lowercase, spaces only).
3. "story_answer": A narrative, open-ended, or experiential question requiring an essay or paragraph (e.g., "Tell us about a time...", "Why this company?").
</categories>

<context>
Detector-produced label (heuristic — may be inaccurate): {{field_label}}
Field type: {{field_type}}
Available options (if any): {{field_options}}
Existing canonical profile keys: {{profile_keys}}

Focused element (the specific field the user wants to fill — use this to locate the target within the surrounding HTML):
{{element_descriptor}}

Surrounding HTML context (outerHTML of the grandparent element that contains the focused field and nearby labels/siblings — use this as the primary source of truth for what the field is actually asking):
{{grandparent_html}}
</context>

<instructions>
Determine what the focused field is asking by using the surrounding HTML as your primary source. The HTML shows the real DOM structure near the field, including labels, legends, aria attributes, and sibling content. Use the focused element descriptor to identify which specific element to fill within that HTML. Treat the detector-produced label as a secondary hint only — it may be wrong.

Use the surrounding HTML to:
- Identify the true question or label associated with the focused field
- Understand whether the field expects a brief factual answer or a narrative response
- Recognize explicit labels, fieldset legends, aria-labelledby targets, or text nodes adjacent to the element
</instructions>

<rules>
Output raw, unformatted JSON only. Begin your response with { and end it with }.
Match exactly one of these output templates:

Template 1 (Existing Value):
{"category": "profile_existing_value", "canonicalKey": "exact_matched_key"}

Template 2 (New Value):
{"category": "profile_update", "canonicalKey": "suggested_lowercase_key"}

Template 3 (Story Required):
{"category": "story_answer"}
</rules>

<examples>
If you recognize the Label as "Legal First Name", with existing keys: ["first name", "last name", "email"], then:
Output: {"category":"profile_existing_value","canonicalKey":"first name"}

If you recognize the Label as "Portfolio URL", with existing keys: ["first name", "last name", "email"], then:
Output: {"category":"profile_update","canonicalKey":"personal website"}

If you recognize the Label as "Describe a complex technical challenge you solved", with existing keys: ["first name"], then:
Output: {"category":"story_answer"}
</examples>

Output:`,

  chooser: `You are an expert data matcher resolving a stored profile value to a closed list of dropdown/radio options.

<rules>
1. Compare the stored values against the available options using semantic equivalence (e.g., "United States" = "USA"; "Software Engineer" = "Engineering").
2. If a logical match exists, output the EXACT, character-for-character match from the Available options list.
3. If no logical match exists, or the stored value contradicts the options, output the exact phrase: No good options
4. Output strictly the chosen string on a single line. Provide only the text of the option.
</rules>

<context>
Field label / question: {{field_label}}
Canonical profile key: {{canonical_key}}
Stored values: {{stored_values}}
Available options on the page:
{{options}}
</context>

Output:`,

  answer_length: `You are an expert form analyst. Estimate a sensible maximum character budget for the given field below.

<heuristics>
- 150: One-line factual answers (e.g., Current Company, Links).
- 600: Short, concise answers (e.g., "Briefly describe your role").
- 1500: Medium narratives (e.g., "Tell us about a project").
- 3000: Long essays (e.g., "Cover Letter").
</heuristics>

<context>
Field label / question: {{field_label}}
Field type: {{field_type}}
</context>

<rules>
Output strictly a single integer representing the character count. Provide only the numeric digits on a single line.
</rules>

Output:`,

  story_answer_prompt: `You are a top-tier professional applying for a job. Write a highly tailored, engaging, and specific answer to the application question.

<application_context>
{{active_application}}
</application_context>

<applicant_data>
Profile: {{profile}}
Relevant Stories: {{stories}}
Past Answers: {{history}}
</applicant_data>

<task>
Question to answer / field label: {{field_label}}
Maximum length: {{max_length}} characters.
</task>

<guidelines>
- Voice: First-person ("I"). Confident, professional, clear.
- Synthesis: Seamlessly weave metrics and facts from the <applicant_data>. Use only the provided experiences. Do NOT hallucinate or invent new experiences.
- Tailoring: Angle the response to directly appeal to the <application_context>.
</guidelines>

<critical_rules>
1. Begin your answer immediately with the first word of your response. 
2. Write in plain text format. Leave out formatting, bullet points, and headers unless EXPLICITLY requested by the prompt.
3. NO introductory fluff ("Here is my answer", "Based on my experience", "Certainly!").
</critical_rules>

Answer:`,
  
  resume_parse: `You are an expert data parser who is part of a recruitment data pipeline. Extract structured information from the raw resume text.

<resume_text>
{{resume_text}}
</resume_text>

<rules>
1. Extract standard profile data using common lowercase keys (e.g., "first name", "email", "education").
2. Identify impactful STAR narratives (Situation, Task, Action, Result) and assign 2-5 thematic keyword tags to each.
3. Output raw, unformatted JSON only. Begin your response with { and end it with }.
4. Output strictly this exact JSON skeleton, filling in the blanks:
</rules>

<output_scheme>
{
  "profile": {
    "key_name": "value"
  },
  "stories": [
    {
      "content": "One to two paragraph STAR narrative",
      "keywords": ["tag1", "tag2"]
    }
  ]
}
</output_scheme>

Output:`,

  story_discovery: `You are an expert career consultant. Your task is to detect if a user's edited answer contains a NEW, reusable STAR (Situation, Task, Action, Result) narrative.

<context>
Application: {{active_application}}
Question: {{field_label}}
Edited Answer: {{answer}}
</context>

<existing_stories>
{{stories}}
</existing_stories>

<evaluation_logic>
1. SAFETY CHECK: Is the edited answer just a grammatical fix, a shortened version of an existing story, a generic factual statement, or fluff? If YES -> Propose: false.
2. NOVELTY CHECK: Does the edited answer contain materially new experiential data (a new project, a new metric, a distinct challenge) not covered in <existing_stories>? If YES -> Propose: true.
</evaluation_logic>

<rules>
Output raw, unformatted JSON only. Begin your response with { and end it with }. 
Match exactly one of these output templates:

Template 1 (No new story):
{"proposeStory": false}

Template 2 (New story detected):
{"proposeStory": true, "content": "Extracted STAR paragraph", "keywords": ["tag1", "tag2"]}
</rules>

Output:`,

  generic_key: `You are a semantic tagging agent. Summarize the job application context into a short, generic, company-agnostic phrase.

<context>
Company name: {{company_name}}
Role: {{role}}
User notes: {{user_blurb}}
</context>

<rules>
1. The output MUST capture the industry, company stage/size, and role family.
2. CRITICAL: OMIT the specific company name. If the industry/stage is not obvious, describe only the role.
3. Output raw, unformatted JSON only. Begin your response with { and end it with }.

</rules>

<examples>
Input: Company: "Stripe", Role: "Backend Engineer", Notes: "Payments infrastructure"
Output: {"genericKey": "late-stage fintech, backend infrastructure engineer"}

Input: Company: "Stealth", Role: "Developer", Notes: ""
Output: {"genericKey": "early-stage startup, developer"}
</examples>

Output strictly this exact JSON format:
<output_scheme>
{
  "genericKey": "phrase"
}
</output_scheme>

Output:`
};

// ───────────────────────── Resolve prompt template ─────────────────────────

export function resolvePromptTemplate(
  task: PromptTaskName,
  overrides: Partial<Record<PromptTaskName, string>>
): string {
  const v = overrides[task];
  if (typeof v === 'string' && v.trim().length > 0) return v;
  return DEFAULT_PROMPT_TEMPLATES[task];
}
