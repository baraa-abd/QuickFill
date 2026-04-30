<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import GeneralPage from './GeneralPage.svelte';
  import ProfilePage from './ProfilePage.svelte';
  import StoriesPage from './StoriesPage.svelte';
  import HistoryPage from './HistoryPage.svelte';
  import ModelsPage from './ModelsPage.svelte';
  import PromptsPage from './PromptsPage.svelte';
  import LoggerPage from './LoggerPage.svelte';
  import BackupPage from './BackupPage.svelte';

  type Phase = 'loading' | 'setup' | 'locked' | 'unlocked';
  type Tab = 'general' | 'profile' | 'stories' | 'history' | 'models' | 'prompts' | 'logger' | 'backup';

  const TABS: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'profile', label: 'Profile' },
    { id: 'stories', label: 'Stories' },
    { id: 'history', label: 'Answer history' },
    { id: 'models', label: 'Models' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'logger', label: 'Debug' },
    { id: 'backup', label: 'Backup' }
  ];

  let phase: Phase = $state('loading');
  let password = $state('');
  let unlockError = $state('');
  let tab: Tab = $state(currentTab());

  function currentTab(): Tab {
    const h = (location.hash || '').replace(/^#/, '') as Tab;
    return (TABS.find((t) => t.id === h)?.id ?? 'general') as Tab;
  }

  async function refresh() {
    const init = await rpcCall('is-initialized', {});
    if (!init.ok || !init.value.initialized) {
      phase = 'setup';
      return;
    }
    const u = await rpcCall('is-unlocked', {});
    phase = u.ok && u.value.unlocked ? 'unlocked' : 'locked';
  }

  async function unlock() {
    unlockError = '';
    const r = await rpcCall('unlock-with-password', { password });
    if (!r.ok) {
      unlockError = r.message;
      return;
    }
    if (!r.value.unlocked) {
      unlockError = 'Wrong password.';
      return;
    }
    password = '';
    refresh();
  }

  function openOnboarding() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/index.html') });
  }

  function selectTab(t: Tab) {
    tab = t;
    if (location.hash !== '#' + t) location.hash = t;
  }

  onMount(() => {
    refresh();
    const onHashChange = () => (tab = currentTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });
</script>

<header><h1>AutoFill — Options</h1></header>

{#if phase === 'loading'}
  <p class="muted">Loading…</p>
{:else if phase === 'setup'}
  <div class="card col">
    <h2>Setup needed</h2>
    <button class="primary" onclick={openOnboarding}>Open setup</button>
  </div>
{:else if phase === 'locked'}
  <div class="card col">
    <h2>Unlock to view options</h2>
    <input
      type="password"
      bind:value={password}
      placeholder="Master password"
      onkeydown={(e) => e.key === 'Enter' && unlock()}
    />
    {#if unlockError}<div class="error">{unlockError}</div>{/if}
    <div class="row" style="justify-content: flex-end;">
      <button class="primary" onclick={unlock}>Unlock</button>
    </div>
  </div>
{:else}
  <nav class="tabs row" style="flex-wrap: wrap; gap: 4px;">
    {#each TABS as t (t.id)}
      <button
        class={tab === t.id ? 'tab tab-active' : 'tab'}
        onclick={() => selectTab(t.id)}
        type="button"
      >
        {t.label}
      </button>
    {/each}
  </nav>

  <main>
    {#if tab === 'general'}<GeneralPage onLocked={() => (phase = 'locked')} />
    {:else if tab === 'profile'}<ProfilePage />
    {:else if tab === 'stories'}<StoriesPage />
    {:else if tab === 'history'}<HistoryPage />
    {:else if tab === 'models'}<ModelsPage />
    {:else if tab === 'prompts'}<PromptsPage />
    {:else if tab === 'logger'}<LoggerPage />
    {:else if tab === 'backup'}<BackupPage />
    {/if}
  </main>
{/if}

<style>
  .tabs {
    margin: 8px 0 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }
  .tab {
    background: transparent;
    border: 1px solid transparent;
    padding: 6px 10px;
  }
  .tab-active {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-bottom-color: transparent;
  }
</style>
