<script lang="ts">
  import type { RecentActivity } from './session-store.svelte';

  type Props = {
    entries: RecentActivity[];
    onRevert: (id: string) => void;
    onSwitchValue: (id: string, newValue: string) => void;
  };
  let { entries, onRevert, onSwitchValue }: Props = $props();

  // Most recent first.
  let fills = $derived(
    entries.filter((e): e is Extract<RecentActivity, { kind: 'fill' }> => e.kind === 'fill').slice().reverse()
  );

  function ago(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function sourceLabel(s: Extract<RecentActivity, { kind: 'fill' }>['source']): string {
    switch (s) {
      case 'profile': return 'profile match';
      case 'profile_existing_value': return 'AI matched';
      case 'profile_update': return 'added to profile';
      case 'story_answer': return 'story answer';
    }
  }

  function hasAlternatives(f: Extract<RecentActivity, { kind: 'fill' }>): boolean {
    return Array.isArray(f.alternativeValues) && f.alternativeValues.length > 0;
  }
</script>

{#if fills.length > 0}
  <div class="card col">
    <div class="row" style="justify-content: space-between; align-items: baseline;">
      <h2>Recent fills</h2>
      <span class="muted" style="font-size: 11px;">{fills.length} this session</span>
    </div>
    {#each fills as f, idx (f.id)}
      <div
        class="col"
        style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; gap: 4px;"
      >
        <div class="row" style="justify-content: space-between; align-items: baseline;">
          <div class="col" style="gap: 2px;">
            <strong style="word-break: break-word;">{f.canonicalKey ?? f.label}</strong>
            {#if f.templateContext}
              <span class="muted" style="font-size: 11px;">
                {f.templateContext.templateName} · record #{f.templateContext.recordIndex}
              </span>
            {/if}
          </div>
          <span class="muted" style="font-size: 11px; white-space: nowrap;">{ago(f.at)}</span>
        </div>

        {#if idx === 0 && hasAlternatives(f)}
          <!-- Value switcher: only for the most recent fill with multiple values -->
          <div class="col" style="gap: 4px;">
            <label class="muted" for="val-switch-{f.id}" style="font-size: 11px;">Filled value (tap to switch):</label>
            <select
              id="val-switch-{f.id}"
              style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;"
              value={f.value}
              onchange={(e) => onSwitchValue(f.id, (e.currentTarget as HTMLSelectElement).value)}
            >
              <option value={f.value}>{f.value || '(empty)'}</option>
              {#each f.alternativeValues as alt}
                <option value={alt}>{alt || '(empty)'}</option>
              {/each}
            </select>
          </div>
        {:else}
          <div
            style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; max-height: 160px; overflow-y: auto;"
          >
            {f.value || '(empty)'}
          </div>
        {/if}

        <div class="row" style="justify-content: space-between; align-items: center;">
          <span class="muted" style="font-size: 11px;">{sourceLabel(f.source)}</span>
          <button onclick={() => onRevert(f.id)} title="Restore the previous value of this field">
            Revert
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}
