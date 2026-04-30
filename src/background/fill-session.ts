// FillSession — single in-flight session orchestrator (§3.3).
//
// Owns the active fill from Alt+A → commit. At most one session at a time;
// starting a new one aborts any in-flight LLM stream from the previous one.
//
// Multi-frame routing
// ─────────────────────────────────────────────────────────────────────────
// chrome.commands gives us only `tabId`, never `frameId`. Iframes are first-
// class citizens of job application sites (Workday, Greenhouse, …). To find
// the focused field regardless of frame, the SW *broadcasts* `run-detective`
// to every content port for the tab; each frame's content script self-
// elects (only the focused frame replies with `fill-plan`). The session
// records the `(tabId, frameId)` of the responding frame and routes all
// subsequent events (`commit`, `manual-highlight-*`, `close`) only to that
// frame. Manual highlight is also broadcast — selections come back from
// whichever frame the user is dragging in.
//
// Auto-commit
// ─────────────────────────────────────────────────────────────────────────
// Per §4.2 + §4.3, profile direct-matches and `profile_existing_value`
// classifier results commit straight to the field. There is no preview /
// confirm / edit / cancel for these — the user can hit Alt+S afterwards if
// they want to record a different value, or use the recent-fills delete
// button to revert. Only `profile_update` (must be acknowledged before we
// touch the profile) and `story_answer` (LLM-generated, user reviews
// streamed draft) require panel interaction.

import { z } from 'zod';
import { cleanLabel } from '$shared/clean';
import type {
  ActiveApplication,
  AnswerHistoryEntry,
  FieldType,
  FillPlan,
  Profile,
  Settings,
  Story
} from '$shared/types';
import { SENSITIVE_CANONICAL_KEYS } from '$shared/constants';
import { logger } from './logger';
import { type ContentPort, type PortEvent } from './messaging';
import { matchAlias, pickMatchingOption, appendValueDedup } from './matcher';
import { classifyField } from './classifier';
import { runChooser, resolveMaxLength, runStoryDiscovery, streamAnswer } from './llm/answer';
import { deriveGenericKey } from './llm/generic-key';
import { embed } from './rag/embeddings';
import { ingest, applyUndo } from './history';

// ───────────────────────── public types ─────────────────────────

export type FillKind = 'fill' | 'add-to-profile';

/** A snapshot of a recent fill; lives in a session-local ring buffer in the
 *  SW. The panel renders these in `FillHistory` and the `revert-fill` event
 *  uses the captured `previousValue` to restore the field. */
export type FillActivity = {
  kind: 'fill';
  id: string;
  at: number;
  label: string;                // resolved question text
  canonicalKey: string | null;  // null for story_answer
  value: string;                // committed value
  source: 'profile' | 'profile_existing_value' | 'profile_update' | 'story_answer';
  // Other stored values for the same canonical key (profile hits only). When
  // non-empty, the panel shows a value-switcher on the most recent fill card.
  alternativeValues: string[];
  // For revert:
  tabId: number;
  frameId: number;
  elementRef: string;
  previousValue: string;
  fieldType: FieldType;
};

/** A snapshot of a recent Alt+S save; the `previousProfile` snapshot lets
 *  the panel's delete button atomically undo the write (whether it created
 *  a new canonical key or appended to an existing one). */
export type SaveActivity = {
  kind: 'save';
  id: string;
  at: number;
  label: string;                // canonical key written
  value: string;
  previousProfile: Profile;     // snapshot taken just before the write
};

export type RecentActivity = FillActivity | SaveActivity;

export type FillSessionDeps = {
  /** All live content ports for a tab — used to broadcast run-detective and
   *  manual-highlight-* events to every frame. */
  getAllContentPorts: (tabId: number) => ContentPort[];
  /** Direct-port lookup, used after a frame has self-elected so we can route
   *  follow-ups only to that frame. */
  getContentPort: (tabId: number, frameId: number) => ContentPort | null;
  broadcastPanel: (ev: PortEvent) => void;
  loadSettings: () => Promise<Settings>;
  loadProfile: () => Promise<Profile>;
  saveProfile: (p: Profile) => Promise<void>;
  loadStories: () => Promise<Story[]>;
  saveStories: (s: Story[]) => Promise<void>;
  loadHistory: () => Promise<AnswerHistoryEntry[]>;
  saveHistory: (h: AnswerHistoryEntry[]) => Promise<void>;
  loadActiveApplication: () => Promise<ActiveApplication | null>;
  saveActiveApplication: (a: ActiveApplication | null) => Promise<void>;
  commitOnPage: (
    tabId: number,
    frameId: number,
    elementRef: string,
    fieldType: FieldType,
    value: string
  ) => Promise<{ ok: boolean; kind?: string; message?: string }>;
  /** Append an entry to the SW's session-local activity ring buffer. */
  pushActivity: (entry: RecentActivity) => void;
  /** Remove an entry from the ring buffer (after revert/delete). */
  removeActivity: (id: string) => void;
};

