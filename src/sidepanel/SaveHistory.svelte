<script lang="ts">
  import type { RecentActivity } from './session-store.svelte';

  type Props = {
    entries: RecentActivity[];
    onDelete: (id: string) => void;
  };
  let { entries, onDelete }: Props = $props();

  let saves = $derived(
    entries.filter((e): e is Extract<RecentActivity, { kind: 'save' }> => e.kind === 'save').slice().reverse()
  );

  function ago(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
</script>

{#if saves.length > 0}
  <div class="card col">
    <div class="row" style="justify-content: space-between; align-items: baseline;">
      <h2>Recent saves (Alt+S)</h2>
      <span class="muted" style="font-size: 11px;">{saves.length} this session</span>
    </div>
    {#each saves as s (s.id)}
      <div
        class="col"
        style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; gap: 4px;"
      >
        <div class="row" style="justify-content: space-between; align-items: baseline;">
          <div class="col" style="gap: 2px;">
            <strong style="word-break: break-word;">{s.label}</strong>
            {#if s.templateContext}
              <span class="muted" style="font-size: 11px;">
                {s.templateContext.templateName} · record #{s.templateContext.recordIndex}
              </span>
            {/if}
          </div>
          <span class="muted" style="font-size: 11px; white-space: nowrap;">{ago(s.at)}</span>
        </div>
        <div
          style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; max-height: 120px; overflow-y: auto;"
        >
          {s.value || '(empty)'}
        </div>
        <div class="row" style="justify-content: flex-end;">
          <button
            class="danger"
            onclick={() => onDelete(s.id)}
            title="Remove this saved value from the profile"
          >
            Delete from profile
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}
