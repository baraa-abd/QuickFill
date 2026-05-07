<script lang="ts">
  import type { NavigatorState } from './session-store.svelte';

  type Props = {
    nav: NavigatorState;
    onPrev: () => void;
    onNext: () => void;
    onJump: (recordId: string) => void;
    onClose: () => void;
  };
  let { nav, onPrev, onNext, onJump, onClose }: Props = $props();

  const currentIndex = $derived(
    Math.max(0, nav.template.records.findIndex((r) => r.id === nav.currentRecordId))
  );
  const total = $derived(nav.template.records.length);
  const currentRecord = $derived(nav.template.records[currentIndex]);
  const sortedKeys = $derived(nav.template.keys);

  function display(value: string | string[] | undefined): string {
    if (value == null) return '';
    if (Array.isArray(value)) return value.join(', ');
    return value;
  }

  function recordSummary(rec: { values: Record<string, string | string[]> }): string {
    // Use the first 2 non-empty keys (in template order) as a 1-line summary.
    const out: string[] = [];
    for (const k of sortedKeys) {
      const v = display(rec.values[k.key]);
      if (v) out.push(v);
      if (out.length >= 2) break;
    }
    return out.join(' · ') || '(empty record)';
  }
</script>

<div class="card col" style="border: 1px solid #2563eb;">
  <div class="row" style="justify-content: space-between; align-items: baseline;">
    <div class="col" style="gap: 2px;">
      <strong>{nav.template.name}</strong>
      <span class="muted" style="font-size: 11px;">
        Record {currentIndex + 1} of {total} · matched key: <code>{nav.matchedKey}</code>
      </span>
    </div>
    <button onclick={onClose} title="Close navigator (Esc)">×</button>
  </div>

  <div class="row" style="gap: 6px; align-items: center; justify-content: center;">
    <button
      onclick={onPrev}
      disabled={total <= 1}
      title="Previous record (Alt+,)"
    >‹ Prev</button>

    <select
      style="flex: 1; min-width: 0;"
      value={nav.currentRecordId}
      onchange={(e) => onJump((e.currentTarget as HTMLSelectElement).value)}
      title="Jump to a specific record"
    >
      {#each nav.template.records as r, i (r.id)}
        <option value={r.id}>{`#${i + 1} — ${recordSummary(r)}`}</option>
      {/each}
    </select>

    <button
      onclick={onNext}
      disabled={total <= 1}
      title="Next record (Alt+.)"
    >Next ›</button>
  </div>

  <!-- Matched key, distinguished position. The user wanted the matched
       field highlighted near the top so they immediately see what was
       filled when navigating between records. -->
  <div
    style="border: 1px solid #2563eb; border-radius: 6px; padding: 6px 8px; background: #eff6ff;"
  >
    <div class="muted" style="font-size: 11px;">Filled into the page (matched key)</div>
    <div class="row" style="justify-content: space-between; align-items: baseline; gap: 8px;">
      <strong style="word-break: break-word;">{nav.matchedKey}</strong>
      <code style="font-size: 12px; word-break: break-word; text-align: right;">
        {display(currentRecord?.values[nav.matchedKey]) || '(empty)'}
      </code>
    </div>
  </div>

  <!-- Other fields of the same record — context for the user so they can
       confirm which record they're looking at without ambiguity. -->
  <details open>
    <summary style="font-size: 12px; cursor: pointer; user-select: none;">
      Full record ({total === 1 ? '1 record' : `${currentIndex + 1}/${total}`})
    </summary>
    <table style="width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 4px;">
      <tbody>
        {#each sortedKeys as k (k.key)}
          {#if k.key !== nav.matchedKey}
            <tr>
              <td style="padding: 2px 6px 2px 0; color: #6b7280; vertical-align: top; white-space: nowrap;">
                {k.key}
              </td>
              <td style="padding: 2px 0; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">
                {display(currentRecord?.values[k.key]) || '(empty)'}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </details>

  <div class="muted" style="font-size: 11px; text-align: center;">
    Use <span class="kbd">Alt</span>+<span class="kbd">,</span> /
    <span class="kbd">Alt</span>+<span class="kbd">.</span> to step through records.
    <span class="kbd">Esc</span> closes.
  </div>
</div>