// ───────────────────────── internals ─────────────────────────

type Phase =
  | 'idle'
  | 'detecting'
  | 'manual_highlight'
  | 'matching'
  | 'classifying'
  | 'profile_update_pending'
  | 'story_setup'
  | 'answering'
  | 'committed'
  | 'cancelled';

type State = {
  kind: FillKind;
  phase: Phase;
  abort: AbortController;

  // Captured incrementally as the session progresses:
  plan: FillPlan | null;
  resolvedQuestion: string | null;     // post-manual-highlight if any
  // Set once a frame self-elects in response to run-detective. Used for all
  // follow-up events (commit, manual-highlight-stop, close) so we don't
  // multi-broadcast.
  electedTabId: number;
  electedFrameId: number | null;

  // Profile-update specifics:
  pendingUpdateKey: string | null;

  // story_answer specifics:
  fullAnswer: string;                 // accumulated streamed tokens
  draftEditedByUser: boolean;
  maxLength: number | null;

  // Pending merge-undo data (set when ingest returns kind:'merged'):
  undoSnapshot: AnswerHistoryEntry | null;

  // When true (Alt+Shift+A path), skip to manual_highlight regardless of
  // whether the detective found a question label.
  forceManualHighlight: boolean;
};

export class FillSessionImpl {
  private state: State | null = null;

  constructor(private deps: FillSessionDeps) {}

  isActive(): boolean {
    return this.state !== null;
  }

  /**
   * Begin a fill session. Broadcasts `run-detective` to every content port
   * for the tab; the focused frame self-elects and replies with a fill-plan.
   * If no frame responds within `DETECTIVE_TIMEOUT_MS`, we surface "no
   * focused field" to the panel.
   */
  start(kind: FillKind, tabId: number, _initialFrameId: number): void {
    if (this.state) this.abort();
    const ports = this.deps.getAllContentPorts(tabId);
    if (ports.length === 0) {
      this.deps.broadcastPanel({
        t: 'error',
        message:
          'No content script is connected for this tab. Reload the page and press Alt+A again.',
        retryable: false
      });
      return;
    }
    // Wipe any stale panel state from a previous session before starting fresh.
    this.deps.broadcastPanel({ t: 'close' });
    this.state = {
      kind,
      phase: 'detecting',
      abort: new AbortController(),
      plan: null,
      resolvedQuestion: null,
      electedTabId: tabId,
      electedFrameId: null,
      pendingUpdateKey: null,
      fullAnswer: '',
      draftEditedByUser: false,
      maxLength: null,
      undoSnapshot: null,
      forceManualHighlight: false
    };
    this.deps.broadcastPanel({ t: 'phase', phase: 'detecting' });
    this.deps.broadcastPanel({ t: 'status', message: 'Looking for the focused field…' });
    for (const p of ports) p.post({ t: 'run-detective' });

    // No-response timeout. If no frame self-elects in DETECTIVE_TIMEOUT_MS,
    // surface a clear error.
    setTimeout(() => {
      if (this.state && this.state.phase === 'detecting' && this.state.electedFrameId == null) {
        this.deps.broadcastPanel({
          t: 'status',
          message: 'No field is focused. Click into a form field, then press Alt+A.'
        });
        this.endSession();
      }
    }, 1500);
  }

  /**
   * Alt+Shift+A variant: skip the detective's label auto-detection and jump
   * straight to manual highlight. The detective is still sent so we capture
   * the FillPlan (elementRef, fieldType, etc.) needed to commit later, but
   * the session goes to manual_highlight regardless of whether the detective
   * found a question label.
   */
  startWithManualHighlight(tabId: number): void {
    if (this.state) this.abort();
    const ports = this.deps.getAllContentPorts(tabId);
    if (ports.length === 0) {
      this.deps.broadcastPanel({
        t: 'error',
        message:
          'No content script is connected for this tab. Reload the page and press Alt+Shift+A again.',
        retryable: false
      });
      return;
    }
    // Wipe any stale panel state from a previous session before starting fresh.
    this.deps.broadcastPanel({ t: 'close' });
    this.state = {
      kind: 'fill',
      phase: 'detecting',
      abort: new AbortController(),
      plan: null,
      resolvedQuestion: null,
      electedTabId: tabId,
      electedFrameId: null,
      pendingUpdateKey: null,
      fullAnswer: '',
      draftEditedByUser: false,
      maxLength: null,
      undoSnapshot: null,
      forceManualHighlight: true
    };
    this.deps.broadcastPanel({ t: 'phase', phase: 'detecting' });
    this.deps.broadcastPanel({ t: 'status', message: 'Connecting to the field…' });
    for (const p of ports) p.post({ t: 'run-detective' });

    // Timeout: if no frame self-elects, still activate manual_highlight so
    // the user can drag-select the question (commit will fail gracefully
    // if no plan was captured).
    setTimeout(() => {
      if (this.state && this.state.phase === 'detecting' && this.state.electedFrameId == null) {
        this.state.phase = 'manual_highlight';
        this.deps.broadcastPanel({ t: 'phase', phase: 'manual_highlight' });
        this.deps.broadcastPanel({
          t: 'status',
          message:
            'No focused field found. Highlight the question text on the page, then press Enter.'
        });
        for (const p of this.deps.getAllContentPorts(this.state.electedTabId)) {
          p.post({ t: 'manual-highlight-start' });
        }
      }
    }, 1500);
  }

