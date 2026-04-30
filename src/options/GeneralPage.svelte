<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import { DEFAULT_SETTINGS } from '$shared/constants';
  import type { Settings } from '$shared/types';
  import ChangePasswordCard from './ChangePasswordCard.svelte';

  let { onLocked }: { onLocked?: () => void } = $props();

  let settings: Settings = $state(structuredClone(DEFAULT_SETTINGS));
  let saving = $state(false);
  let saveMsg = $state('');
  let advancedOpen = $state(false);

  // Custom-context-window editor state.
  let customCwModel = $state('');
  let customCwTokens = $state('');

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

  function reset<K extends keyof Settings>(key: K) {
    (settings as Settings)[key] = structuredClone(DEFAULT_SETTINGS[key]);
  }

  function resetMatching(field: keyof Settings['matching']) {
    settings.matching[field] = DEFAULT_SETTINGS.matching[field];
  }
  function resetRag(field: keyof Settings['rag']) {
    settings.rag[field] = DEFAULT_SETTINGS.rag[field];
  }
  function resetDedup(field: keyof Settings['dedup']) {
    settings.dedup[field] = DEFAULT_SETTINGS.dedup[field];
  }

  function addCustomCw() {
    const m = customCwModel.trim();
    const t = parseInt(customCwTokens, 10);
    if (!m || !Number.isFinite(t) || t <= 0) return;
    settings.customContextWindows = { ...settings.customContextWindows, [m]: t };
    customCwModel = '';
    customCwTokens = '';
  }
  function removeCustomCw(model: string) {
    const next = { ...settings.customContextWindows };
    delete next[model];
    settings.customContextWindows = next;
  }

  async function resetExtension() {
    if (!confirm('Wipe all profile, history, settings, and the master password? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? This is irreversible.')) return;
    const r = await rpcCall('reset-extension', { confirm: 'YES, WIPE EVERYTHING' });
    if (r.ok) location.reload();
  }

  function shortcuts() {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  // Re-emit the locked event from inside the closure if/when needed (currently
  // not wired into any control on this page). The eager reference suppresses
  // svelte's "captures only initial value" warning.
  $effect(() => {
    void onLocked;
  });
</script>

<div class="card col">
  <h2>Shortcuts</h2>
  <p class="muted">
    AutoFill uses <span class="kbd">Alt</span>+<span class="kbd">A</span> to start a fill and
    <span class="kbd">Alt</span>+<span class="kbd">S</span> to save the focused field. Rebind from
    Chrome's shortcut page.
  </p>
  <div class="row" style="justify-content: flex-end;">
    <button onclick={shortcuts} type="button">Open chrome://extensions/shortcuts</button>
  </div>
</div>

<div class="card col">
  <h2>Advanced thresholds</h2>
  <button onclick={() => (advancedOpen = !advancedOpen)} type="button">
    {advancedOpen ? 'Hide' : 'Show'} advanced
  </button>

  {#if advancedOpen}
    <fieldset>
      <legend>Matching</legend>
      <label class="row">
        <span style="flex: 1;">Fuse threshold (default {DEFAULT_SETTINGS.matching.fuseThreshold})</span>
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          bind:value={settings.matching.fuseThreshold}
        />
        <button type="button" onclick={() => resetMatching('fuseThreshold')}>Reset</button>
      </label>
    </fieldset>

    <fieldset>
      <legend>RAG</legend>
      <label class="row">
        <span style="flex: 1;">History generic-key weight (default {DEFAULT_SETTINGS.rag.historyGenericKeyWeight})</span>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          bind:value={settings.rag.historyGenericKeyWeight}
        />
        <button type="button" onclick={() => resetRag('historyGenericKeyWeight')}>Reset</button>
      </label>
      <label class="row">
        <span style="flex: 1;">Min tokens (default {DEFAULT_SETTINGS.rag.minTokens})</span>
        <input type="number" min="0" bind:value={settings.rag.minTokens} />
        <button type="button" onclick={() => resetRag('minTokens')}>Reset</button>
      </label>
      <label class="row">
        <span style="flex: 1;">Context % (default {DEFAULT_SETTINGS.rag.contextPercent})</span>
        <input
          type="number"
          min="1"
          max="100"
          bind:value={settings.rag.contextPercent}
        />
        <button type="button" onclick={() => resetRag('contextPercent')}>Reset</button>
      </label>
    </fieldset>

    <fieldset>
      <legend>Dedup</legend>
      <label class="row">
        <span style="flex: 1;">Question similarity threshold (default {DEFAULT_SETTINGS.dedup.questionSimilarityThreshold})</span>
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          bind:value={settings.dedup.questionSimilarityThreshold}
        />
        <button type="button" onclick={() => resetDedup('questionSimilarityThreshold')}>Reset</button>
      </label>
      <label class="row">
        <span style="flex: 1;">Generic-key similarity threshold (default {DEFAULT_SETTINGS.dedup.genericKeySimilarityThreshold})</span>
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          bind:value={settings.dedup.genericKeySimilarityThreshold}
        />
        <button type="button" onclick={() => resetDedup('genericKeySimilarityThreshold')}>Reset</button>
      </label>
    </fieldset>

    <fieldset>
      <legend>Custom context windows</legend>
      <p class="muted" style="font-size: 12px;">Override <code>getContextWindow(modelId)</code> for custom Ollama models.</p>
      {#each Object.entries(settings.customContextWindows) as [m, t] (m)}
        <div class="row">
          <span style="flex: 1;"><strong>{m}</strong> → {t} tokens</span>
          <button type="button" onclick={() => removeCustomCw(m)}>Remove</button>
        </div>
      {/each}
      <div class="row">
        <input type="text" placeholder="model id" bind:value={customCwModel} />
        <input type="number" placeholder="tokens" bind:value={customCwTokens} />
        <button type="button" onclick={addCustomCw}>Add</button>
      </div>
      <div class="row" style="justify-content: flex-end;">
        <button type="button" onclick={() => reset('customContextWindows')}>Reset all</button>
      </div>
    </fieldset>

    <div class="row" style="justify-content: flex-end;">
      {#if saveMsg}<span class="muted">{saveMsg}</span>{/if}
      <button class="primary" onclick={save} disabled={saving} type="button">
        {saving ? 'Saving…' : 'Save thresholds'}
      </button>
    </div>
  {/if}
</div>

<ChangePasswordCard />

<div class="card col">
  <h2>Danger zone</h2>
  <p class="muted">
    Wipes all encrypted blobs, the master password, and session state. The extension behaves as
    freshly installed afterward.
  </p>
  <div class="row" style="justify-content: flex-end;">
    <button class="danger" onclick={resetExtension} type="button">Reset extension</button>
  </div>
</div>

<style>
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 6px 0;
  }
  legend {
    color: var(--muted);
    font-size: 12px;
    padding: 0 4px;
  }
  fieldset .row {
    margin: 6px 0;
  }
</style>
