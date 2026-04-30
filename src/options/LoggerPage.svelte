<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import type { LogEntry, LogLevel, Settings } from '$shared/types';

  let settings: Settings | null = $state(null);
  let logs: LogEntry[] = $state([]);
  let saving = $state(false);
  let saveMsg = $state('');

  // Filter UI.
  let levelFilter: 'all' | LogLevel = $state('all');
  let tagFilter = $state('');

  async function loadSettings() {
    const r = await rpcCall('get-settings', {});
    if (r.ok) settings = structuredClone(r.value as Settings);
  }
  async function loadLogs() {
    const r = await rpcCall('get-logs', {});
    if (r.ok) logs = (r.value as LogEntry[]).slice().reverse();
  }
  onMount(async () => {
    await loadSettings();
    await loadLogs();
  });

  async function saveLogging() {
    if (!settings) return;
    saving = true;
    saveMsg = '';
    const r = await rpcCall('set-settings', settings);
    saving = false;
    saveMsg = r.ok ? 'Saved.' : `Save failed: ${r.message}`;
    setTimeout(() => (saveMsg = ''), 2500);
  }

  async function clear() {
    if (!confirm('Clear the log buffer?')) return;
    await rpcCall('clear-logs', {});
    logs = [];
  }

  const filtered = $derived(
    logs.filter((l) => {
      if (levelFilter !== 'all' && l.level !== levelFilter) return false;
      if (tagFilter && !l.tag.toLowerCase().includes(tagFilter.toLowerCase())) return false;
      return true;
    })
  );

  function fmt(ms: number): string {
    return new Date(ms).toISOString();
  }
</script>

<div class="card col">
  <h2>Debug</h2>
  {#if settings}
    <label class="row">
      <input type="checkbox" bind:checked={settings.logging.enabled} />
      <span>Enable logging</span>
    </label>
    <label class="row">
      <input type="checkbox" bind:checked={settings.logging.logPayloads} />
      <span>Log payloads (with redaction)</span>
    </label>
    <label class="row">
      <input type="checkbox" bind:checked={settings.logging.showDiagnostics} />
      <span>Show diagnostics panel in side panel</span>
    </label>
    <div class="row" style="justify-content: flex-end;">
      {#if saveMsg}<span class="muted" style="margin-right: 12px;">{saveMsg}</span>{/if}
      <button class="primary" onclick={saveLogging} disabled={saving} type="button">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  {/if}
</div>

<div class="card col">
  <h3>Log buffer</h3>
  <div class="row">
    <select bind:value={levelFilter}>
      <option value="all">all levels</option>
      <option value="debug">debug</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
    </select>
    <input type="text" placeholder="filter by tag…" bind:value={tagFilter} />
    <button onclick={loadLogs} type="button">Refresh</button>
    <button class="danger" onclick={clear} type="button">Clear</button>
  </div>

  <div class="log-table">
    {#each filtered as l, i (i)}
      <div class={`log-row log-${l.level}`}>
        <span class="log-time">{fmt(l.ts)}</span>
        <span class={`log-level log-level-${l.level}`}>{l.level}</span>
        <span class="log-tag">{l.tag}</span>
        <span class="log-msg">{l.message}</span>
        {#if l.payload !== undefined}
          <pre class="log-payload">{JSON.stringify(l.payload, null, 2)}</pre>
        {/if}
      </div>
    {/each}
    {#if filtered.length === 0}
      <p class="muted">No log entries.</p>
    {/if}
  </div>
</div>

<style>
  .log-table {
    max-height: 70vh;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    background: #fafafa;
  }
  .log-row {
    display: grid;
    grid-template-columns: 180px 60px 110px 1fr;
    gap: 8px;
    align-items: start;
    border-bottom: 1px solid #ececec;
    padding: 4px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }
  .log-row .log-payload {
    grid-column: 1 / -1;
    margin: 4px 0 0;
    background: #fff;
    border: 1px solid var(--border);
    padding: 4px;
    border-radius: 4px;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .log-time { color: var(--muted); }
  .log-level { font-weight: 600; }
  .log-level-error { color: var(--danger); }
  .log-level-warn  { color: #b45309; }
  .log-level-info  { color: #1d4ed8; }
  .log-level-debug { color: #6b7280; }
  .log-tag { color: #374151; }
</style>