  abort(): void {
    if (!this.state) return;
    this.state.abort.abort();
    this.broadcastClose();
    this.deps.broadcastPanel({ t: 'phase', phase: 'cancelled' });
    this.deps.broadcastPanel({ t: 'close' });
    this.deps.broadcastPanel({ t: 'status', message: 'Cancelled.' });
    this.state = null;
  }

  /** Receive a port event from any content script in any frame. */
  async onContentEvent(ev: PortEvent, tabId: number, frameId: number): Promise<void> {
    if (!this.state) return;
    if (tabId !== this.state.electedTabId) return; // wrong tab — ignore

    switch (ev.t) {
      case 'fill-plan': {
        // First responder wins. Subsequent fill-plans (race) are ignored.
        if (this.state.electedFrameId != null) return;
        this.state.electedFrameId = frameId;
        const plan: FillPlan = { ...ev.plan, tabId, frameId };
        this.state.plan = plan;
        if (plan.question == null || this.state.forceManualHighlight) {
          // Either tree-climbing found no label, or the user explicitly
          // requested manual highlight (Alt+Shift+A). Broadcast to ALL
          // frames; whichever frame the user selects in will report selections.
          this.state.phase = 'manual_highlight';
          this.deps.broadcastPanel({ t: 'phase', phase: 'manual_highlight' });
          this.deps.broadcastPanel({
            t: 'status',
            message: 'Could not find the question text. Highlight it on the page, then press Enter.'
          });
          for (const p of this.deps.getAllContentPorts(this.state.electedTabId)) {
            p.post({ t: 'manual-highlight-start' });
          }
          return;
        }
        this.state.resolvedQuestion = plan.question;
        await this.continueAfterLabelKnown();
        return;
      }
      case 'detective-failed': {
        // Only the elected frame can fail with field-rejected (non-elected
        // frames stay silent for run-detective). Treat field-rejected as
        // terminal.
        if (ev.reason.startsWith('field-rejected:')) {
          this.deps.broadcastPanel({ t: 'status', message: "This field can't be filled." });
          this.endSession();
        }
        return;
      }
      case 'manual-highlight-selection': {
        // Forward to panel as a status update + a structured event for the
        // selection preview.
        this.deps.broadcastPanel({ t: 'manual-highlight-selection', text: ev.text });
        this.deps.broadcastPanel({
          t: 'status',
          message: ev.text ? `Selected: "${truncate(ev.text, 80)}"` : 'No selection yet…'
        });
        return;
      }
      case 'manual-highlight-cancel': {
        this.deps.broadcastPanel({ t: 'status', message: 'Manual highlight cancelled.' });
        this.endSession();
        return;
      }
      case 'manual-highlight-submit': {
        await this.handleManualHighlightSubmit(ev.text);
        return;
      }
      case 'abort': {
        this.abort();
        return;
      }
      default:
        return;
    }
  }

