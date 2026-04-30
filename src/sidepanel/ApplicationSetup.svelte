<script lang="ts">
  type Props = {
    onSubmit: (companyName: string, role: string, userBlurb: string | null) => void;
    onCancel: () => void;
  };
  let { onSubmit, onCancel }: Props = $props();

  let company = $state('');
  let role = $state('');
  let blurb = $state('');
  let error = $state('');

  function submit() {
    error = '';
    if (!company.trim()) {
      error = 'Company name is required.';
      return;
    }
    if (!role.trim()) {
      error = 'Role is required.';
      return;
    }
    onSubmit(company.trim(), role.trim(), blurb.trim() || null);
  }
</script>

<div class="card col">
  <h2>About this application</h2>
  <p class="muted">Used to bias retrieval. Cached for the session — re-asked when the browser closes.</p>

  <label class="muted" for="app-company">Company *</label>
  <input
    id="app-company"
    type="text"
    bind:value={company}
    onkeydown={(e) => e.key === 'Enter' && submit()}
  />
  <label class="muted" for="app-role">Role *</label>
  <input
    id="app-role"
    type="text"
    bind:value={role}
    onkeydown={(e) => e.key === 'Enter' && submit()}
  />
  <label class="muted" for="app-blurb">Notes (optional)</label>
  <textarea id="app-blurb" rows="3" bind:value={blurb}></textarea>

  {#if error}<div class="error">{error}</div>{/if}

  <div class="row" style="justify-content: space-between;">
    <button onclick={onCancel}>Cancel</button>
    <button class="primary" onclick={submit}>Continue</button>
  </div>
</div>
