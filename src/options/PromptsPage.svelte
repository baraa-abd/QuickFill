<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import { DEFAULT_PROMPT_TEMPLATES, DEFAULT_PROMPT_PARAMS, DEFAULT_SETTINGS } from '$shared/constants';
  import type { PromptTaskName, Settings } from '$shared/types';

  const TASKS: { id: PromptTaskName; label: string; vars: string[] }[] = [
    { id: 'classifier', label: 'Classifier', vars: ['field_label', 'field_type', 'field_options', 'profile_keys'] },
    { id: 'chooser', label: 'Chooser', vars: ['field_label', 'canonical_key', 'stored_values', 'options'] },
    { id: 'answer_length', label: 'Answer length', vars: ['field_label', 'field_type'] },
    { id: 'story_answer_prompt', label: 'Story answer', vars: ['active_application', 'profile', 'stories', 'history', 'field_label', 'max_length'] },
    { id: 'resume_parse', label: 'Resume parse', vars: ['resume_text'] },
    { id: 'story_discovery', label: 'Story discovery', vars: ['active_application', 'field_label', 'answer', 'stories'] },
    { id: 'generic_key', label: 'Generic key', vars: ['company_name', 'role', 'user_blurb'] },
    { id: 'alias_judge', label: 'Alias judge', vars: ['canonical_key', 'field_label', 'ancestor_html'] }
  ];

  let settings: Settings = $state(structuredClone(DEFAULT_SETTINGS));
  let saving = $state(false);
  let saveMsg = $state('');

  async function load() {
    const r = await rpcCall('get-settings', {});
    if (r.ok) settings = structuredClone(r.value as Settings);
  }
  onMount(load);

  // ── template helpers ──────────────────────────────────────────────

  function getOverride(task: PromptTaskName): string {
    const v = settings.prompts[task];
    return typeof v === 'string' && v.trim().length > 0 ? v : DEFAULT_PROMPT_TEMPLATES[task];
  }
  function setOverride(task: PromptTaskName, val: string) {
    settings.prompts = { ...settings.prompts, [task]: val };
  }
  function isTemplateCustomized(task: PromptTaskName): boolean {
    const v = settings.prompts[task];
    return typeof v === 'string' && v.trim().length > 0 && v !== DEFAULT_PROMPT_TEMPLATES[task];
  }

  // ── param helpers ─────────────────────────────────────────────────

  function getParam(task: PromptTaskName, key: 'temperature' | 'maxTokens'): string {
    const v = settings.promptParams[task]?.[key];
    return v !== undefined ? String(v) : '';
  }

  function setParam(task: PromptTaskName, key: 'temperature' | 'maxTokens', raw: string) {
    const val = key === 'temperature' ? parseFloat(raw) : parseInt(raw, 10);
    const prev = settings.promptParams[task] ?? {};
    if (!raw.trim() || isNaN(val)) {
      const next = { ...prev };
      delete next[key];
      settings.promptParams = { ...settings.promptParams, [task]: next };
    } else {
      settings.promptParams = { ...settings.promptParams, [task]: { ...prev, [key]: val } };
    }
  }

  function isParamsCustomized(task: PromptTaskName): boolean {
    const p = settings.promptParams[task];
    if (!p) return false;
    const d = DEFAULT_PROMPT_PARAMS[task];
    return (p.temperature !== undefined && p.temperature !== d.temperature) ||
           (p.maxTokens !== undefined && p.maxTokens !== d.maxTokens);
  }

  function isCustomized(task: PromptTaskName): boolean {
    return isTemplateCustomized(task) || isParamsCustomized(task);
  }

  function reset(task: PromptTaskName) {
    const nextPrompts = { ...settings.prompts };
    delete nextPrompts[task];
    settings.prompts = nextPrompts;
    const nextParams = { ...settings.promptParams };
    delete nextParams[task];
    settings.promptParams = nextParams;
  }

  async function save() {
    saving = true;
    saveMsg = '';
    const r = await rpcCall('set-settings', settings);
    saving = false;
    saveMsg = r.ok ? 'Saved.' : `Save failed: ${r.message}`;
    setTimeout(() => (saveMsg = ''), 2500);
  }
</script>

<div class="card col">
  <h2>Prompts</h2>
  <p class="muted">
    Each template uses <code>&#123;&#123;snake_case&#125;&#125;</code> variables (missing → empty
    string). Blank template fields use the built-in default. Blank parameter fields use the default
    value shown in the placeholder.
  </p>
</div>

{#each TASKS as t (t.id)}
  <div class="card col">
    <div class="row" style="justify-content: space-between;">
      <h3 style="margin: 0;">{t.label}</h3>
      <div class="row">
        {#if isCustomized(t.id)}<span class="badge">customized</span>{/if}
        <button type="button" onclick={() => reset(t.id)}>Reset to default</button>
      </div>
    </div>
    <div class="muted" style="font-size: 12px;">
      Variables: {t.vars.map((v) => `{{${v}}}`).join(', ')}
    </div>
    <textarea
      rows="10"
      value={getOverride(t.id)}
      oninput={(e) => setOverride(t.id, (e.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <div class="params-row">
      <label class="param-label">
        <span>Temperature</span>
        <input
          type="number"
          min="0"
          max="2"
          step="0.05"
          class="param-input"
          placeholder={String(DEFAULT_PROMPT_PARAMS[t.id].temperature)}
          value={getParam(t.id, 'temperature')}
          oninput={(e) => setParam(t.id, 'temperature', (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label class="param-label">
        <span>Max tokens</span>
        <input
          type="number"
          min="1"
          step="1"
          class="param-input"
          placeholder={String(DEFAULT_PROMPT_PARAMS[t.id].maxTokens)}
          value={getParam(t.id, 'maxTokens')}
          oninput={(e) => setParam(t.id, 'maxTokens', (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
    </div>
  </div>
{/each}

<div class="card row" style="justify-content: flex-end; align-items: center;">
  {#if saveMsg}<span class="muted" style="margin-right: 12px;">{saveMsg}</span>{/if}
  <button class="primary" onclick={save} disabled={saving} type="button">
    {saving ? 'Saving…' : 'Save prompts'}
  </button>
</div>

<style>
  .badge {
    background: #fef3c7;
    border: 1px solid #f59e0b;
    color: #78350f;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .params-row {
    display: flex;
    gap: 16px;
    margin-top: 4px;
  }
  .param-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--muted, #6b7280);
  }
  .param-input {
    width: 90px;
    font-size: 12px;
    padding: 3px 6px;
  }
</style>
