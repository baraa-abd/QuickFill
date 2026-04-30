<script lang="ts">
  import { rpcCall } from '$bg/messaging';

  // Export state.
  let exportPassword = $state('');
  let exportConfirm = $state('');
  let exporting = $state(false);
  let exportError = $state('');
  let exportNote = $state('');

  // Import state.
  let importFile: File | null = $state(null);
  let importPassword = $state('');
  let importMode: 'replace-all' | 'merge-stories' = $state('merge-stories');
  let importing = $state(false);
  let importMsg = $state('');

  async function doExport() {
    exportError = '';
    exportNote = '';
    if (exportPassword.length < 8) {
      exportError = 'Export password must be at least 8 characters.';
      return;
    }
    if (exportPassword !== exportConfirm) {
      exportError = 'Passwords do not match.';
      return;
    }
    exporting = true;
    try {
      const r = await rpcCall('backup-export', { exportPassword });
      if (!r.ok) {
        exportError = r.message;
        return;
      }
      const json = JSON.stringify(r.value, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const ts = new Date(r.value.exportedAt).toISOString().replace(/[:.]/g, '-');
      const filename = `autofill-backup-${ts}.json`;
      // Use chrome.downloads if available; fall back to anchor click.
      if (chrome.downloads?.download) {
        await chrome.downloads.download({ url, filename, saveAs: true });
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }
      // Anchor URLs need a brief lifetime before revoke.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      exportNote = 'Backup exported.';
      exportPassword = '';
      exportConfirm = '';
    } finally {
      exporting = false;
    }
  }

  function pickImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    importFile = input.files?.[0] ?? null;
  }

  async function doImport() {
    importMsg = '';
    if (!importFile) {
      importMsg = 'Pick a backup file first.';
      return;
    }
    if (!importPassword) {
      importMsg = 'Enter the backup password.';
      return;
    }
    importing = true;
    try {
      const text = await importFile.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        importMsg = 'Backup file is not valid JSON.';
        return;
      }
      const r = await rpcCall('backup-import', {
        envelope: envelope as never,
        exportPassword: importPassword,
        mode: importMode
      });
      if (!r.ok) {
        importMsg = r.message;
        return;
      }
      if (!r.value.ok) {
        importMsg = r.value.message;
        return;
      }
      importMsg = `Imported (${importMode}). ${r.value.storiesAdded} stories added.`;
      importPassword = '';
      importFile = null;
    } catch (e) {
      importMsg = (e as Error).message ?? String(e);
    } finally {
      importing = false;
    }
  }
</script>

<div class="card col">
  <h2>Backup</h2>
  <p class="muted">
    Export an encrypted snapshot of your profile, stories, history, and settings — restorable on
    any machine. The export password is separate from your master password (so backups are
    portable).
  </p>
  <p class="muted" style="font-size: 12px;">
    The backup contains your full profile (including any sensitive fields). Treat the file like a
    secret.
  </p>
</div>

<div class="card col">
  <h3>Export</h3>
  <label class="muted" for="exp-pw">Export password</label>
  <input id="exp-pw" type="password" bind:value={exportPassword} autocomplete="new-password" />
  <label class="muted" for="exp-pw-2">Confirm password</label>
  <input id="exp-pw-2" type="password" bind:value={exportConfirm} autocomplete="new-password" />
  {#if exportError}<div class="error">{exportError}</div>{/if}
  {#if exportNote}<div class="muted">{exportNote}</div>{/if}
  <div class="row" style="justify-content: flex-end;">
    <button class="primary" onclick={doExport} disabled={exporting} type="button">
      {exporting ? 'Exporting…' : 'Export backup'}
    </button>
  </div>
</div>

<div class="card col">
  <h3>Import</h3>
  <label class="muted" for="imp-file">Backup file</label>
  <input id="imp-file" type="file" accept="application/json,.json" onchange={pickImport} />
  <label class="muted" for="imp-pw">Password</label>
  <input id="imp-pw" type="password" bind:value={importPassword} autocomplete="off" />
  <fieldset class="row" style="gap: 16px;">
    <legend>Mode</legend>
    <label class="row" style="gap: 6px;">
      <input type="radio" name="imp-mode" value="replace-all" bind:group={importMode} />
      <span>Replace all (overwrite profile / settings / history; replace stories)</span>
    </label>
    <label class="row" style="gap: 6px;">
      <input type="radio" name="imp-mode" value="merge-stories" bind:group={importMode} />
      <span>Merge stories only (skip ids that already exist locally)</span>
    </label>
  </fieldset>
  {#if importMsg}<div class="muted">{importMsg}</div>{/if}
  <div class="row" style="justify-content: flex-end;">
    <button class="primary" onclick={doImport} disabled={importing} type="button">
      {importing ? 'Importing…' : 'Import backup'}
    </button>
  </div>
</div>

<style>
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
  }
  legend {
    color: var(--muted);
    font-size: 12px;
    padding: 0 4px;
  }
</style>