  async onPanelEvent(ev: PortEvent): Promise<void> {
    if (!this.state) {
      // Even with no active session, let abort reset the panel, and let
      // the stateless events through.
      if (ev.t === 'abort') {
        this.deps.broadcastPanel({ t: 'close' });
        return;
      }
      if (ev.t !== 'revert-fill' && ev.t !== 'delete-save' && ev.t !== 'undo-merge') {
        return;
      }
    }
    switch (ev.t) {
      case 'abort':
        this.abort();
        return;
      case 'set-active-application':
        await this.setActiveApplicationFromPanel(ev.companyName, ev.role, ev.userBlurb);
        return;
      case 'manual-highlight-submit':
        await this.handleManualHighlightSubmit(ev.text);
        return;
      case 'confirm-fill':
        await this.handleConfirmStoryAnswer(ev.valueOverride);
        return;
      case 'confirm-profile-update':
        await this.handleProfileUpdateConfirm(ev.canonicalKey, ev.value, ev.sensitive);
        return;
      case 'undo-merge':
        await this.handleUndoMerge();
        return;
      case 'confirm-story':
        await this.handleConfirmStory(ev.content, ev.keywords);
        return;
      case 'add-to-profile-submit':
        await this.handleAddToProfileSubmit(ev.canonicalKey, ev.value, ev.sensitive);
        return;
      case 'revert-fill':
        await this.handleRevertFill(ev.id);
        return;
      case 'delete-save':
        await this.handleDeleteSave(ev.id);
        return;
      default:
        return;
    }
  }

  // ───────────────────────── workflow steps ─────────────────────────

  private endSession(): void {
    this.broadcastClose();
    this.deps.broadcastPanel({ t: 'close' });
    this.state = null;
  }

  private broadcastClose(): void {
    if (!this.state) return;
    for (const p of this.deps.getAllContentPorts(this.state.electedTabId)) {
      p.post({ t: 'close' });
    }
  }

  private async handleManualHighlightSubmit(text: string): Promise<void> {
    if (!this.state) return;
    const t = text.trim();
    if (!t) {
      this.deps.broadcastPanel({
        t: 'error',
        message: 'Selection was empty — drag-select the question text first.',
        retryable: false
      });
      return;
    }
    if (!this.state.plan) {
      this.endSession();
      return;
    }
    this.state.plan = { ...this.state.plan, question: t };
    this.state.resolvedQuestion = t;
    if (this.state.electedTabId != null) {
      for (const p of this.deps.getAllContentPorts(this.state.electedTabId)) {
        p.post({ t: 'manual-highlight-stop' });
      }
    }
    this.deps.broadcastPanel({ t: 'status', message: 'Got it. Continuing…' });
    await this.continueAfterLabelKnown();
  }

