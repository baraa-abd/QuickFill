<script lang="ts">
  import { rpcCall } from '$bg/messaging';

  let via: 'password' | 'phrase' = $state('password');
  let current = $state('');
  let phrase = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let busy = $state(false);
  let message: { kind: 'ok' | 'error'; text: string } | null = $state(null);

  function reset() {
    current = '';
    phrase = '';
    newPassword = '';
    confirmPassword = '';
  }

  async function submit() {
    message = null;
    if (newPassword.length < 8) {
      message = { kind: 'error', text: 'New password must be at least 8 characters.' };
      return;
    }
    if (newPassword !== confirmPassword) {
      message = { kind: 'error', text: 'New passwords do not match.' };
      return;
    }
    busy = true;
    try {
      const r = await rpcCall(
        'change-password',
        via === 'password'
          ? { via: 'password', current, newPassword }
          : { via: 'phrase', phrase, newPassword }
      );
      if (!r.ok) {
        message = { kind: 'error', text: r.message };
        return;
      }
      if (!r.value.ok) {
        message = {
          kind: 'error',
          text:
            r.value.reason === 'wrong-credential'
              ? via === 'password'
                ? 'Current password is wrong.'
                : 'That recovery phrase did not match.'
              : r.value.reason === 'no-recovery'
                ? 'No recovery phrase is set on this vault.'
                : 'New password is too short.'
        };
        return;
      }
      message = { kind: 'ok', text: 'Password changed. The recovery phrase still works.' };
      reset();
    } finally {
      busy = false;
    }
  }
</script>

<div class="card col">
  <h2>Change master password</h2>
  <p class="muted">
    Re-encrypts the vault under a new password. Your recovery phrase still works after this.
  </p>

  <div class="row" style="gap: 16px;">
    <label class="row" style="gap: 6px;">
      <input type="radio" name="via" value="password" bind:group={via} />
      <span>Use current password</span>
    </label>
    <label class="row" style="gap: 6px;">
      <input type="radio" name="via" value="phrase" bind:group={via} />
      <span>Use recovery phrase</span>
    </label>
  </div>

  {#if via === 'password'}
    <label class="muted" for="cur-pw">Current password</label>
    <input
      id="cur-pw"
      type="password"
      bind:value={current}
      autocomplete="current-password"
    />
  {:else}
    <label class="muted" for="cur-phrase">16-word recovery phrase</label>
    <textarea id="cur-phrase" rows="3" bind:value={phrase}></textarea>
  {/if}

  <label class="muted" for="new-pw">New password</label>
  <input
    id="new-pw"
    type="password"
    bind:value={newPassword}
    autocomplete="new-password"
  />
  <label class="muted" for="new-pw-2">Confirm new password</label>
  <input
    id="new-pw-2"
    type="password"
    bind:value={confirmPassword}
    autocomplete="new-password"
  />

  {#if message}
    <div class={message.kind === 'error' ? 'error' : 'muted'}>{message.text}</div>
  {/if}

  <div class="row" style="justify-content: flex-end;">
    <button class="primary" onclick={submit} disabled={busy}>
      {busy ? 'Changing…' : 'Change password'}
    </button>
  </div>
</div>
