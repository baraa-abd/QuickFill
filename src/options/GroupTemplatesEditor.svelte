<script lang="ts">
  import { cleanLabel } from '$shared/clean';
  import type { GroupRecord, GroupTemplate, GroupTemplateKeyType, Profile } from '$shared/types';

  type Props = {
    profile: Profile;
    /** Replace the templates array on the parent profile. The parent decides
     *  when to persist via set-profile. */
    onChange: (next: GroupTemplate[]) => void;
  };
  let { profile, onChange }: Props = $props();

  let templates = $derived(profile.groupTemplates ?? []);

  // Per-template-key alias input state, keyed `${templateId}::${keyName}`.
  let aliasInput: Record<string, string> = $state({});

  // ───────────────────────── helpers ─────────────────────────

  function uuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }

  function commit(next: GroupTemplate[]) {
    // Touch updatedAt on every changed template so the parent can show a stale
    // indicator if needed.
    onChange(next);
  }

  function patchTemplate(id: string, fn: (t: GroupTemplate) => GroupTemplate): void {
    const next = templates.map((t) => (t.id === id ? { ...fn(t), updatedAt: Date.now() } : t));
    commit(next);
  }

  // ───────────────────────── template CRUD ─────────────────────────

  let newTemplateName = $state('');

  function addTemplate() {
    const name = newTemplateName.trim();
    if (!name) return;
    const now = Date.now();
    const tpl: GroupTemplate = {
      id: uuid(),
      name,
      keys: [],
      records: [],
      defaultRecordId: null,
      createdAt: now,
      updatedAt: now
    };
    commit([...templates, tpl]);
    newTemplateName = '';
  }

  function removeTemplate(id: string) {
    if (!confirm('Delete this template AND all its records? This cannot be undone here (export a backup first if unsure).')) return;
    commit(templates.filter((t) => t.id !== id));
  }

  function renameTemplate(id: string, name: string) {
    patchTemplate(id, (t) => ({ ...t, name }));
  }

  function moveTemplate(id: string, delta: -1 | 1) {
    const i = templates.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= templates.length) return;
    const next = templates.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }

  // ───────────────────────── key CRUD ─────────────────────────

  function addKey(t: GroupTemplate, rawKey: string, type: GroupTemplateKeyType) {
    const key = cleanLabel(rawKey);
    if (!key) return;
    if (t.keys.some((k) => k.key === key)) {
      alert(`This template already has a key "${key}".`);
      return;
    }
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: [...cur.keys, { key, type, aliases: [], sensitive: false }]
    }));
  }

  function removeKey(t: GroupTemplate, key: string) {
    if (!confirm(`Remove the "${key}" slot from this template? Existing values for this key in every record will be discarded.`)) {
      return;
    }
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.filter((k) => k.key !== key),
      records: cur.records.map((r) => {
        const v = { ...r.values };
        delete v[key];
        return { ...r, values: v, updatedAt: Date.now() };
      })
    }));
  }

  function renameKey(t: GroupTemplate, oldKey: string, rawNewKey: string) {
    const newKey = cleanLabel(rawNewKey);
    if (!newKey || newKey === oldKey) return;
    if (t.keys.some((k) => k.key === newKey)) {
      alert(`This template already has a key "${newKey}". Pick a different name.`);
      return;
    }
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.map((k) => (k.key === oldKey ? { ...k, key: newKey } : k)),
      records: cur.records.map((r) => {
        if (!(oldKey in r.values)) return r;
        const v: Record<string, string | string[]> = {};
        for (const [kk, vv] of Object.entries(r.values)) v[kk === oldKey ? newKey : kk] = vv;
        return { ...r, values: v, updatedAt: Date.now() };
      })
    }));
  }

  function setKeyType(t: GroupTemplate, key: string, type: GroupTemplateKeyType) {
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.map((k) => (k.key === key ? { ...k, type } : k))
    }));
  }

  function toggleKeySensitive(t: GroupTemplate, key: string) {
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.map((k) => (k.key === key ? { ...k, sensitive: !k.sensitive } : k))
    }));
  }

  function moveKey(t: GroupTemplate, key: string, delta: -1 | 1) {
    const i = t.keys.findIndex((k) => k.key === key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.keys.length) return;
    patchTemplate(t.id, (cur) => {
      const ks = cur.keys.slice();
      [ks[i], ks[j]] = [ks[j], ks[i]];
      return { ...cur, keys: ks };
    });
  }

  function addAlias(t: GroupTemplate, key: string) {
    const raw = aliasInput[`${t.id}::${key}`] ?? '';
    const alias = cleanLabel(raw);
    if (!alias || alias === key) return;
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.map((k) =>
        k.key === key && !k.aliases.includes(alias)
          ? { ...k, aliases: [...k.aliases, alias] }
          : k
      )
    }));
    aliasInput = { ...aliasInput, [`${t.id}::${key}`]: '' };
  }

  function removeAlias(t: GroupTemplate, key: string, alias: string) {
    patchTemplate(t.id, (cur) => ({
      ...cur,
      keys: cur.keys.map((k) =>
        k.key === key ? { ...k, aliases: k.aliases.filter((a) => a !== alias) } : k
      )
    }));
  }

  // ───────────────────────── record CRUD ─────────────────────────

  function addRecord(t: GroupTemplate) {
    const now = Date.now();
    const rec: GroupRecord = { id: uuid(), values: {}, createdAt: now, updatedAt: now };
    patchTemplate(t.id, (cur) => ({
      ...cur,
      records: [...cur.records, rec],
      defaultRecordId: cur.defaultRecordId ?? rec.id
    }));
  }

  function removeRecord(t: GroupTemplate, recordId: string) {
    if (!confirm('Delete this record?')) return;
    patchTemplate(t.id, (cur) => {
      const records = cur.records.filter((r) => r.id !== recordId);
      let defaultRecordId = cur.defaultRecordId;
      if (defaultRecordId === recordId) {
        defaultRecordId = records[0]?.id ?? null;
      }
      return { ...cur, records, defaultRecordId };
    });
  }

  function moveRecord(t: GroupTemplate, recordId: string, delta: -1 | 1) {
    const i = t.records.findIndex((r) => r.id === recordId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.records.length) return;
    patchTemplate(t.id, (cur) => {
      const recs = cur.records.slice();
      [recs[i], recs[j]] = [recs[j], recs[i]];
      return { ...cur, records: recs };
    });
  }

  function setDefaultRecord(t: GroupTemplate, recordId: string) {
    patchTemplate(t.id, (cur) => ({ ...cur, defaultRecordId: recordId }));
  }

  function setRecordValue(t: GroupTemplate, recordId: string, key: string, value: string) {
    patchTemplate(t.id, (cur) => ({
      ...cur,
      records: cur.records.map((r) => {
        if (r.id !== recordId) return r;
        const keyDef = cur.keys.find((k) => k.key === key);
        const next = { ...r.values };
        if (keyDef?.type === 'array') {
          // Editor stores array as newline-separated text; parse on edit.
          next[key] = value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          next[key] = value;
        }
        return { ...r, values: next, updatedAt: Date.now() };
      })
    }));
  }

  function recordValueAsString(rec: GroupRecord, key: string, _type: GroupTemplateKeyType): string {
    const v = rec.values[key];
    if (v == null) return '';
    if (Array.isArray(v)) return v.join('\n');
    return String(v);
  }

  // ───────────────────────── presets ─────────────────────────

  function addWorkExperiencePreset() {
    const now = Date.now();
    const tpl: GroupTemplate = {
      id: uuid(),
      name: 'Work Experience',
      keys: [
        { key: 'job title', type: 'string', aliases: ['title', 'position', 'role'], sensitive: false },
        { key: 'company', type: 'string', aliases: ['employer', 'company name', 'organization'], sensitive: false },
        { key: 'location', type: 'string', aliases: ['city', 'location'], sensitive: false },
        { key: 'start date', type: 'string', aliases: ['from', 'started'], sensitive: false },
        { key: 'end date', type: 'string', aliases: ['to', 'ended'], sensitive: false },
        { key: 'currently working', type: 'boolean', aliases: ['current', 'still working'], sensitive: false },
        { key: 'description', type: 'string', aliases: ['responsibilities', 'role description', 'summary'], sensitive: false }
      ],
      records: [],
      defaultRecordId: null,
      createdAt: now,
      updatedAt: now
    };
    commit([...templates, tpl]);
  }

  function addEducationPreset() {
    const now = Date.now();
    const tpl: GroupTemplate = {
      id: uuid(),
      name: 'Education',
      keys: [
        { key: 'school', type: 'string', aliases: ['university', 'institution'], sensitive: false },
        { key: 'degree', type: 'string', aliases: ['qualification'], sensitive: false },
        { key: 'field of study', type: 'string', aliases: ['major', 'concentration'], sensitive: false },
        { key: 'gpa', type: 'string', aliases: ['grade'], sensitive: false },
        { key: 'start date', type: 'string', aliases: ['from'], sensitive: false },
        { key: 'end date', type: 'string', aliases: ['to', 'graduation date'], sensitive: false }
      ],
      records: [],
      defaultRecordId: null,
      createdAt: now,
      updatedAt: now
    };
    commit([...templates, tpl]);
  }
