<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import LockScreen from './LockScreen.svelte';
  import Dashboard from './Dashboard.svelte';

  type Phase = 'loading' | 'setup' | 'locked' | 'unlocked';

  let phase: Phase = $state('loading');
  let error: string = $state('');

  async function refresh() {
    error = '';
    const init = await rpcCall('is-initialized', {});
    if (!init.ok) {
      error = init.message;
      return;
    }
    if (!init.value.initialized) {
      phase = 'setup';
      return;
    }
    const u = await rpcCall('is-unlocked', {});
    if (!u.ok) {
      error = u.message;
      return;
    }
    phase = u.value.unlocked ? 'unlocked' : 'locked';
  }

  function openOnboarding() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/index.html') });
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  onMount(() => {
    refresh();
    // Re-check on focus — onboarding completion in the other tab.
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });
</script>

{#if error}
  <div class="card error">{error}</div>
{/if}

{#if phase === 'loading'}
  <p class="muted">Loading…</p>
{:else if phase === 'setup'}
  <div class="card col">
    <h2>Setup needed</h2>
    <p class="muted">Welcome. Run the one-time setup to create your encrypted vault.</p>
    <button class="primary" onclick={openOnboarding}>Open setup</button>
  </div>
{:else if phase === 'locked'}
  <header class="row" style="justify-content: flex-end; margin-bottom: 12px;">
    <button onclick={openOptions} title="Options">⚙</button>
  </header>
  <LockScreen onUnlocked={refresh} />
{:else if phase === 'unlocked'}
  <Dashboard />
{/if}
