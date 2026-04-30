<script lang="ts">
  import type { StoryDiscovered } from './session-store.svelte';

  type Props = {
    proposal: StoryDiscovered;
    onConfirm: (content: string, keywords: string[]) => void;
    onDismiss: () => void;
  };
  let { proposal, onConfirm, onDismiss }: Props = $props();

  // svelte-ignore state_referenced_locally
  let content = $state(proposal.content);
  // svelte-ignore state_referenced_locally
  let keywordsText = $state(proposal.keywords.join(', '));

  function submit() {
    const kw = keywordsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onConfirm(content.trim(), kw);
  }
</script>

<div
  class="card col"
  style="border-color: var(--accent); background: #eff6ff;"
  role="status"
>
  <h2>Save as a story?</h2>
  <p class="muted">
    Stories are STAR-method narratives we reuse for future story_answer fills.
  </p>
  <textarea rows="4" bind:value={content}></textarea>
  <label class="muted" for="story-kw">Keywords (comma-separated)</label>
  <input id="story-kw" type="text" bind:value={keywordsText} />
  <div class="row" style="justify-content: flex-end; gap: 8px;">
    <button onclick={onDismiss}>Skip</button>
    <button class="primary" onclick={submit}>Save story</button>
  </div>
</div>