  private async continueAfterLabelKnown(): Promise<void> {
    if (!this.state || !this.state.plan || this.state.resolvedQuestion == null) return;

    if (this.state.kind === 'add-to-profile') {
      await this.runAddToProfile();
      return;
    }

    const settings = await this.deps.loadSettings();
    const profile = await this.deps.loadProfile();
    const plan = this.state.plan;
    const label = this.state.resolvedQuestion;

    // §4.2 direct match
    this.state.phase = 'matching';
    this.deps.broadcastPanel({ t: 'phase', phase: 'matching' });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Checking your profile for "${label}"…`
    });

    const hit = matchAlias(label, profile, settings.matching.fuseThreshold);
    if (hit) {
      const consumed = await this.tryAutoCommitFromProfile(
        hit.canonicalKey,
        profile,
        plan,
        settings,
        'profile'
      );
      if (consumed) return;
    }

    // §4.3 classifier
    this.state.phase = 'classifying';
    this.deps.broadcastPanel({ t: 'phase', phase: 'classifying' });
    this.deps.broadcastPanel({ t: 'status', message: 'Classifying field with the LLM…' });

    const cl = await classifyField({
      fieldLabel: label,
      fieldType: plan.fieldType,
      options: plan.options,
      profile,
      settings,
      grandparentHtml: plan.grandparentHtml ?? null,
      elementDescriptor: plan.elementDescriptor ?? ''
    });
    if (!cl.ok) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Classifier: ${cl.message}`,
        retryable: cl.retryable
      });
      return;
    }
    const result = cl.result;
    if (result.category === 'profile_existing_value') {
      const consumed = await this.tryAutoCommitFromProfile(
        result.canonicalKey,
        profile,
        plan,
        settings,
        'profile_existing_value'
      );
      if (consumed) return;
      // Fell through (e.g. select with no good options) → story_answer fallback.
      await this.runStoryAnswer(plan, label, settings, profile);
      return;
    }
    if (result.category === 'profile_update') {
      this.state.phase = 'profile_update_pending';
      this.state.pendingUpdateKey = result.canonicalKey;
      this.deps.broadcastPanel({ t: 'phase', phase: 'profile_update_pending' });
      this.deps.broadcastPanel({
        t: 'profile-update',
        suggestedKey: result.canonicalKey,
        fieldType: plan.fieldType,
        options: plan.options,
        proposedValue: ''
      });
      return;
    }
    // story_answer
    await this.runStoryAnswer(plan, label, settings, profile);
  }

  /**
   * Auto-commit a value from the profile. Resolves the value (using fuse for
   * select/radio with chooser fallback; boolean coercion for checkbox; default
   * value index otherwise), commits via `commitOnPage`, records the activity,
   * ends the session.
   *
   * Returns `false` only when the canonical key + field type combination
   * yields no usable value (e.g. select with `"No good options"` from the
   * chooser); the caller falls through to story_answer.
   */
  private async tryAutoCommitFromProfile(
    canonicalKey: string,
    profile: Profile,
    plan: FillPlan,
    settings: Settings,
    source: FillActivity['source']
  ): Promise<boolean> {
    if (!this.state) return false;
    const pv = profile.canonicalData[canonicalKey];
    if (!pv || pv.values.length === 0) return false;

    let chosen: string | null = null;
    if (plan.fieldType === 'select' || plan.fieldType === 'radio') {
      chosen = plan.options
        ? pickMatchingOption(pv.values, plan.options, settings.matching.fuseThreshold)
        : null;
      if (chosen == null && plan.options) {
        const chooserRes = await runChooser(settings, {
          fieldLabel: this.state.resolvedQuestion ?? '',
          canonicalKey,
          storedValues: pv.values,
          options: plan.options
        });
        if (!chooserRes.ok) {
          this.deps.broadcastPanel({
            t: 'error',
            message: `Chooser: ${chooserRes.message}`,
            retryable: chooserRes.retryable
          });
          return true; // an LLM error happened — don't fall through
        }
        chosen = chooserRes.chosen;
      }
      if (chosen == null) return false; // "No good options" → caller falls through
    } else if (plan.fieldType === 'checkbox') {
      chosen = pv.values[pv.defaultValueIndex] ?? pv.values[0];
    } else {
      chosen = pv.values[pv.defaultValueIndex] ?? pv.values[0];
    }

    // Other values for this key that the user could switch to in the panel.
    const alternativeValues = pv.values.filter((v) => v !== chosen);
    await this.commitAndRecord({
      label: this.state.resolvedQuestion ?? canonicalKey,
      canonicalKey,
      value: chosen,
      source,
      plan,
      alternativeValues
    });
    // Auto-commit complete — close the session and signal the panel.
    this.deps.broadcastPanel({ t: 'phase', phase: 'committed' });
    this.deps.broadcastPanel({ t: 'status', message: 'Filled from profile.' });
    this.state = null;
    return true;
  }

  private async runStoryAnswer(
    plan: FillPlan,
    label: string,
    settings: Settings,
    profile: Profile
  ): Promise<void> {
    if (!this.state) return;
    const app = await this.deps.loadActiveApplication();
    if (!app) {
      this.state.phase = 'story_setup';
      this.deps.broadcastPanel({ t: 'phase', phase: 'story_setup' });
      this.deps.broadcastPanel({
        t: 'status',
        message: 'Tell me about the application — company, role, optional notes.'
      });
      return;
    }
    await this.runStoryAnswerWithApp(plan, label, settings, profile, app);
  }

  private async setActiveApplicationFromPanel(
    companyName: string,
    role: string,
    userBlurb: string | null
  ): Promise<void> {
    if (!this.state || !this.state.plan || !this.state.resolvedQuestion) return;
    const settings = await this.deps.loadSettings();
    const profile = await this.deps.loadProfile();
    this.deps.broadcastPanel({ t: 'status', message: 'Deriving generic application key…' });

    const gk = await deriveGenericKey(settings, { companyName, role, userBlurb });
    if (!gk.ok) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Generic-key derivation failed: ${gk.message}`,
        retryable: gk.retryable
      });
      return;
    }
    let gkEmbedding: number[];
    try {
      gkEmbedding = await embed(gk.genericKey);
    } catch (e) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Embedding failed: ${(e as Error).message}`,
        retryable: true
      });
      return;
    }
    const app: ActiveApplication = {
      companyName,
      role,
      userBlurb,
      genericKey: gk.genericKey,
      genericKeyEmbedding: gkEmbedding,
      setAt: Date.now()
    };
    await this.deps.saveActiveApplication(app);
    await this.runStoryAnswerWithApp(this.state.plan, this.state.resolvedQuestion, settings, profile, app);
  }

  private async runStoryAnswerWithApp(
    plan: FillPlan,
    label: string,
    settings: Settings,
    profile: Profile,
    app: ActiveApplication
  ): Promise<void> {
    if (!this.state) return;
    this.state.phase = 'answering';
    this.deps.broadcastPanel({ t: 'phase', phase: 'answering' });
    this.deps.broadcastPanel({ t: 'status', message: 'Generating answer…' });

    const ml = await resolveMaxLength(settings, label, plan.fieldType, undefined);
    if (!ml.ok) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `answer_length: ${ml.message}`,
        retryable: ml.retryable
      });
      return;
    }
    this.state.maxLength = ml.maxLength;

    let qEmbedding: number[];
    try {
      qEmbedding = await embed(cleanLabel(label));
    } catch (e) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Embedding failed: ${(e as Error).message}`,
        retryable: true
      });
      return;
    }

    const stories = await this.deps.loadStories();
    const history = await this.deps.loadHistory();

    this.state.fullAnswer = '';
    logger.debug('story-answer', 'stream-start', { field_label: label, max_length: ml.maxLength, company: app.companyName, role: app.role });
    this.deps.broadcastPanel({ t: 'answer-start', maxLength: ml.maxLength });

    try {
      for await (const chunk of streamAnswer({
        settings,
        activeApplication: app,
        profile,
        stories,
        history,
        questionEmbedding: qEmbedding,
        fieldLabel: label,
        maxLength: ml.maxLength,
        signal: this.state.abort.signal
      })) {
        if (!this.state) return;
        if (chunk.kind === 'token') {
          this.state.fullAnswer += chunk.text;
          this.deps.broadcastPanel({ t: 'answer-token', text: chunk.text });
        } else if (chunk.kind === 'done') {
          this.state.fullAnswer = chunk.fullText || this.state.fullAnswer;
          logger.debug('story-answer', 'stream-done', { response: this.state.fullAnswer.slice(0, 500) });
          this.deps.broadcastPanel({ t: 'answer-done', fullText: this.state.fullAnswer });
          return;
        } else if (chunk.kind === 'error') {
          this.deps.broadcastPanel({
            t: 'error',
            message: chunk.message,
            retryable: chunk.retryable
          });
          return;
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      this.deps.broadcastPanel({
        t: 'error',
        message: `Stream failed: ${(e as Error).message}`,
        retryable: true
      });
    }
  }

  private async handleConfirmStoryAnswer(valueOverride?: string): Promise<void> {
    if (!this.state || !this.state.plan || !this.state.resolvedQuestion) return;
    if (this.state.phase !== 'answering') return;

    const value = valueOverride ?? this.state.fullAnswer;
    if (typeof valueOverride === 'string' && valueOverride !== this.state.fullAnswer) {
      this.state.draftEditedByUser = true;
    }

    await this.commitAndRecord({
      label: this.state.resolvedQuestion,
      canonicalKey: null,
      value,
      source: 'story_answer',
      plan: this.state.plan
    });

    // History dedup + insert (story_answer only).
    await this.ingestHistoryAndMaybeDiscover(value);
    this.state.phase = 'committed';
    this.deps.broadcastPanel({ t: 'phase', phase: 'committed' });
    this.deps.broadcastPanel({ t: 'status', message: 'Saved.' });
    this.state = null;
  }

  private async ingestHistoryAndMaybeDiscover(committedAnswer: string): Promise<void> {
    if (!this.state || !this.state.resolvedQuestion) return;
    const settings = await this.deps.loadSettings();
    const app = await this.deps.loadActiveApplication();
    if (!app) return;
    const cleaned = cleanLabel(this.state.resolvedQuestion);
    let qEmb: number[];
    try {
      qEmb = await embed(cleaned);
    } catch {
      logger.warn('history', 'failed to embed question on commit; skipping ingest');
      return;
    }
    const history = await this.deps.loadHistory();
    const result = ingest({
      history,
      questionCleaned: cleaned,
      questionEmbedding: qEmb,
      answer: committedAnswer,
      activeApplication: app,
      settings
    });
    await this.deps.saveHistory(result.nextHistory);

    if (result.kind === 'merged') {
      this.state.undoSnapshot = result.undoSnapshot;
      this.deps.broadcastPanel({
        t: 'dedup-merge',
        olderEntryId: result.mergedInto.id,
        olderQuestion: result.undoSnapshot.question
      });
    }

    if (this.state.draftEditedByUser) {
      const stories = await this.deps.loadStories();
      void runStoryDiscovery(settings, {
        activeApplication: app,
        fieldLabel: this.state!.resolvedQuestion!,
        answer: committedAnswer,
        stories
      })
        .then((res) => {
          if ('error' in res) {
            logger.warn('story-discovery', 'failed', { error: res.error });
            return;
          }
          if (res.propose) {
            this.deps.broadcastPanel({
              t: 'story-discovered',
              content: res.content,
              keywords: res.keywords
            });
          }
        })
        .catch((e) => logger.warn('story-discovery', 'threw', { error: String(e) }));
    }
  }

  private async handleProfileUpdateConfirm(
    canonicalKey: string,
    value: string,
    sensitive: boolean
  ): Promise<void> {
    if (!this.state || !this.state.plan) return;
    const profile = await this.deps.loadProfile();
    const cleaned = cleanLabel(canonicalKey);
    const next = upsertProfile(profile, cleaned, value, sensitive);
    await this.deps.saveProfile(next);

    await this.commitAndRecord({
      label: this.state.resolvedQuestion ?? cleaned,
      canonicalKey: cleaned,
      value,
      source: 'profile_update',
      plan: this.state.plan
    });
    this.state.phase = 'committed';
    this.deps.broadcastPanel({ t: 'phase', phase: 'committed' });
    this.deps.broadcastPanel({ t: 'status', message: 'Saved to profile and filled.' });
    this.state = null;
  }

  private async handleUndoMerge(): Promise<void> {
    if (!this.state?.undoSnapshot) return;
    const history = await this.deps.loadHistory();
    const reverted = applyUndo(history, this.state.undoSnapshot);
    await this.deps.saveHistory(reverted);
    this.state.undoSnapshot = null;
    this.deps.broadcastPanel({ t: 'status', message: 'Reverted to the older history entry.' });
  }

  private async handleConfirmStory(content: string, keywords: string[]): Promise<void> {
    const stories = await this.deps.loadStories();
    const now = Date.now();
    const next: Story[] = [
      ...stories,
      { id: uuid(), content, keywords, createdAt: now, updatedAt: now }
    ];
    await this.deps.saveStories(next);
    this.deps.broadcastPanel({ t: 'status', message: 'Story saved.' });
  }

  // ───────────────────────── Alt+S add-to-profile ─────────────────────────

  private async runAddToProfile(): Promise<void> {
    if (!this.state || !this.state.plan || !this.state.resolvedQuestion) return;
    const plan = this.state.plan;
    if (!plan.currentValue.trim()) {
      this.deps.broadcastPanel({
        t: 'status',
        message: 'Nothing to save — the field is empty.'
      });
      this.endSession();
      return;
    }
    const cleaned = cleanLabel(this.state.resolvedQuestion);
    const longLabel = cleaned.length > 50;
    const longValue = plan.currentValue.length > 100;
    if (longLabel || longValue) {
      this.deps.broadcastPanel({
        t: 'add-to-profile-confirm',
        label: cleaned,
        value: plan.currentValue
      });
      return;
    }
    await this.handleAddToProfileSubmit(cleaned, plan.currentValue, false);
  }

  private async handleAddToProfileSubmit(
    canonicalKeyRaw: string,
    value: string,
    sensitive: boolean
  ): Promise<void> {
    if (!this.state) return;
    const cleaned = cleanLabel(canonicalKeyRaw);
    const profileBefore = await this.deps.loadProfile();
    const settings = await this.deps.loadSettings();

    const hit = matchAlias(cleaned, profileBefore, settings.matching.fuseThreshold);
    let next: Profile;
    let writeKey: string;
    if (hit) {
      writeKey = hit.canonicalKey;
      const pv = profileBefore.canonicalData[writeKey];
      const newValues = appendValueDedup(pv.values, value);
      next = {
        ...profileBefore,
        canonicalData: {
          ...profileBefore.canonicalData,
          [writeKey]: { ...pv, values: newValues, updatedAt: Date.now() }
        }
      };
      if (sensitive && !next.sensitiveKeys.includes(writeKey)) {
        next.sensitiveKeys = [...next.sensitiveKeys, writeKey];
      }
    } else {
      writeKey = cleaned;
      next = upsertProfile(profileBefore, writeKey, value, sensitive);
    }
    await this.deps.saveProfile(next);

    // Record the save activity with a snapshot of the pre-save profile so
    // the panel's delete button can atomically undo the write.
    const entry: SaveActivity = {
      kind: 'save',
      id: uuid(),
      at: Date.now(),
      label: writeKey,
      value,
      previousProfile: profileBefore
    };
    this.deps.pushActivity(entry);
    this.deps.broadcastPanel({ t: 'recent-activity-add', entry });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Saved to profile under "${writeKey}".`
    });
    this.endSession();
  }

  // ───────────────────────── activity revert/delete (panel-driven) ─────────────────────────

  private async handleRevertFill(id: string): Promise<void> {
    // The panel's recent-fills list is mirrored from the SW's ring buffer.
    // To revert, we need the FillActivity entry's snapshot — but we don't
    // hold it here directly; the SW caller looks it up from the ring buffer
    // and feeds us the snapshot via a private hook.
    //
    // Implementation: the SW (in index.ts) wraps this method to look up
    // the entry from its ring buffer first. To keep the orchestrator free
    // of buffer ownership, we just expose a public helper the SW calls.
    void id; // see public revertFillEntry / deleteSaveEntry methods below.
  }

  private async handleDeleteSave(id: string): Promise<void> {
    void id;
  }

  /**
   * Public helper called by the SW when the panel posts `revert-fill`. The
   * SW looks up the activity from its buffer (the FillSession does not own
   * that buffer) and supplies the entry directly.
   */
  async revertFillEntry(entry: FillActivity): Promise<void> {
    try {
      const r = await this.deps.commitOnPage(
        entry.tabId,
        entry.frameId,
        entry.elementRef,
        entry.fieldType,
        entry.previousValue
      );
      if (!r.ok) {
        this.deps.broadcastPanel({
          t: 'error',
          message: `Couldn't revert "${entry.label}": ${r.message ?? r.kind ?? 'commit failed'}.`,
          retryable: false
        });
        return;
      }
      this.deps.removeActivity(entry.id);
      this.deps.broadcastPanel({ t: 'recent-activity-remove', id: entry.id });
      this.deps.broadcastPanel({
        t: 'status',
        message: `Reverted "${entry.label}" to its previous value.`
      });
    } catch (e) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Couldn't revert "${entry.label}": ${(e as Error).message}`,
        retryable: false
      });
    }
  }

  async deleteSaveEntry(entry: SaveActivity): Promise<void> {
    try {
      await this.deps.saveProfile(entry.previousProfile);
      this.deps.removeActivity(entry.id);
      this.deps.broadcastPanel({ t: 'recent-activity-remove', id: entry.id });
      this.deps.broadcastPanel({
        t: 'status',
        message: `Deleted save "${entry.label}" from your profile.`
      });
    } catch (e) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Couldn't delete "${entry.label}": ${(e as Error).message}`,
        retryable: false
      });
    }
  }

  // ───────────────────────── shared commit helper ─────────────────────────

  /**
   * Commit on the page + record a fill activity + signal the panel. Single
   * code path for profile-direct, profile_existing_value, profile_update,
   * and story_answer.
   */
  private async commitAndRecord(args: {
    label: string;
    canonicalKey: string | null;
    value: string;
    source: FillActivity['source'];
    plan: FillPlan;
    alternativeValues?: string[];
  }): Promise<void> {
    const { label, canonicalKey, value, source, plan, alternativeValues } = args;
    const previousValue = plan.currentValue;
    let supportedField = plan.fieldType !== 'unknown';
    let committed: { ok: boolean; kind?: string; message?: string } = { ok: false };
    if (supportedField) {
      committed = await this.deps.commitOnPage(
        plan.tabId,
        plan.frameId,
        plan.elementRef,
        plan.fieldType,
        value
      );
      if (!committed.ok) {
        if (committed.kind === 'detached') {
          this.deps.broadcastPanel({
            t: 'error',
            message: 'The field disappeared from the page before we could fill it.',
            retryable: false
          });
          this.endSession();
          return;
        }
        supportedField = false;
      }
    }
    if (!supportedField) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `This field type isn't supported yet. Copy the value from the recent fills below.`,
        retryable: false
      });
    }
    const entry: FillActivity = {
      kind: 'fill',
      id: uuid(),
      at: Date.now(),
      label,
      canonicalKey,
      value,
      source,
      alternativeValues: alternativeValues ?? [],
      tabId: plan.tabId,
      frameId: plan.frameId,
      elementRef: plan.elementRef,
      previousValue,
      fieldType: plan.fieldType
    };
    this.deps.pushActivity(entry);
    this.deps.broadcastPanel({ t: 'recent-activity-add', entry });
    this.broadcastClose();
  }
}

// ───────────────────────── helpers ─────────────────────────

function upsertProfile(
  profile: Profile,
  canonicalKey: string,
  value: string,
  sensitive: boolean
): Profile {
  const existing = profile.canonicalData[canonicalKey];
  const now = Date.now();
  const aliasMap = { ...profile.aliasMap, [canonicalKey]: canonicalKey };
  const canonicalData = { ...profile.canonicalData };
  if (existing) {
    canonicalData[canonicalKey] = {
      ...existing,
      values: appendValueDedup(existing.values, value),
      updatedAt: now
    };
  } else {
    canonicalData[canonicalKey] = {
      id: canonicalKey,
      values: [value],
      defaultValueIndex: 0,
      updatedAt: now
    };
  }
  let sensitiveKeys = profile.sensitiveKeys;
  if (sensitive || SENSITIVE_CANONICAL_KEYS.includes(canonicalKey)) {
    if (!sensitiveKeys.includes(canonicalKey)) sensitiveKeys = [...sensitiveKeys, canonicalKey];
  }
  return { aliasMap, canonicalData, sensitiveKeys };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

void z; // reserved for inline schema use; suppress unused-import lint
