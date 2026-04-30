<script lang="ts">
  type Props = {
    draft: string;
    streaming: boolean;
    done: boolean;
    maxLength: number;
    onConfirm: (override?: string) => void;
    onCancel: () => void;
  };
  let { draft, streaming, done, maxLength, onConfirm, onCancel }: Props = $props();

  let editing = $state(false);
  let editText = $state('');

  function startEdit() {
    editText = draft;
    editing = true;
  }
  function commitEdit() {
    editing = false;
    onConfirm(editText);
  }
  function cancelEdit() {
    editing = false;
  }
  function confirmAsIs() {
    onConfirm(undefined);
  }
</script>

<div class="card col">
  <div class="row" style="justify-content: space-between; align-items: baseline;">
    <h2>Draft</h2>
    {#if maxLength > 0}
      <span class="muted" style="font-size: 11px;">
        {(editing ? editText : draft).length} / {maxLength} chars
      </span>
    {/if}
  </div>

  {#if editing}
    <textarea rows="10" bind:value={editText}></textarea>
    <div class="row" style="justify-content: flex-end; gap: 8px;">
      <button onclick={cancelEdit}>Cancel edit</button>
      <button class="primary" onclick={commitEdit}>Save edit & fill</button>
    </div>
  {:else}
    <div
      class="muted"
      style="white-space: pre-wrap; min-height: 80px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fafafa;"
    >
      {draft}{#if streaming}<span aria-hidden="true">▍</span>{/if}
    </div>
    <div class="row" style="justify-content: space-between;">
      <button onclick={onCancel}>Cancel</button>
      <div class="row" style="gap: 8px;">
        <button onclick={startEdit} disabled={streaming && !done}>Edit</button>
        <button class="primary" onclick={confirmAsIs} disabled={streaming && !done}>
          {done ? 'Approve & fill' : 'Streaming…'}
        </button>
      </div>
    </div>
  {/if}
</div>
