<script lang="ts">
  import type { ProfileUpdate } from './session-store.svelte';

  type Props = {
    update: ProfileUpdate;
    onConfirm: (canonicalKey: string, value: string, sensitive: boolean) => void;
    onCancel: () => void;
  };
  let { update, onConfirm, onCancel }: Props = $props();

  // svelte-ignore state_referenced_locally
  let key = $state(update.suggestedKey);
  let value = $state('');
  let sensitive = $state(false);
  let error = $state('');

  function submit() {
    error = '';
    if (!key.trim()) {
      error = 'Profile key is required.';
      return;
    }
    if (!value.trim()) {
      error = 'Value is required.';
      return;
    }
    onConfirm(key.trim(), value, sensitive);
  }
</script>

<div class="card col">
  <h2>Add to your profile?</h2>
  <p class="muted">We don't have this in your profile yet — saving it makes future fills faster.</p>

  <label class="muted" for="upd-key">Canonical key</label>
  <input id="upd-key" type="text" bind:value={key} />

  {#if update.options}
    <label class="muted" for="upd-val">Pick a value</label>
    <select id="upd-val" bind:value>
      <option value="">— choose —</option>
      {#each update.options as o (o)}
        <option value={o}>{o}</option>
      {/each}
    </select>
  {:else}
    <label class="muted" for="upd-val">Value</label>
    <input id="upd-val" type="text" bind:value />
  {/if}

  <label class="row" style="gap: 6px;">
    <input type="checkbox" bind:checked={sensitive} />
    <span class="muted">Mark as sensitive (excluded from cloud-LLM prompts)</span>
  </label>

  {#if error}<div class="error">{error}</div>{/if}

  <div class="row" style="justify-content: space-between;">
    <button onclick={onCancel}>Cancel</button>
    <button class="primary" onclick={submit}>Save & fill</button>
  </div>
</div>