</script>

<div class="card col">
  <h2>Group templates</h2>
  <p class="muted" style="font-size: 12px;">
    Templates describe a repeated section in an application form (work experiences, education,
    activities, …). Each template defines a list of keys; each <strong>record</strong> fills in
    those keys for one entry. When Alt+A matches a template key, the side panel opens a navigator
    so you can step through your records with <span class="kbd">Alt</span>+<span class="kbd">,</span>
    / <span class="kbd">Alt</span>+<span class="kbd">.</span>
    (rebindable in Options → Shortcuts).
  </p>
  <div class="row">
    <input type="text" placeholder="New template name (e.g. 'Work Experience')" bind:value={newTemplateName} />
    <button class="primary" type="button" onclick={addTemplate}>Add template</button>
    <button type="button" onclick={addWorkExperiencePreset}>+ Work Experience preset</button>
    <button type="button" onclick={addEducationPreset}>+ Education preset</button>
  </div>
</div>

{#each templates as t, ti (t.id)}
  <div class="card col">
    <div class="row" style="justify-content: space-between; align-items: center; gap: 6px;">
      <input
        type="text"
        value={t.name}
        oninput={(e) => renameTemplate(t.id, (e.currentTarget as HTMLInputElement).value)}
        style="flex: 1; font-weight: bold;"
      />
      <div class="row" style="gap: 4px;">
        <button type="button" disabled={ti === 0} onclick={() => moveTemplate(t.id, -1)} title="Move up">↑</button>
        <button type="button" disabled={ti === templates.length - 1} onclick={() => moveTemplate(t.id, 1)} title="Move down">↓</button>
        <button class="danger" type="button" onclick={() => removeTemplate(t.id)}>Delete</button>
      </div>
    </div>

    <!-- Keys table -->
    <div class="col">
      <strong>Keys</strong>
      <p class="muted" style="font-size: 11px; margin: 0 0 4px 0;">
        Add the form-field labels every record will share (e.g. job title, company, start date).
        Aliases let alternative form labels resolve to the same key.
      </p>
      {#if t.keys.length === 0}
        <div class="muted" style="font-size: 12px;">(no keys yet — add one below)</div>
      {/if}
      {#each t.keys as k, ki (k.key)}
        <div class="col" style="border: 1px solid var(--border); border-radius: 6px; padding: 6px; gap: 4px;">
          <div class="row" style="gap: 4px; align-items: center;">
            <input
              type="text"
              value={k.key}
              onchange={(e) => renameKey(t, k.key, (e.currentTarget as HTMLInputElement).value)}
              style="flex: 1;"
            />
            <select
              value={k.type}
              onchange={(e) => setKeyType(t, k.key, (e.currentTarget as HTMLSelectElement).value as GroupTemplateKeyType)}
              title="Type — drives the editor widget and fill-time coercion"
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="array">array</option>
            </select>
            <label class="row" style="font-size: 11px;">
              <input type="checkbox" checked={k.sensitive} onchange={() => toggleKeySensitive(t, k.key)} />
              <span>sensitive</span>
            </label>
            <button type="button" disabled={ki === 0} onclick={() => moveKey(t, k.key, -1)}>↑</button>
            <button type="button" disabled={ki === t.keys.length - 1} onclick={() => moveKey(t, k.key, 1)}>↓</button>
            <button class="danger" type="button" onclick={() => removeKey(t, k.key)}>×</button>
          </div>
          <div class="row" style="gap: 4px; flex-wrap: wrap;">
            {#each k.aliases as a (a)}
              <span style="border: 1px solid var(--border); border-radius: 999px; padding: 2px 6px; font-size: 11px; font-family: ui-monospace, monospace;">
                {a}
                <button type="button" onclick={() => removeAlias(t, k.key, a)} style="padding: 0 4px;">×</button>
              </span>
            {/each}
            <input
              type="text"
              placeholder="add alias"
              value={aliasInput[`${t.id}::${k.key}`] ?? ''}
              oninput={(e) => (aliasInput = { ...aliasInput, [`${t.id}::${k.key}`]: (e.currentTarget as HTMLInputElement).value })}
              onkeydown={(e) => e.key === 'Enter' && addAlias(t, k.key)}
              style="font-size: 12px; flex: 1; min-width: 120px;"
            />
            <button type="button" onclick={() => addAlias(t, k.key)}>+ alias</button>
          </div>
        </div>
      {/each}
      <div class="row" style="gap: 4px; align-items: center;">
        <input
          type="text"
          placeholder="add key (e.g. 'job title')"
          id="newkey-{t.id}"
          style="flex: 1;"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              const inp = e.currentTarget as HTMLInputElement;
              addKey(t, inp.value, 'string');
              inp.value = '';
            }
          }}
        />
        <button
          type="button"
          onclick={() => {
            const inp = document.getElementById(`newkey-{t.id}`) as HTMLInputElement | null;
            if (inp) {
              addKey(t, inp.value, 'string');
              inp.value = '';
            }
          }}
        >
          + key
        </button>
      </div>
    </div>

    <!-- Records list -->
    <div class="col">
      <strong>Records ({t.records.length})</strong>
      {#if t.keys.length === 0}
        <div class="muted" style="font-size: 12px;">(add at least one key before adding records)</div>
      {:else}
        {#each t.records as rec, ri (rec.id)}
          <div class="col" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; gap: 6px;">
            <div class="row" style="justify-content: space-between; align-items: center; gap: 6px;">
              <div class="row" style="gap: 4px; align-items: center;">
                <strong>#{ri + 1}</strong>
                <label class="row" style="font-size: 11px;">
                  <input
                    type="radio"
                    name={`default-record-${t.id}`}
                    checked={t.defaultRecordId === rec.id}
                    onchange={() => setDefaultRecord(t, rec.id)}
                  />
                  <span>default</span>
                </label>
              </div>
              <div class="row" style="gap: 4px;">
                <button type="button" disabled={ri === 0} onclick={() => moveRecord(t, rec.id, -1)} title="Move up">↑</button>
                <button type="button" disabled={ri === t.records.length - 1} onclick={() => moveRecord(t, rec.id, 1)} title="Move down">↓</button>
                <button class="danger" type="button" onclick={() => removeRecord(t, rec.id)}>×</button>
              </div>
            </div>
            <div class="col" style="gap: 4px;">
              {#each t.keys as k (k.key)}
                <div class="row" style="gap: 6px; align-items: flex-start;">
                  <label style="min-width: 130px; font-size: 12px;" for={`val-${t.id}-${rec.id}-${k.key}`}>
                    {k.key}
                    {#if k.sensitive}<span class="muted" style="font-size: 10px;">·sensitive</span>{/if}
                  </label>
                  {#if k.type === 'array'}
                    <textarea
                      id={`val-${t.id}-${rec.id}-${k.key}`}
                      rows="3"
                      placeholder="one item per line"
                      style="flex: 1; font-family: ui-monospace, monospace; font-size: 12px;"
                      value={recordValueAsString(rec, k.key, k.type)}
                      oninput={(e) => setRecordValue(t, rec.id, k.key, (e.currentTarget as HTMLTextAreaElement).value)}
                    ></textarea>
                  {:else if k.type === 'boolean'}
                    <select
                      id={`val-${t.id}-${rec.id}-${k.key}`}
                      style="flex: 1;"
                      value={recordValueAsString(rec, k.key, k.type)}
                      onchange={(e) => setRecordValue(t, rec.id, k.key, (e.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">(unset)</option>
                      <option value="yes">yes</option>
                      <option value="no">no</option>
                    </select>
                  {:else if k.type === 'number'}
                    <input
                      id={`val-${t.id}-${rec.id}-${k.key}`}
                      type="number"
                      style="flex: 1;"
                      value={recordValueAsString(rec, k.key, k.type)}
                      oninput={(e) => setRecordValue(t, rec.id, k.key, (e.currentTarget as HTMLInputElement).value)}
                    />
                  {:else}
                    <input
                      id={`val-${t.id}-${rec.id}-${k.key}`}
                      type="text"
                      style="flex: 1;"
                      value={recordValueAsString(rec, k.key, k.type)}
                      oninput={(e) => setRecordValue(t, rec.id, k.key, (e.currentTarget as HTMLInputElement).value)}
                    />
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/each}
        <div class="row" style="justify-content: flex-end;">
          <button type="button" onclick={() => addRecord(t)}>+ add record</button>
        </div>
      {/if}
    </div>
  </div>
{/each}
