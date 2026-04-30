<script lang="ts">
  import type { DedupMerge } from './session-store.svelte';
  import { onMount } from 'svelte';

  type Props = {
    merge: DedupMerge;
    onUndo: () => void;
    onDismiss: () => void;
  };
  let { merge, onUndo, onDismiss }: Props = $props();

  onMount(() => {
    const id = setTimeout(onDismiss, 10_000);
    return () => clearTimeout(id);
  });
</script>

<div
  class="card col"
  style="border-color: #f59e0b; background: #fffbeb;"
  role="status"
>
  <div>Merged into an older, more general answer.</div>
  <div class="muted" style="font-size: 12px;">Older Q: <em>{merge.olderQuestion}</em></div>
  <div class="row" style="justify-content: flex-end; gap: 8px;">
    <button onclick={onDismiss}>Keep merged</button>
    <button class="primary" onclick={onUndo}>Undo (keep older)</button>
  </div>
</div>
