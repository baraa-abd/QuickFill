<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import type { Story } from '$shared/types';

  let stories: Story[] = $state([]);
  let saveMsg = $state('');
  let saving = $state(false);

  // New story input.
  let newContent = $state('');
  let newKeywords = $state('');

  async function load() {
    const r = await rpcCall('get-stories', {});
    if (r.ok) stories = structuredClone(r.value as Story[]);
  }
  onMount(load);

  async function save() {
    saving = true;
    saveMsg = '';
    const r = await rpcCall('set-stories', stories);
    saving = false;
    saveMsg = r.ok ? 'Saved.' : `Save failed: ${r.message}`;
    setTimeout(() => (saveMsg = ''), 2500);
  }

  function uuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }

  function add() {
    const c = newContent.trim();
    if (!c) return;
    const kw = newKeywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const now = Date.now();
    stories = [
      ...stories,
      { id: uuid(), content: c, keywords: kw, createdAt: now, updatedAt: now }
    ];
    newContent = '';
    newKeywords = '';
  }

  function remove(id: string) {
    if (!confirm('Delete this story?')) return;
    stories = stories.filter((s) => s.id !== id);
  }

  function updateContent(id: string, content: string) {
    stories = stories.map((s) => (s.id === id ? { ...s, content, updatedAt: Date.now() } : s));
  }

  function updateKeywords(id: string, keywords: string) {
    const kw = keywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    stories = stories.map((s) => (s.id === id ? { ...s, keywords: kw, updatedAt: Date.now() } : s));
  }

  function fmtDate(ms: number): string {
    return new Date(ms).toLocaleDateString();
  }
</script>

<div class="card col">
  <h2>Stories</h2>
  <p class="muted">
    STAR-method narratives the LLM can draw on for story answers. The full list is sent on every
    story-answer prompt (it's small enough that we don't retrieve a subset).
  </p>
</div>

<div class="card col">
  <h3>Add story</h3>
  <textarea rows="5" placeholder="STAR narrative…" bind:value={newContent}></textarea>
  <input type="text" placeholder="keywords, comma separated" bind:value={newKeywords} />
  <div class="row" style="justify-content: flex-end;">
    <button class="primary" onclick={add} type="button">Add</button>
  </div>
</div>

{#each stories as s (s.id)}
  <div class="card col">
    <div class="row" style="justify-content: space-between;">
      <span class="muted" style="font-size: 12px;">created {fmtDate(s.createdAt)} · updated {fmtDate(s.updatedAt)}</span>
      <button class="danger" type="button" onclick={() => remove(s.id)}>Delete</button>
    </div>
    <textarea
      rows="5"
      value={s.content}
      oninput={(e) => updateContent(s.id, (e.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <input
      type="text"
      placeholder="keywords, comma separated"
      value={s.keywords.join(', ')}
      oninput={(e) => updateKeywords(s.id, (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
{/each}

<div class="card row" style="justify-content: flex-end; align-items: center;">
  {#if saveMsg}<span class="muted" style="margin-right: 12px;">{saveMsg}</span>{/if}
  <button class="primary" onclick={save} disabled={saving} type="button">
    {saving ? 'Saving…' : 'Save stories'}
  </button>
</div>
