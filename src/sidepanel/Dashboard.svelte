<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import { SessionStore } from './session-store.svelte';
  import StatusTicker from './StatusTicker.svelte';
  import ErrorBanner from './ErrorBanner.svelte';
  import ApplicationSetup from './ApplicationSetup.svelte';
  import DraftArea from './DraftArea.svelte';
  import ProfileUpdateCard from './ProfileUpdateCard.svelte';
  import DedupToast from './DedupToast.svelte';
  import StoryDiscoveryPrompt from './StoryDiscoveryPrompt.svelte';
  import AddToProfileCard from './AddToProfileCard.svelte';
  import FillHistory from './FillHistory.svelte';
  import SaveHistory from './SaveHistory.svelte';
  import DiagnosticPanel from './DiagnosticPanel.svelte';
  import type { ActiveApplication } from '$shared/types';

  const session = new SessionStore();

  let activeApplication: ActiveApplication | null = $state(null);
  let sensitiveBadge = $state(false);

  async function refreshActiveApplication() {
    const r = await rpcCall('get-active-application', {});
    activeApplication = r.ok ? (r.value as ActiveApplication | null) : null;
  }

  async function refreshSensitiveBadge() {
    try {
      const [settings, profile] = await Promise.all([
        rpcCall('get-settings', {}),
        rpcCall('get-profile', {})
      ]);
      if (!settings.ok || !profile.ok) return;
      const isCloud = settings.value.activeBackend !== 'ollama';
      const hasSensitive = (profile.value as { sensitiveKeys: string[] }).sensitiveKeys.length > 0;
      sensitiveBadge = isCloud && hasSensitive;
    } catch {
      /* */
    }
  }

  onMount(() => {
    session.start();
    refreshActiveApplication();
    refreshSensitiveBadge();

    // Window-level keyboard shortcuts:
    //   Esc → abort the active session (matches the page-side handler).
    //   Enter (only when in manual_highlight phase, and not while the user is
    //         typing in an input/textarea inside the panel) → submit the
    //         current page selection. The page-side Enter handler (when the
    //         iframe / page has focus) also submits; the panel handler
    //         covers the case where focus stayed in the panel after the
    //         user drag-selected on the page.
    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        session.postAbort();
        return;
      }
      if (e.key === 'Enter' && session.phase === 'manual_highlight') {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
        if (!session.manualSelection.trim()) return;
        e.preventDefault();
        session.postManualHighlightSubmit();
      }
    }
    window.addEventListener('keydown', onKeydown, true);

    function onFocus() {
      refreshActiveApplication();
    }
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('focus', onFocus);
      session.stop();
    };
  });

  function clearActiveApplication() {
    rpcCall('clear-active-application', {}).then(() => refreshActiveApplication());
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  async function lock() {
    await rpcCall('lock', {});
    location.reload();
  }
</script>

<header class="row" style="justify-content: space-between; margin-bottom: 8px;">
  <h1>AutoFill</h1>
  <div class="row" style="gap: 6px;">
    <button onclick={openOptions} title="Options">⚙</button>
    <button onclick={lock} title="Lock vault">🔒</button>
  </div>
</header>

{#if activeApplication}
  <div class="card" style="padding: 8px 10px; margin: 4px 0;">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div>
        <strong>{activeApplication.companyName}</strong> · {activeApplication.role}
        <div class="muted" style="font-size: 11px;">{activeApplication.genericKey}</div>
      </div>
      <button onclick={clearActiveApplication} title="Clear active application">×</button>
    </div>
  </div>
{/if}

{#if sensitiveBadge}
  <div class="card" style="padding: 6px 10px; background: #fef3c7; border-color: #f59e0b; font-size: 12px;">
    Some profile fields may be hidden from a cloud LLM. <button onclick={openOptions} style="padding: 0 4px;">Review</button>
  </div>
{/if}

<StatusTicker message={session.status} />

<ErrorBanner
  message={session.errorMessage}
  retryable={session.errorRetryable}
  onDismiss={() => {
    session.errorMessage = '';
    session.errorRetryable = false;
  }}
/>

<!-- Phase-driven UI. Profile-direct and profile_existing_value commits do
     NOT show a card — they auto-fill, append to FillHistory, and end the
     session. Only profile_update + story_answer + manual_highlight need
     panel interaction. -->

{#if session.phase === 'idle'}
  <div class="card col">
    <p class="muted">
      Press <span class="kbd">Alt</span>+<span class="kbd">A</span> on a form field to auto-fill.
      Press <span class="kbd">Alt</span>+<span class="kbd">Shift</span>+<span class="kbd">A</span>
      to manually select the question text instead.
      Press <span class="kbd">Alt</span>+<span class="kbd">S</span> to save a field's current value
      to your profile. <span class="kbd">Esc</span> cancels at any time.
    </p>
  </div>
{:else if session.phase === 'detecting' || session.phase === 'matching' || session.phase === 'classifying'}
  <div class="card col">
    <p class="muted">{session.status || 'Working…'}</p>
  </div>
{:else if session.phase === 'manual_highlight'}
  <div class="card col">
    <h2>Highlight the question text on the page</h2>
    <p class="muted" style="font-size: 12px;">
      Drag-select the question on the page. Then press <span class="kbd">Enter</span> here, or
      click "Use this selection" below. <span class="kbd">Esc</span> cancels.
    </p>

    <div
      style="white-space: pre-wrap; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fafafa; min-height: 40px;"
      aria-live="polite"
    >
      {#if session.manualSelection}
        <strong>Selected:</strong> {session.manualSelection}
      {:else}
        <span class="muted">No selection yet — drag-select the question text on the page.</span>
      {/if}
    </div>

    <div class="row" style="justify-content: space-between;">
      <button onclick={() => session.postAbort()}>Cancel</button>
      <button
        class="primary"
        disabled={!session.manualSelection.trim()}
        onclick={() => session.postManualHighlightSubmit()}
      >
        Use this selection
      </button>
    </div>
  </div>
{:else if session.phase === 'profile_update_pending' && session.profileUpdate}
  <ProfileUpdateCard
    update={session.profileUpdate}
    onConfirm={(k, v, s) => session.postConfirmProfileUpdate(k, v, s)}
    onCancel={() => session.postAbort()}
  />
{:else if session.phase === 'story_setup'}
  <ApplicationSetup
    onSubmit={(c, r, b) => session.postSetActiveApplication(c, r, b)}
    onCancel={() => session.postAbort()}
  />
{:else if session.phase === 'answering'}
  <DraftArea
    draft={session.draft}
    streaming={session.draftStreaming}
    done={session.draftDone}
    maxLength={session.maxLength}
    onConfirm={(o) => session.postConfirmFill(o)}
    onCancel={() => session.postAbort()}
  />
{/if}

<!-- Alt+S confirmation card (for long labels / values) overlays whatever
     phase is active. The SW broadcasts add-to-profile-confirm independently
     of the phase. -->
{#if session.addToProfileConfirm}
  <AddToProfileCard
    confirm={session.addToProfileConfirm}
    onSubmit={(k, v, s) => {
      session.postAddToProfileSubmit(k, v, s);
      session.addToProfileConfirm = null;
    }}
    onCancel={() => {
      session.postAbort();
      session.addToProfileConfirm = null;
    }}
  />
{/if}

{#if session.dedupMerge}
  <DedupToast
    merge={session.dedupMerge}
    onUndo={() => {
      session.postUndoMerge();
      session.dedupMerge = null;
    }}
    onDismiss={() => (session.dedupMerge = null)}
  />
{/if}

{#if session.storyDiscovered}
  <StoryDiscoveryPrompt
    proposal={session.storyDiscovered}
    onConfirm={(c, k) => {
      session.postConfirmStory(c, k);
      session.storyDiscovered = null;
    }}
    onDismiss={() => (session.storyDiscovered = null)}
  />
{/if}

<!-- Recent activity is always visible, regardless of phase. -->
<FillHistory
  entries={session.recentActivity}
  onRevert={(id) => session.postRevertFill(id)}
  onSwitchValue={(id, val) => session.postSwitchFillValue(id, val)}
/>
<SaveHistory entries={session.recentActivity} onDelete={(id) => session.postDeleteSave(id)} />

<DiagnosticPanel />
