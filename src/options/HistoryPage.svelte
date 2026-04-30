<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import type { AnswerHistoryEntry } from '$shared/types';

  let entries: AnswerHistoryEntry[] = $state([]);
  let filter = $state('');

  async function load() {
    const r = await rpcCall('get-history', {});
    if (r.ok) entries = (r.value as AnswerHistoryEntry[]).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }
  onMount(load);

  const filtered = $derived(
    filter
      ? entries.filter((e) => {
          const f = filter.toLowerCase();
          return (
            e.question.toLowerCase().includes(f) ||
            e.answer.toLowerCase().includes(f) ||
            e.companyName.toLowerCase().includes(f) ||
            e.role.toLowerCase().includes(f) ||
            e.genericKey.toLowerCase().includes(f)
          );
        })
      : entries
  );

  async function remove(id: string) {
    if (!confirm('Delete this history entry?')) return;
    const r = await rpcCall('delete-history-entry', { id });
    if (r.ok) entries = entries.filter((e) => e.id !== id);
  }

  function fmt(ms: number): string {
    return new Date(ms).toLocaleString();
  }
</script>

<div class="card col">
  <h2>Answer history</h2>
  <p class="muted">
    Past answers used by the RAG retriever for new story-answer prompts. The full list is searched
    semantically — this page is for human review.
  </p>
  <input type="text" placeholder="Filter…" bind:value={filter} />
</div>

{#if filtered.length === 0}
  <div class="card"><p class="muted">No entries.</p></div>
{/if}

{#each filtered as e (e.id)}
  <div class="card col">
    <div class="row" style="justify-content: space-between;">
      <strong>{e.companyName} · {e.role}</strong>
      <button class="danger" type="button" onclick={() => remove(e.id)}>Delete</button>
    </div>
    <div class="muted" style="font-size: 12px;">
      generic key: {e.genericKey} · created {fmt(e.createdAt)} · updated {fmt(e.updatedAt)}
    </div>
    <div><strong>Q:</strong> {e.question}</div>
    <div><strong>A:</strong> {e.answer}</div>
  </div>
{/each}
