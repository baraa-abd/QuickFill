<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import type { Settings } from '$shared/types';

  let show = $state(false);
  let open = $state(false);
  let busy = $state(false);
  let result: unknown = $state(null);
  let error = $state('');

  onMount(async () => {
    const r = await rpcCall('get-settings', {});
    if (r.ok) show = (r.value as Settings).logging.showDiagnostics;
  });

  async function run() {
    busy = true;
    error = '';
    result = null;
    const r = await rpcCall('run-diagnostic', {});
    if (!r.ok) error = r.message;
    else result = r.value;
    busy = false;
  }
</script>

{#if show}
  <div class="card col">
    <div class="row" style="justify-content: space-between;">
      <h2>Diagnostics</h2>
      <button onclick={() => (open = !open)}>{open ? 'Hide' : 'Show'}</button>
    </div>
    {#if open}
      <div class="row">
        <button class="primary" onclick={run} disabled={busy}>{busy ? 'Running…' : 'Run'}</button>
      </div>
      {#if error}<div class="error">{error}</div>{/if}
      {#if result}
        <pre style="white-space: pre-wrap; word-break: break-all; font-size: 12px;">{JSON.stringify(result, null, 2)}</pre>
      {/if}
    {/if}
  </div>
{/if}
