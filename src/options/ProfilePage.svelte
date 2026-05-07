<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import { cleanLabel } from '$shared/clean';
  import type { GroupTemplate, Profile, ProfileValue } from '$shared/types';
  import GroupTemplatesEditor from './GroupTemplatesEditor.svelte';

  let profile: Profile = $state({
    aliasMap: {},
    canonicalData: {},
    sensitiveKeys: [],
    groupTemplates: []
  });
  let saving = $state(false);
  let saveMsg = $state('');
  let revealedKeys: Set<string> = $state(new Set());

  // Add-canonical-key form.
  let newKeyInput = $state('');
  let newValueInput = $state('');

  // Per-key add-alias inputs.
  let aliasInput: Record<string, string> = $state({});

  async function load() {
    const r = await rpcCall('get-profile', {});
    if (r.ok) {
      const loaded = structuredClone(r.value as Profile);
      // Defensive default: backups / older stored profiles may lack the field.
      if (!Array.isArray(loaded.groupTemplates)) loaded.groupTemplates = [];
      profile = loaded;
    }
  }

  function setGroupTemplates(next: GroupTemplate[]) {
    profile = { ...profile, groupTemplates: next };
  }
  onMount(load);

  async function save() {
    saving = true;
    saveMsg = '';
    const r = await rpcCall('set-profile', profile);
    saving = false;
    saveMsg = r.ok ? 'Saved.' : `Save failed: ${r.message}`;
    setTimeout(() => (saveMsg = ''), 2500);
  }

  const sortedKeys = $derived(Object.keys(profile.canonicalData).sort());

  function isSensitive(key: string): boolean {
    return profile.sensitiveKeys.includes(key);
  }

  function toggleSensitive(key: string) {
    profile.sensitiveKeys = isSensitive(key)
      ? profile.sensitiveKeys.filter((k) => k !== key)
      : [...profile.sensitiveKeys, key];
  }

  function toggleReveal(key: string) {
    const next = new Set(revealedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    revealedKeys = next;
  }

  function addCanonicalKey() {
    const key = cleanLabel(newKeyInput);
    if (!key) return;
    const value = newValueInput.trim();
    if (profile.canonicalData[key]) {
      if (value && !profile.canonicalData[key].values.includes(value)) {
        profile.canonicalData[key].values = [...profile.canonicalData[key].values, value];
        profile.canonicalData[key].updatedAt = Date.now();
      }
    } else {
      const pv: ProfileValue = {
        id: key,
        values: value ? [value] : [''],
        defaultValueIndex: 0,
        updatedAt: Date.now()
      };
      profile.canonicalData = { ...profile.canonicalData, [key]: pv };
      profile.aliasMap = { ...profile.aliasMap, [key]: key };
    }
    newKeyInput = '';
    newValueInput = '';
  }

  function removeCanonicalKey(key: string) {
    if (!confirm(`Remove "${key}" and all its aliases?`)) return;
    const cd = { ...profile.canonicalData };
    delete cd[key];
    profile.canonicalData = cd;
    const am: Record<string, string> = {};
    for (const [a, k] of Object.entries(profile.aliasMap)) if (k !== key) am[a] = k;
    profile.aliasMap = am;
    profile.sensitiveKeys = profile.sensitiveKeys.filter((k) => k !== key);
  }

  function addValue(key: string) {
    const cd = { ...profile.canonicalData };
    cd[key] = {
      ...cd[key],
      values: [...cd[key].values, ''],
      updatedAt: Date.now()
    };
    profile.canonicalData = cd;
  }

  function removeValue(key: string, idx: number) {
    const cur = profile.canonicalData[key];
    if (!cur || cur.values.length <= 1) return;
    const next = cur.values.filter((_, i) => i !== idx);
    let dv = cur.defaultValueIndex;
    if (idx === dv) dv = 0;
    else if (idx < dv) dv = dv - 1;
    profile.canonicalData = {
      ...profile.canonicalData,
      [key]: { ...cur, values: next, defaultValueIndex: dv, updatedAt: Date.now() }
    };
  }

  function setDefaultValue(key: string, idx: number) {
    profile.canonicalData = {
      ...profile.canonicalData,
      [key]: {
        ...profile.canonicalData[key],
        defaultValueIndex: idx,
        updatedAt: Date.now()
      }
    };
  }

  function aliasesFor(key: string): string[] {
    return Object.entries(profile.aliasMap)
      .filter(([a, k]) => k === key && a !== key)
      .map(([a]) => a)
      .sort();
  }

  function addAlias(key: string) {
    const raw = aliasInput[key] ?? '';
    const alias = cleanLabel(raw);
    if (!alias) return;
    if (alias === key) return;
    if (profile.aliasMap[alias] && profile.aliasMap[alias] !== key) {
      // Already mapped to a different canonical key — confirm overwrite.
      if (!confirm(`Alias "${alias}" maps to "${profile.aliasMap[alias]}". Overwrite?`)) return;
    }
    profile.aliasMap = { ...profile.aliasMap, [alias]: key };
    aliasInput = { ...aliasInput, [key]: '' };
  }

  function removeAlias(alias: string) {
    const am = { ...profile.aliasMap };
    delete am[alias];
    profile.aliasMap = am;
  }

  function valueAtIndex(pv: ProfileValue, i: number): string {
    return pv.values[i] ?? '';
  }
  function setValueAtIndex(key: string, i: number, val: string) {
    const cur = profile.canonicalData[key];
    const next = cur.values.slice();
    next[i] = val;
    profile.canonicalData = {
      ...profile.canonicalData,
      [key]: { ...cur, values: next, updatedAt: Date.now() }
    };
  }
</script>

<div class="card col">
  <h2>Profile</h2>
  <p class="muted">
    Canonical entries — values committed by Alt+A profile matches and sent (filtered) to the LLM
    for story answers. Mark fields as <strong>sensitive</strong> to hide them from cloud LLMs.
    Alias keys make multiple form labels resolve to the same canonical key. Inputs are normalized
    (lowercased, alphanumerics-only) on save.
  </p>
</div>

<div class="card col">
  <h3>Add canonical key</h3>
  <div class="row">
    <input type="text" placeholder="canonical key (e.g. 'first name')" bind:value={newKeyInput} />
    <input type="text" placeholder="value (optional)" bind:value={newValueInput} />
    <button class="primary" type="button" onclick={addCanonicalKey}>Add</button>
  </div>
</div>

{#each sortedKeys as key (key)}
  {@const pv = profile.canonicalData[key]}
  <div class="card col">
    <div class="row" style="justify-content: space-between;">
      <h3 style="margin: 0;">{key}</h3>
      <div class="row">
        <label class="row" style="font-size: 12px;">
          <input
            type="checkbox"
            checked={isSensitive(key)}
            onchange={() => toggleSensitive(key)}
          />
          <span>sensitive</span>
        </label>
        {#if isSensitive(key)}
          <button type="button" onclick={() => toggleReveal(key)}>
            {revealedKeys.has(key) ? 'Hide' : 'Reveal'}
          </button>
        {/if}
        <button class="danger" type="button" onclick={() => removeCanonicalKey(key)}>Remove</button>
      </div>
    </div>

    <div class="col" style="gap: 4px;">
      {#each pv.values as _v, i (i)}
        <div class="row">
          <input
            type="radio"
            name={`default-${key}`}
            checked={pv.defaultValueIndex === i}
            onchange={() => setDefaultValue(key, i)}
            title="Default value"
          />
          {#if isSensitive(key) && !revealedKeys.has(key)}
            <input
              type="password"
              value={valueAtIndex(pv, i)}
              oninput={(e) => setValueAtIndex(key, i, (e.currentTarget as HTMLInputElement).value)}
            />
          {:else}
            <input
              type="text"
              value={valueAtIndex(pv, i)}
              oninput={(e) => setValueAtIndex(key, i, (e.currentTarget as HTMLInputElement).value)}
            />
          {/if}
          <button type="button" onclick={() => removeValue(key, i)} disabled={pv.values.length <= 1}>×</button>
        </div>
      {/each}
      <div class="row" style="justify-content: flex-end;">
        <button type="button" onclick={() => addValue(key)}>+ value</button>
      </div>
    </div>

    <div>
      <strong>Aliases</strong>
      <div class="muted" style="font-size: 12px;">Form labels that resolve to "{key}".</div>
      <ul style="list-style: none; padding: 0; margin: 4px 0;">
        {#each aliasesFor(key) as alias (alias)}
          <li class="row" style="margin: 2px 0;">
            <span style="flex: 1; font-family: ui-monospace, monospace; font-size: 12px;">{alias}</span>
            <button type="button" onclick={() => removeAlias(alias)}>Remove</button>
          </li>
        {/each}
      </ul>
      <div class="row">
        <input
          type="text"
          placeholder="add alias (will be cleaned)"
          value={aliasInput[key] ?? ''}
          oninput={(e) => (aliasInput = { ...aliasInput, [key]: (e.currentTarget as HTMLInputElement).value })}
          onkeydown={(e) => e.key === 'Enter' && addAlias(key)}
        />
        <button type="button" onclick={() => addAlias(key)}>Add alias</button>
      </div>
    </div>
  </div>
{/each}

<GroupTemplatesEditor {profile} onChange={setGroupTemplates} />

<div class="card row" style="justify-content: flex-end; align-items: center;">
  {#if saveMsg}<span class="muted" style="margin-right: 12px;">{saveMsg}</span>{/if}
  <button class="primary" onclick={save} disabled={saving} type="button">
    {saving ? 'Saving…' : 'Save profile'}
  </button>
</div>
