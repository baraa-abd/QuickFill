<script lang="ts">
  import { onMount } from 'svelte';
  import type { AliasToast } from './session-store.svelte';

  type Props = {
    toast: AliasToast;
    onDelete: () => void;
    onDismiss: () => void;
  };
  let { toast, onDelete, onDismiss }: Props = $props();

  // The alias-judge sometimes mis-classifies a context-dependent label as a
  // genuine alias. The toast lingers a few seconds so the user has time to
  // catch it; if they do nothing, we just dismiss the UI (the alias stays
  // on the profile). Delete is the explicit revert.
  const VISIBLE_MS = 8_000;

  onMount(() => {
    const id = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(id);
  });
</script>

<div
  class="card col"
  style="border-color: #6366f1; background: #eef2ff;"
  role="status"
>
  <div>
    Added alias <strong>"{toast.alias}"</strong> →
    <span class="muted">{toast.canonicalDisplay}</span>
  </div>
  <div class="muted" style="font-size: 12px;">
    The classifier just used this label to fill from your profile. We saved it
    as an alias so the next form using the same wording matches directly.
  </div>
  <div class="row" style="justify-content: flex-end; gap: 8px;">
    <button onclick={onDismiss}>Keep alias</button>
    <button class="primary" onclick={onDelete}>Delete alias</button>
  </div>
</div>
