<script lang="ts">
  import { onMount } from 'svelte';
  import { rpcCall } from '$bg/messaging';
  import type { Profile, Story } from '$shared/types';
  import { docxToText } from './extract/docx';
  import { txtToText } from './extract/txt';

  type Step = 'welcome' | 'password' | 'phrase' | 'backend' | 'resume' | 'review' | 'done';

  let step: Step = $state('welcome');
  let initialized = $state(false);

  // password step
  let password = $state('');
  let confirmPassword = $state('');
  let passwordError = $state('');
  let busy = $state(false);

  // phrase step
  let phrase = $state('');
  let acknowledgedPhrase = $state(false);
  let phraseHint = $state('');
  let copyState: 'idle' | 'copied' | 'failed' = $state('idle');

  // backend step
  type BackendChoice = 'ollama' | 'anthropic' | 'openai' | 'gemini';
  let selectedBackend: BackendChoice = $state('ollama');
  // Ollama-specific
  let baseUrl = $state('http://localhost:11434');
  let ollamaModel = $state('gemma4:e4b');
  // Cloud-specific
  let apiKey = $state('');
  const cloudDefaults: Record<Exclude<BackendChoice, 'ollama'>, { model: string; label: string }> = {
    anthropic: { model: 'claude-sonnet-4-6', label: 'Claude (Anthropic)' },
    openai:    { model: 'gpt-4o-mini',       label: 'OpenAI' },
    gemini:    { model: 'gemini-2.0-flash',  label: 'Google Gemini' }
  };

  // resume step
  let resumeFile: File | null = $state(null);
  let resumeText = $state('');
  let resumeError = $state('');
  let resumeBusy = $state(false);
  let parsedProfile: Profile | null = $state(null);
  let parsedStories: Story[] = $state([]);

  // review step — editable profile + stories.
  let reviewProfile: Profile | null = $state(null);
  let reviewStories: Story[] = $state([]);
  let reviewBusy = $state(false);
  let reviewError = $state('');
  let rawTextOpen = $state(false);

  onMount(async () => {
    const r = await rpcCall('is-initialized', {});
    if (r.ok && r.value.initialized) {
      initialized = true;
      step = 'done';
    }
  });

  async function submitPassword() {
    passwordError = '';
    if (password.length < 8) {
      passwordError = 'Password must be at least 8 characters.';
      return;
    }
    if (password !== confirmPassword) {
      passwordError = 'Passwords do not match.';
      return;
    }
    busy = true;
    try {
      const r = await rpcCall('setup-master', { password });
      if (!r.ok) {
        passwordError = r.message;
        return;
      }
      phrase = r.value.recoveryPhrase;
      step = 'phrase';
    } finally {
      busy = false;
    }
  }

  async function continueFromPhrase() {
    if (!acknowledgedPhrase) {
      phraseHint =
        'Tick the box above to confirm you wrote the phrase down — or use "Skip (no recovery)" below if you accept the risk.';
      return;
    }
    phraseHint = '';
    step = 'backend';
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(phrase);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
    setTimeout(() => (copyState = 'idle'), 2500);
  }

  async function optOutPhrase() {
    if (!confirm('Without a recovery phrase, forgetting your password = permanent data loss. Continue?')) {
      return;
    }
    busy = true;
    try {
      await rpcCall('remove-recovery-phrase', {});
      phrase = '';
      step = 'backend';
    } finally {
      busy = false;
    }
  }

  async function saveBackend() {
    busy = true;
    try {
      const settings = await rpcCall('get-settings', {});
      if (!settings.ok) return;
      const next = structuredClone(settings.value);
      next.activeBackend = selectedBackend;
      if (selectedBackend === 'ollama') {
        next.backends.ollama = { baseUrl, model: ollamaModel };
      } else {
        const def = cloudDefaults[selectedBackend];
        next.backends[selectedBackend] = { apiKey, model: def.model };
      }
      await rpcCall('set-settings', next);
      step = 'resume';
    } finally {
      busy = false;
    }
  }

  async function pickResume(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    resumeFile = input.files?.[0] ?? null;
    resumeError = '';
    resumeText = '';
    if (!resumeFile) return;
    const name = resumeFile.name.toLowerCase();
    try {
      if (name.endsWith('.docx')) {
        resumeText = await docxToText(resumeFile);
      } else if (name.endsWith('.txt')) {
        resumeText = await txtToText(resumeFile);
      } else {
        resumeError = 'Unsupported format. Please upload a .docx or .txt file.';
        resumeFile = null;
      }
    } catch (err) {
      resumeError = `Could not read file: ${(err as Error).message ?? String(err)}`;
      resumeFile = null;
    }
  }

  async function parseAndReview() {
    resumeError = '';
    if (!resumeText.trim()) {
      resumeError = 'No text to parse — upload a file first.';
      return;
    }
    resumeBusy = true;
    try {
      const r = await rpcCall('parse-resume', { resumeText });
      if (!r.ok) {
        resumeError = r.message;
        return;
      }
      // Capture the plain values before Svelte proxifies them so that
      // structuredClone doesn't receive a reactive proxy (which can't be cloned).
      const rawProfile = r.value.profile;
      const rawStories = r.value.stories;
      parsedProfile = rawProfile;
      parsedStories = rawStories;
      reviewProfile = structuredClone(rawProfile);
      reviewStories = structuredClone(rawStories);
      step = 'review';
    } finally {
      resumeBusy = false;
    }
  }

  function skipResume() {
    step = 'done';
  }

  function reviewSetValue(key: string, idx: number, val: string) {
    if (!reviewProfile) return;
    const cur = reviewProfile.canonicalData[key];
    if (!cur) return;
    const values = cur.values.slice();
    values[idx] = val;
    reviewProfile = {
      ...reviewProfile,
      canonicalData: {
        ...reviewProfile.canonicalData,
        [key]: { ...cur, values, updatedAt: Date.now() }
      }
    };
  }

  function reviewRemoveKey(key: string) {
    if (!reviewProfile) return;
    const cd = { ...reviewProfile.canonicalData };
    delete cd[key];
    const am: Record<string, string> = {};
    for (const [a, k] of Object.entries(reviewProfile.aliasMap)) if (k !== key) am[a] = k;
    reviewProfile = {
      ...reviewProfile,
      canonicalData: cd,
      aliasMap: am,
      sensitiveKeys: reviewProfile.sensitiveKeys.filter((k) => k !== key)
    };
  }

  function reviewToggleSensitive(key: string) {
    if (!reviewProfile) return;
    const cur = reviewProfile.sensitiveKeys;
    reviewProfile = {
      ...reviewProfile,
      sensitiveKeys: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    };
  }

  function reviewRemoveStory(id: string) {
    reviewStories = reviewStories.filter((s) => s.id !== id);
  }

  function reviewSetStoryContent(id: string, content: string) {
    reviewStories = reviewStories.map((s) =>
      s.id === id ? { ...s, content, updatedAt: Date.now() } : s
    );
  }

  async function commitReview() {
    if (!reviewProfile) return;
    reviewError = '';
    reviewBusy = true;
    try {
      const r1 = await rpcCall('set-profile', reviewProfile);
      if (!r1.ok) {
        reviewError = r1.message;
        return;
      }
      const r2 = await rpcCall('set-stories', reviewStories);
      if (!r2.ok) {
        reviewError = r2.message;
        return;
      }
      step = 'done';
    } finally {
      reviewBusy = false;
    }
  }

  function openSidePanel() {
    window.close();
  }

  function phraseWords(): string[] {
    return phrase.split(/\s+/).filter(Boolean);
  }

  function reviewSortedKeys(): string[] {
    return reviewProfile ? Object.keys(reviewProfile.canonicalData).sort() : [];
  }
