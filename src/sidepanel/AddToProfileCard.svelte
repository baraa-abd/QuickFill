<script lang="ts">
  import type { AddToProfileConfirm } from './session-store.svelte';

  type Props = {
    confirm: AddToProfileConfirm;
    onSubmit: (canonicalKey: string, value: string, sensitive: boolean) => void;
    onCancel: () => void;
  };
  let { confirm, onSubmit, onCancel }: Props = $props();

  // svelte-ignore state_referenced_locally
  let key = $state(confirm.label);
  // svelte-ignore state_referenced_locally
  let value = $state(confirm.value);
  let sensitive = $state(false);
  let error = $state('');

  function submit() {
    error = '';
    if (!key.trim()) {
      error = 'Profile key is required.';
      return;
    }
    onSubmit(key.trim(), value, sensitive);
  }
</script>

<div class="card col">
  <h2>Save to profile?</h2>
  <p class="muted">Confirm — the label or value is long, so we want to double-check before writing.</p>
  <label class="muted" for="add-key">Canonical key</label>
  <input id="add-key" type="text" bind:value={key} />
  <label class="muted" for="add-val">Value</label>
  <textarea id="add-val" rows="3" bind:value={value}></textarea>
  <label class="row" style="gap: 6px;">
    <input type="checkbox" bind:checked={sensitive} />
    <span class="muted">Mark as sensitive (excluded from cloud-LLM prompts)</span>
  </label>
  {#if error}<div class="error">{error}</div>{/if}
  <div class="row" style="justify-content: space-between;">
    <button onclick={onCancel}>Cancel</button>
    <button class="primary" onclick={submit}>Save</button>
  </div>
</div>
