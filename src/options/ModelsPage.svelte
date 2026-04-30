<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import { DEFAULT_SETTINGS } from '$shared/constants';
  import type { Backend, Settings } from '$shared/types';

  let settings: Settings = $state(structuredClone(DEFAULT_SETTINGS));
  let saving = $state(false);
  let saveMsg = $state('');

  let reachability: { state: 'idle' | 'pending' | 'ok' | 'err'; models: string[]; error?: string } = $state({
    state: 'idle',
    models: []
  });

  const BACKENDS: { id: Backend; label: string }[] = [
    { id: 'ollama', label: 'Ollama (local)' },
    { id: 'anthropic', label: 'Anthropic (Claude)' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'gemini', label: 'Google Gemini' }
  ];

  async function load() {
    const r = await rpcCall('get-settings', {});
    if (r.ok) settings = structuredClone(r.value as Settings);
  }
  onMount(load);

  async function save() {
    saving = true;
    saveMsg = '';
    const r = await rpcCall('set-settings', settings);
    saving = false;
    saveMsg = r.ok ? 'Saved.' : `Save failed: ${r.message}`;
    setTimeout(() => (saveMsg = ''), 2500);
  }

  async function checkOllama() {
    reachability = { state: 'pending', models: [] };
    const r = await rpcCall('ollama-reachability-check', { baseUrl: settings.backends.ollama.baseUrl });
    if (!r.ok) {
      reachability = { state: 'err', models: [], error: r.message };
      return;
    }
    if (r.value.ok) reachability = { state: 'ok', models: r.value.models };
    else reachability = { state: 'err', models: [], error: r.value.error };
  }

  const ollamaCommand = $derived(
    `OLLAMA_ORIGINS=chrome-extension://${chrome.runtime.id} ollama serve`
  );
</script>

<div class="card col">
  <h2>Models</h2>
  <p class="muted">Pick the active backend; per-backend config below.</p>

  <fieldset>
    <legend>Active backend</legend>
    <div class="col" style="gap: 4px;">
      {#each BACKENDS as b (b.id)}
        <label class="row">
          <input type="radio" name="active-backend" value={b.id} bind:group={settings.activeBackend} />
          <span>{b.label}</span>
        </label>
      {/each}
    </div>
  </fieldset>

  <fieldset>
    <legend>Ollama</legend>
    <label class="muted" for="ollama-url">Base URL</label>
    <input id="ollama-url" type="text" bind:value={settings.backends.ollama.baseUrl} />
    <label class="muted" for="ollama-model">Model</label>
    <input id="ollama-model" type="text" bind:value={settings.backends.ollama.model} />
    <p class="muted" style="font-size: 12px;">
      Allow this extension's origin in Ollama:
    </p>
    <pre class="code">{ollamaCommand}</pre>
    <div class="row">
      <button onclick={checkOllama} type="button">Check reachability</button>
      {#if reachability.state === 'pending'}
        <span class="muted">Checking…</span>
      {:else if reachability.state === 'ok'}
        <span class="muted">✓ Reachable. Models: {reachability.models.join(', ') || '(none)'}</span>
      {:else if reachability.state === 'err'}
        <span class="error">{reachability.error}</span>
      {/if}
    </div>
  </fieldset>

  <fieldset>
    <legend>Anthropic</legend>
    <label class="muted" for="anth-key">API key</label>
    <input id="anth-key" type="password" autocomplete="off" bind:value={settings.backends.anthropic.apiKey} />
    <label class="muted" for="anth-model">Model</label>
    <input id="anth-model" type="text" bind:value={settings.backends.anthropic.model} />
  </fieldset>

  <fieldset>
    <legend>OpenAI</legend>
    <label class="muted" for="oai-key">API key</label>
    <input id="oai-key" type="password" autocomplete="off" bind:value={settings.backends.openai.apiKey} />
    <label class="muted" for="oai-model">Model</label>
    <input id="oai-model" type="text" bind:value={settings.backends.openai.model} />
  </fieldset>

  <fieldset>
    <legend>Gemini</legend>
    <label class="muted" for="gem-key">API key</label>
    <input id="gem-key" type="password" autocomplete="off" bind:value={settings.backends.gemini.apiKey} />
    <label class="muted" for="gem-model">Model</label>
    <input id="gem-model" type="text" bind:value={settings.backends.gemini.model} />
  </fieldset>

  <div class="row" style="justify-content: flex-end;">
    {#if saveMsg}<span class="muted" style="margin-right: 12px;">{saveMsg}</span>{/if}
    <button class="primary" onclick={save} disabled={saving} type="button">
      {saving ? 'Saving…' : 'Save'}
    </button>
  </div>
</div>

<style>
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 6px 0;
  }
  legend {
    color: var(--muted);
    font-size: 12px;
    padding: 0 4px;
  }
  pre.code {
    background: #f3f4f6;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