</script>

<header class="row" style="justify-content: space-between;">
  <h1>AutoFill — Setup</h1>
  <span class="step-label">{step}</span>
</header>

{#if step === 'welcome'}
  <div class="card col">
    <h2>Welcome</h2>
    <p>
      AutoFill is a user-centric job-application auto-fill extension. Press
      <span class="kbd">Alt</span> + <span class="kbd">A</span> on a form
      field to start a fill; press <span class="kbd">Esc</span> to cancel.
      Nothing happens automatically.
    </p>
    <p class="muted">
      All your data stays local, encrypted under a master password. Nothing
      leaves your machine except LLM calls (when you choose a cloud backend).
    </p>
    <div class="row" style="justify-content: flex-end;">
      <button class="primary" onclick={() => (step = 'password')}>Get started →</button>
    </div>
  </div>
{:else if step === 'password'}
  <div class="card col">
    <h2>Master password</h2>
    <p class="muted">At least 8 characters. We use this to encrypt everything stored locally.</p>
    <input type="password" bind:value={password} placeholder="Master password" autocomplete="new-password" />
    <input
      type="password"
      bind:value={confirmPassword}
      placeholder="Confirm password"
      autocomplete="new-password"
    />
    {#if passwordError}<div class="error">{passwordError}</div>{/if}
    <div class="row" style="justify-content: flex-end;">
      <button class="primary" onclick={submitPassword} disabled={busy}>
        {busy ? 'Setting up…' : 'Create vault →'}
      </button>
    </div>
  </div>
{:else if step === 'phrase'}
  <div class="card col">
    <h2>Recovery phrase</h2>
    <p>
      <strong>Write this down.</strong> If you forget your master password, this 16-word phrase is the
      <em>only</em> way to recover your data. We do not store it anywhere; we will not show it again.
    </p>
    <div class="phrase-grid">
      {#each phraseWords() as word, i (i)}
        <div class="phrase-cell"><span class="idx">{i + 1}.</span>{word}</div>
      {/each}
    </div>
    <div class="row" style="justify-content: flex-end;">
      <button onclick={copyPhrase} type="button">
        {#if copyState === 'copied'}✓ Copied{:else if copyState === 'failed'}Copy failed — select manually{:else}Copy phrase{/if}
      </button>
    </div>
    <label class="row">
      <input
        type="checkbox"
        bind:checked={acknowledgedPhrase}
        onchange={() => acknowledgedPhrase && (phraseHint = '')}
      />
      <span>I wrote this down somewhere safe.</span>
    </label>
    {#if phraseHint}<div class="error">{phraseHint}</div>{/if}
    <div class="row" style="justify-content: space-between;">
      <button onclick={optOutPhrase} disabled={busy}>Skip (no recovery)</button>
      <button class="primary" onclick={continueFromPhrase}>
        Continue →
      </button>
    </div>
  </div>
{:else if step === 'backend'}
  <div class="card col">
    <h2>AI backend</h2>
    <p class="muted">
      Choose the LLM backend to use. You can change this at any time on the
      <strong>Options → Models</strong> page.
    </p>

    <fieldset style="border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px;">
      <legend style="font-size: 12px; color: var(--muted, #6b7280);">Backend</legend>
      <div class="col" style="gap: 6px;">
        <label class="row">
          <input type="radio" name="backend" value="ollama" bind:group={selectedBackend} />
          <span>Ollama (local — runs on your machine)</span>
        </label>
        <label class="row">
          <input type="radio" name="backend" value="anthropic" bind:group={selectedBackend} />
          <span>Anthropic (Claude) — recommended for resume parsing</span>
        </label>
        <label class="row">
          <input type="radio" name="backend" value="openai" bind:group={selectedBackend} />
          <span>OpenAI</span>
        </label>
        <label class="row">
          <input type="radio" name="backend" value="gemini" bind:group={selectedBackend} />
          <span>Google Gemini</span>
        </label>
      </div>
    </fieldset>

    {#if selectedBackend === 'ollama'}
      <label class="muted" for="ollama-url">Base URL</label>
      <input id="ollama-url" type="text" bind:value={baseUrl} />
      <label class="muted" for="ollama-model">Model</label>
      <input id="ollama-model" type="text" bind:value={ollamaModel} />
      <p class="muted" style="font-size: 12px;">
        Allow the extension origin in your Ollama server:<br />
        <span class="kbd">OLLAMA_ORIGINS=chrome-extension://{chrome.runtime.id} ollama serve</span>
      </p>
    {:else}
      <label class="muted" for="cloud-key">
        API key for {cloudDefaults[selectedBackend].label}
      </label>
      <input id="cloud-key" type="password" bind:value={apiKey} placeholder="sk-…" autocomplete="off" />
      <p class="muted" style="font-size: 12px;">
        Default model: <strong>{cloudDefaults[selectedBackend].model}</strong>
        — change in Options → Models after setup.
      </p>
    {/if}

    <div class="row" style="justify-content: flex-end;">
      <button class="primary" onclick={saveBackend} disabled={busy}>
        {busy ? 'Saving…' : 'Continue →'}
      </button>
    </div>
  </div>
{:else if step === 'resume'}
  <div class="card col">
    <h2>Resume upload</h2>
    <p class="muted">
      DOCX or plain text. PDF is not supported — paste the text into a <span class="kbd">.txt</span>
      file or upload the source <span class="kbd">.docx</span> instead.
    </p>
    <input type="file" accept=".docx,.txt" onchange={pickResume} />
    {#if resumeFile && resumeText}
      <p class="muted" style="font-size: 12px;">
        Read {resumeText.length.toLocaleString()} characters from <strong>{resumeFile.name}</strong>.
      </p>
    {/if}
    {#if resumeError}<div class="error">{resumeError}</div>{/if}
    <div class="row" style="justify-content: space-between;">
      <button onclick={skipResume} type="button">Skip — set up profile manually later</button>
      <button class="primary" onclick={parseAndReview} disabled={resumeBusy || !resumeText}>
        {resumeBusy ? 'Parsing…' : 'Parse with LLM →'}
      </button>
    </div>
  </div>
{:else if step === 'review' && reviewProfile}
  <div class="card col">
    <h2>Profile review</h2>
    <p class="muted">
      The LLM proposed these fields. Edit, mark sensitive, or remove anything that's wrong, then
      commit.
    </p>
    <button onclick={() => (rawTextOpen = !rawTextOpen)} type="button">
      {rawTextOpen ? 'Hide' : 'Show'} raw extracted text
    </button>
    {#if rawTextOpen}
      <pre class="raw">{resumeText}</pre>
    {/if}
  </div>

  {#each reviewSortedKeys() as key (key)}
    {@const pv = reviewProfile.canonicalData[key]}
    <div class="card col">
      <div class="row" style="justify-content: space-between;">
        <strong>{key}</strong>
        <div class="row">
          <label class="row" style="font-size: 12px;">
            <input
              type="checkbox"
              checked={reviewProfile.sensitiveKeys.includes(key)}
              onchange={() => reviewToggleSensitive(key)}
            />
            <span>sensitive</span>
          </label>
          <button class="danger" type="button" onclick={() => reviewRemoveKey(key)}>Remove</button>
        </div>
      </div>
      {#each pv.values as v, i (i)}
        <input
          type="text"
          value={v}
          oninput={(e) => reviewSetValue(key, i, (e.currentTarget as HTMLInputElement).value)}
        />
      {/each}
    </div>
  {/each}

  {#if reviewStories.length > 0}
    <div class="card col">
      <h3>Stories</h3>
      {#each reviewStories as s (s.id)}
        <div class="col" style="gap: 4px;">
          <textarea
            rows="4"
            value={s.content}
            oninput={(e) => reviewSetStoryContent(s.id, (e.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="row" style="justify-content: space-between; font-size: 12px;">
            <span class="muted">tags: {s.keywords.join(', ') || '—'}</span>
            <button type="button" onclick={() => reviewRemoveStory(s.id)}>Remove story</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if reviewError}<div class="error">{reviewError}</div>{/if}
  <div class="row" style="justify-content: space-between;">
    <button onclick={() => (step = 'resume')} type="button">← Back</button>
    <button class="primary" onclick={commitReview} disabled={reviewBusy} type="button">
      {reviewBusy ? 'Saving…' : 'Save profile and continue'}
    </button>
  </div>
{:else if step === 'done'}
  <div class="card col">
    <h2>{initialized ? 'All set' : 'Done'}</h2>
    <p>
      Open the side panel from the Chrome toolbar to start. Press
      <span class="kbd">Alt</span> + <span class="kbd">A</span> on a form field on any page to fill,
      and <span class="kbd">Esc</span> to cancel.
    </p>
    <div class="row" style="justify-content: flex-end;">
      <button class="primary" onclick={openSidePanel}>Close</button>
    </div>
  </div>
{/if}

<style>
  pre.raw {
    white-space: pre-wrap;
    background: #f3f4f6;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 11px;
    max-height: 240px;
    overflow: auto;
  }
</style>
