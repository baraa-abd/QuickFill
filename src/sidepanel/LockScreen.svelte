<script lang="ts">
  import { rpcCall } from '$bg/messaging';

  type Props = { onUnlocked: () => void };
  let { onUnlocked }: Props = $props();

  let mode: 'password' | 'phrase' = $state('password');
  let password = $state('');
  let phrase = $state('');
  let busy = $state(false);
  let error = $state('');

  async function unlock() {
    busy = true;
    error = '';
    try {
      if (mode === 'password') {
        const r = await rpcCall('unlock-with-password', { password });
        if (!r.ok) {
          error = r.message;
          return;
        }
        if (!r.value.unlocked) {
          error = 'Wrong password.';
          return;
        }
      } else {
        const r = await rpcCall('unlock-with-phrase', { phrase });
        if (!r.ok) {
          error = r.message;
          return;
        }
        if (!r.value.unlocked) {
          error = 'That recovery phrase did not unlock the vault.';
          return;
        }
      }
      password = '';
      phrase = '';
      onUnlocked();
    } finally {
      busy = false;
    }
  }
</script>

<div class="card col">
  <h2>Locked</h2>
  {#if mode === 'password'}
    <label for="pw" class="muted">Master password</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="pw"
      type="password"
      bind:value={password}
      onkeydown={(e) => e.key === 'Enter' && unlock()}
      autocomplete="current-password"
      autofocus
    />
  {:else}
    <label for="phrase" class="muted">16-word recovery phrase</label>
    <textarea
      id="phrase"
      rows="3"
      bind:value={phrase}
      onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && unlock()}
      placeholder="word word word word word word word word word word word word word word word word"
    ></textarea>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="row" style="justify-content: space-between;">
    <button onclick={() => (mode = mode === 'password' ? 'phrase' : 'password')}>
      {mode === 'password' ? 'Use recovery phrase' : 'Use password'}
    </button>
    <button class="primary" onclick={unlock} disabled={busy}>Unlock</button>
  </div>
</div>
