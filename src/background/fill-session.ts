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
  GroupRecord,
  GroupTemplate,
  Profile,
  Settings,
  Story
} from '$shared/types';
import { DEFAULT_SETTINGS, SENSITIVE_CANONICAL_KEYS } from '$shared/constants';
import { logger } from './logger';
import { type ContentPort, type PortEvent } from './messaging';
import {
  appendValueDedup,
  matchAlias,
  matchTargets,
  pickMatchingOption,
  type MatchCandidate,
  type MatchTarget
} from './matcher';
import { classifyField, type ClassifierResult } from './classifier';
import { runChooser, resolveMaxLength, runStoryDiscovery, streamAnswer } from './llm/answer';
import { deriveGenericKey } from './llm/generic-key';
import { judgeAlias } from './llm/alias-judge';
import { embed } from './rag/embeddings';
import { ingest, applyUndo } from './history';

/** Sticky group-template context, persisted in chrome.storage.session.
 *  Cleared when a non-template fill happens or when the user explicitly
 *  closes the navigator AND no further template-match has set it. */
export type RecordContext = {
  templateId: string;
  recordId: string;
  setAt: number;
};

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
  // Set when the fill resolved through a group template — lets FillHistory
  // surface "Work Experience #2 / job title" instead of just the bare key.
  templateContext?: {
    templateId: string;
    templateName: string;
    recordId: string;
    /** 1-based index in the template's records list at fill time. */
    recordIndex: number;
    key: string;
  };
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
  // Populated when the save targeted a group-template record. The Alt+S undo
  // already snapshots the full profile so this is purely cosmetic — lets the
  // SaveHistory card show "Work Experience #2 / job title".
  templateContext?: {
    templateId: string;
    templateName: string;
    recordId: string;
    recordIndex: number;
    key: string;
  };
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
  /** Replace an existing entry in place (used by the navigator when the user
   *  switches records — the same form field is re-committed under the same id). */
  updateActivity: (entry: RecentActivity) => void;
  /** Sticky template+record selection across separate Alt+A invocations. */
  loadRecordContext: () => Promise<RecordContext | null>;
  saveRecordContext: (ctx: RecordContext | null) => Promise<void>;
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
  | 'cancelled'
  | 'navigating';

/**
 * Fallback used until the user's settings have been loaded for the current
 * session — see `start()` / `startWithManualHighlight()` for the async load
 * that promotes the per-session ceiling to
 * `Settings.session.inactivityMinutes`.
 *
 * The FillSession auto-aborts after this many milliseconds without any
 * panel/content event. The timer is reset on every inbound port event (panel
 * button, manual-highlight selection, content navigator key, panel keepalive
 * heartbeat, …) so user activity holds the session open indefinitely.
 */
const DEFAULT_SESSION_INACTIVITY_MS = 15 * 60 * 1000;

type State = {
  kind: FillKind;
  phase: Phase;
  abort: AbortController;
  /** ReturnType<typeof setTimeout> portably typed across DOM/Node. */
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  /** Resolved at session start from `Settings.session.inactivityMinutes`,
   *  with `DEFAULT_SESSION_INACTIVITY_MS` as the fallback while the async
   *  settings load is still in flight. */
  inactivityMs: number;

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

  // Active group-template navigator (only set when phase === 'navigating').
  navigator: NavigatorState | null;
};

type NavigatorState = {
  /** Snapshot of the matched template at fill time. We snapshot so that
   *  profile edits made mid-navigation don't shift the records out from under
   *  the user; if they want fresh data, they can reopen the navigator with a
   *  new Alt+A. */
  template: GroupTemplate;
  currentRecordId: string;
  matchedKey: string;
  /** id of the FillActivity entry to update in place when the user switches
   *  records via Alt+] / Alt+[ / panel buttons. */
  fillEntryId: string;
};

export class FillSessionImpl {
  private state: State | null = null;
  /** Cached detector settings, updated asynchronously at session start.
   *  Falls back to DEFAULT_SETTINGS.detector until the first load completes. */
  private detectorSettings: Settings['detector'] = DEFAULT_SETTINGS.detector;

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
      inactivityTimer: null,
      inactivityMs: DEFAULT_SESSION_INACTIVITY_MS,
      plan: null,
      resolvedQuestion: null,
      electedTabId: tabId,
      electedFrameId: null,
      pendingUpdateKey: null,
      fullAnswer: '',
      draftEditedByUser: false,
      maxLength: null,
      undoSnapshot: null,
      forceManualHighlight: false,
      navigator: null
    };
    this.deps.broadcastPanel({ t: 'phase', phase: 'detecting' });
    this.deps.broadcastPanel({ t: 'status', message: 'Looking for the focused field…' });
    for (const p of ports) p.post({ t: 'run-detective', detector: this.detectorSettings });
    this.touchActivity();
    void this.loadInactivityFromSettings();

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
      inactivityTimer: null,
      inactivityMs: DEFAULT_SESSION_INACTIVITY_MS,
      plan: null,
      resolvedQuestion: null,
      electedTabId: tabId,
      electedFrameId: null,
      pendingUpdateKey: null,
      fullAnswer: '',
      draftEditedByUser: false,
      maxLength: null,
      undoSnapshot: null,
      forceManualHighlight: true,
      navigator: null
    };
    this.deps.broadcastPanel({ t: 'phase', phase: 'detecting' });
    this.deps.broadcastPanel({ t: 'status', message: 'Connecting to the field…' });
    for (const p of ports) p.post({ t: 'run-detective', detector: this.detectorSettings });
    this.touchActivity();
    void this.loadInactivityFromSettings();

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
    if (this.state.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
    this.broadcastClose();
    this.deps.broadcastPanel({ t: 'phase', phase: 'cancelled' });
    this.deps.broadcastPanel({ t: 'close' });
    this.deps.broadcastPanel({ t: 'status', message: 'Cancelled.' });
    this.state = null;
  }

  /** Reset the session-inactivity timer. Called on every inbound port event
   *  (and on the panel-driven `keepalive` heartbeat). Fires `abort()` if no
   *  activity arrives for `state.inactivityMs`. */
  private touchActivity(): void {
    if (!this.state) return;
    if (this.state.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
    this.state.inactivityTimer = setTimeout(() => {
      if (!this.state) return;
      logger.info('fill-session', 'inactivity timeout — aborting session');
      this.deps.broadcastPanel({
        t: 'status',
        message: 'Session timed out due to inactivity.'
      });
      this.abort();
    }, this.state.inactivityMs);
  }

  /** Pull `Settings.session.inactivityMinutes` and promote the running
   *  session's ceiling. Called fire-and-forget right after a session starts;
   *  errors (e.g. vault locked) are swallowed and the default stays in
   *  effect. */
  private async loadInactivityFromSettings(): Promise<void> {
    try {
      const s = await this.deps.loadSettings();
      // Cache detector settings for the next session's run-detective broadcast.
      if (s.detector) this.detectorSettings = s.detector;
      const minutes = s.session?.inactivityMinutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return;
      if (!this.state) return;
      this.state.inactivityMs = Math.round(minutes * 60_000);
      // Re-arm the timer with the freshly-loaded ceiling.
      this.touchActivity();
    } catch (e) {
      logger.warn('fill-session', 'failed to load inactivity setting', { error: String(e) });
    }
  }

  /** Receive a port event from any content script in any frame. */
  async onContentEvent(ev: PortEvent, tabId: number, frameId: number): Promise<void> {
    if (!this.state) return;
    if (tabId !== this.state.electedTabId) return; // wrong tab — ignore
    this.touchActivity();

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
      case 'navigator-prev':
        // Content script forwards Alt+, when navigatorActive is set.
        // Treat identically to the panel button — no frameId guard needed
        // because only the elected frame ever receives navigator-active:true.
        await this.navigateRecord(-1);
        return;
      case 'navigator-next':
        // Content script forwards Alt+. when navigatorActive is set.
        await this.navigateRecord(+1);
        return;
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
      if (ev.t === 'keepalive') {
        // No-op when no session — the panel sends these on a timer.
        return;
      }
      // `confirm-story` is stateless: story discovery runs asynchronously
      // after the fill session ends, so by the time the user clicks "Save
      // story" in the panel, this.state is null. Don't drop it.
      if (
        ev.t !== 'revert-fill' &&
        ev.t !== 'delete-save' &&
        ev.t !== 'undo-merge' &&
        ev.t !== 'confirm-story'
      ) {
        return;
      }
    } else {
      this.touchActivity();
    }
    switch (ev.t) {
      case 'keepalive':
        // The touchActivity() above is the entire effect; nothing else to do.
        return;
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
      case 'navigator-next':
        await this.navigateRecord(+1);
        return;
      case 'navigator-prev':
        await this.navigateRecord(-1);
        return;
      case 'navigator-jump':
        await this.navigateToRecord(ev.recordId);
        return;
      case 'navigator-close':
        this.closeNavigator();
        return;
      default:
        return;
    }
  }

  // ───────────────────────── public helpers ─────────────────────────

  /** True when a navigator is currently active. Used by the SW to route the
   *  Alt+] / Alt+[ chrome.commands. */
  isNavigating(): boolean {
    return this.state?.phase === 'navigating' && this.state?.navigator != null;
  }

  /** A snapshot of the current navigator state — sent to a panel that
   *  reconnects mid-navigation so the navigator card remounts seamlessly. */
  getNavigatorSnapshot(): NavigatorState | null {
    if (this.state?.phase !== 'navigating') return null;
    return this.state.navigator;
  }

  // ───────────────────────── workflow steps ─────────────────────────

  private endSession(): void {
    if (this.state?.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
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

    // §4.2 direct match — extended to span flat keys + group templates.
    this.state.phase = 'matching';
    this.deps.broadcastPanel({ t: 'phase', phase: 'matching' });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Checking your profile for "${label}"…`
    });

    const candidates = matchTargets(label, profile, settings.matching.fuseThreshold);

    // Single unambiguous candidate → resolve directly without involving the LLM.
    if (candidates.length === 1) {
      const consumed = await this.applyResolvedTarget(
        candidates[0].target,
        'matcher',
        profile,
        plan,
        settings
      );
      if (consumed) return;
    }

    // Zero or multiple candidates → §4.3 classifier with the candidate list
    // (when present) so the LLM disambiguates instead of guessing fresh.
    this.state.phase = 'classifying';
    this.deps.broadcastPanel({ t: 'phase', phase: 'classifying' });
    this.deps.broadcastPanel({ t: 'status', message: 'Classifying field with the LLM…' });

    const cl = await classifyField({
      fieldLabel: label,
      fieldType: plan.fieldType,
      options: plan.options,
      profile,
      settings,
      ancestorHtml: plan.ancestorHtml ?? null,
      ancestorInnerText: plan.ancestorInnerText ?? null,
      additionalAncestorContexts: plan.additionalAncestorContexts ?? [],
      elementDescriptor: plan.elementDescriptor ?? '',
      matchCandidates: candidates
    });
    if (!cl.ok) {
      if (cl.kind === 'context-exhausted') {
        // The LLM kept requesting wider context until there was none left.
        // Tell the user and direct them to the manual highlight fallback.
        this.deps.broadcastPanel({
          t: 'status',
          message:
            "Couldn't determine what this field is asking, even after examining wider context. " +
            'If you still want to fill it, press Alt+Shift+A to manually highlight the question text.'
        });
        this.endSession();
        return;
      }
      this.deps.broadcastPanel({
        t: 'error',
        message: `Classifier: ${cl.message}`,
        retryable: cl.retryable
      });
      return;
    }
    const result: ClassifierResult = cl.result;
    if (result.category === 'profile_existing_value') {
      const consumed = await this.applyResolvedTarget(
        result.target,
        'classifier',
        profile,
        plan,
        settings
      );
      if (consumed) return;
      // Fell through (e.g. select with no good options) → story_answer fallback.
      // Falling through to story_answer also clears any sticky template
      // context — the user has effectively left the template flow.
      await this.deps.saveRecordContext(null);
      await this.runStoryAnswer(plan, label, settings, profile);
      return;
    }
    if (result.category === 'profile_update') {
      // profile_update is a flat-key suggestion, so any existing template
      // context is no longer relevant — clear it.
      await this.deps.saveRecordContext(null);
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
    await this.deps.saveRecordContext(null);
    await this.runStoryAnswer(plan, label, settings, profile);
  }

  /**
   * Route a resolved match target (flat or template) to the right auto-commit
   * path. Returns true when the session has been consumed (i.e. don't fall
   * through to the next step). `origin` distinguishes which layer produced
   * the target so the FillActivity source tag is accurate.
   */
  private async applyResolvedTarget(
    target: MatchTarget,
    origin: 'matcher' | 'classifier',
    profile: Profile,
    plan: FillPlan,
    settings: Settings
  ): Promise<boolean> {
    if (!this.state) return false;
    const labelForAlias = this.state.resolvedQuestion ?? '';
    let consumed: boolean;
    if (target.kind === 'flat') {
      const source: FillActivity['source'] =
        origin === 'matcher' ? 'profile' : 'profile_existing_value';
      // Flat-key fills clear any sticky template context — the user has moved
      // out of the template (per the design: sticky persists until a non-
      // template fill happens).
      await this.deps.saveRecordContext(null);
      consumed = await this.tryAutoCommitFromProfile(
        target.canonicalKey,
        profile,
        plan,
        settings,
        source
      );
    } else {
      consumed = await this.tryAutoCommitFromTemplate(target, profile, plan, settings, origin);
    }
    // Classifier-resolved matches sometimes pulled the canonical via surrounding
    // HTML rather than a true label↔key alias. Ask a narrow LLM judge whether
    // the observed label is a genuine alias and, if so, persist it for future
    // direct-matching. Fire-and-forget — never blocks the commit.
    if (consumed && origin === 'classifier' && labelForAlias.trim()) {
      void this.maybeRecordAlias(target, labelForAlias, plan.ancestorHtml ?? null, settings);
    }
    return consumed;
  }

  /**
   * Run the alias-judge LLM and, on `isAlias: true`, persist the new alias
   * back to the profile. Tolerates concurrent profile edits — re-loads the
   * profile before writing. Errors are logged but never surfaced to the user
   * (this is a background optimization, not a user-visible action).
   */
  private async maybeRecordAlias(
    target: MatchTarget,
    rawLabel: string,
    ancestorHtml: string | null,
    settings: Settings
  ): Promise<void> {
    try {
      const cleanedLabel = cleanLabel(rawLabel);
      if (!cleanedLabel) return;

      // Identity short-circuit: if the cleaned label IS the canonical key,
      // nothing to add (aliasMap already carries (K → K)).
      if (target.kind === 'flat' && cleanedLabel === target.canonicalKey) return;
      if (target.kind === 'template' && cleanedLabel === target.key) return;

      // Already-known short-circuit: avoid the LLM call when the alias is
      // already mapped to the same target.
      const probe = await this.deps.loadProfile();
      if (target.kind === 'flat') {
        if (probe.aliasMap[cleanedLabel] === target.canonicalKey) return;
      } else {
        const tpl = (probe.groupTemplates ?? []).find((t) => t.id === target.templateId);
        const keyDef = tpl?.keys.find((k) => k.key === target.key);
        if (keyDef && keyDef.aliases.some((a) => cleanLabel(a) === cleanedLabel)) return;
      }

      const canonicalForJudge =
        target.kind === 'flat' ? target.canonicalKey : `${target.templateName} / ${target.key}`;
      const r = await judgeAlias(settings, {
        canonicalKey: canonicalForJudge,
        fieldLabel: rawLabel,
        ancestorHtml
      });
      if (!r.ok) {
        logger.warn('alias-judge', 'failed', { error: r.message });
        return;
      }
      if (!r.isAlias) return;

      // Re-load to merge against the freshest profile snapshot.
      const profile = await this.deps.loadProfile();
      let next: Profile;
      if (target.kind === 'flat') {
        if (!(target.canonicalKey in profile.canonicalData)) return;
        if (profile.aliasMap[cleanedLabel] === target.canonicalKey) return;
        next = {
          ...profile,
          aliasMap: { ...profile.aliasMap, [cleanedLabel]: target.canonicalKey }
        };
      } else {
        const tplIdx = (profile.groupTemplates ?? []).findIndex((t) => t.id === target.templateId);
        if (tplIdx < 0) return;
        const cloned = structuredClone(profile);
        const tpl = cloned.groupTemplates[tplIdx];
        const keyDef = tpl.keys.find((k) => k.key === target.key);
        if (!keyDef) return;
        if (keyDef.aliases.some((a) => cleanLabel(a) === cleanedLabel)) return;
        keyDef.aliases = [...keyDef.aliases, cleanedLabel];
        tpl.updatedAt = Date.now();
        next = cloned;
      }
      await this.deps.saveProfile(next);
      const canonicalDisplay =
        target.kind === 'flat' ? target.canonicalKey : `${target.templateName} / ${target.key}`;
      logger.info('alias-judge', 'alias recorded', {
        target: canonicalDisplay,
        alias: cleanedLabel
      });
      // Surface a transient toast in the side panel with a "Delete alias"
      // button — see §4.3 (alias-judge follow-up). The panel auto-dismisses
      // after a few seconds; the user can revert if the judge got it wrong.
      this.deps.broadcastPanel({
        t: 'alias-added',
        id: uuid(),
        alias: cleanedLabel,
        canonicalDisplay,
        target
      });
    } catch (e) {
      logger.warn('alias-judge', 'threw', { error: String(e) });
    }
  }

  /**
   * Public helper called by the SW when the panel posts `delete-alias` (the
   * user clicked the toast's "Delete alias" button). Removes the alias from
   * the freshest profile snapshot. Tolerates the alias having already been
   * removed; logs but never surfaces errors.
   */
  async deleteAliasEntry(args: {
    id: string;
    alias: string;
    target: MatchTarget;
  }): Promise<void> {
    try {
      const cleaned = cleanLabel(args.alias);
      if (!cleaned) return;
      const profile = await this.deps.loadProfile();
      let next: Profile | null = null;
      if (args.target.kind === 'flat') {
        if (profile.aliasMap[cleaned] !== args.target.canonicalKey) return;
        const aliasMap = { ...profile.aliasMap };
        delete aliasMap[cleaned];
        next = { ...profile, aliasMap };
      } else {
        const tplIdx = (profile.groupTemplates ?? []).findIndex(
          (t) => t.id === (args.target as Extract<MatchTarget, { kind: 'template' }>).templateId
        );
        if (tplIdx < 0) return;
        const cloned = structuredClone(profile);
        const tpl = cloned.groupTemplates[tplIdx];
        const targetKey = (args.target as Extract<MatchTarget, { kind: 'template' }>).key;
        const keyDef = tpl.keys.find((k) => k.key === targetKey);
        if (!keyDef) return;
        const before = keyDef.aliases.length;
        keyDef.aliases = keyDef.aliases.filter((a) => cleanLabel(a) !== cleaned);
        if (keyDef.aliases.length === before) return;
        tpl.updatedAt = Date.now();
        next = cloned;
      }
      if (next) {
        await this.deps.saveProfile(next);
        logger.info('alias-judge', 'alias deleted by user', {
          target:
            args.target.kind === 'flat'
              ? args.target.canonicalKey
              : `${args.target.templateName}/${args.target.key}`,
          alias: cleaned
        });
      }
      this.deps.broadcastPanel({ t: 'alias-toast-remove', id: args.id });
      this.deps.broadcastPanel({
        t: 'status',
        message: `Removed alias "${cleaned}".`
      });
    } catch (e) {
      logger.warn('alias-judge', 'delete failed', { error: String(e) });
    }
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
    if (this.state?.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
    this.state = null;
    return true;
  }

  /**
   * Auto-commit a value from a group-template record. Picks the record per
   * the sticky-context rule (first template fill = default record; subsequent
   * fills inside the same template = whatever was last shown). After commit,
   * enters `navigating` phase so the user can switch records via Alt+] /
   * Alt+[ or the panel buttons.
   *
   * Returns false if the template / record / value combination yields no
   * usable value (template has no records, key missing, select with no
   * matching option) so the caller can fall through to story_answer.
   */
  private async tryAutoCommitFromTemplate(
    target: Extract<MatchTarget, { kind: 'template' }>,
    profile: Profile,
    plan: FillPlan,
    settings: Settings,
    origin: 'matcher' | 'classifier'
  ): Promise<boolean> {
    if (!this.state) return false;
    const tpl = (profile.groupTemplates ?? []).find((t) => t.id === target.templateId);
    if (!tpl) return false;
    if (tpl.records.length === 0) return false;

    // Sticky-context rule.
    const sticky = await this.deps.loadRecordContext();
    let recordId: string | null = null;
    if (sticky && sticky.templateId === tpl.id) {
      // Same template as last template fill → reuse last record (if it still exists).
      if (tpl.records.some((r) => r.id === sticky.recordId)) {
        recordId = sticky.recordId;
      }
    }
    if (recordId == null) {
      // First fill into this template (or sticky pointed at a deleted record).
      // Fall back to the configured default; if that's missing too, take the
      // first record.
      if (tpl.defaultRecordId && tpl.records.some((r) => r.id === tpl.defaultRecordId)) {
        recordId = tpl.defaultRecordId;
      } else {
        recordId = tpl.records[0].id;
      }
    }

    const record = tpl.records.find((r) => r.id === recordId);
    if (!record) return false;

    // Resolve the value for the matched key, coerced for the field type.
    const resolved = resolveTemplateValueForField(tpl, record, target.key, plan, settings);
    if (resolved == null) return false;

    const recordIndex = tpl.records.findIndex((r) => r.id === recordId) + 1;
    const fillEntry = await this.commitTemplateValue({
      template: tpl,
      record,
      matchedKey: target.key,
      value: resolved,
      plan,
      origin
    });
    if (!fillEntry) return false;

    // Persist sticky context for cross-Alt+A continuity.
    await this.deps.saveRecordContext({
      templateId: tpl.id,
      recordId: record.id,
      setAt: Date.now()
    });

    // Enter navigating phase. Snapshot the template so subsequent
    // navigateRecord calls iterate over a stable list even if the user edits
    // the profile in another tab mid-session.
    this.state.phase = 'navigating';
    this.state.navigator = {
      template: structuredClone(tpl),
      currentRecordId: record.id,
      matchedKey: target.key,
      fillEntryId: fillEntry.id
    };

    // Tell the elected content script to start intercepting Alt+, / Alt+.
    // We use getContentPort (targeted) rather than getAllContentPorts
    // (broadcast) so only the frame that owns the filled element intercepts
    // the keys — other frames on the same page are unaffected.
    if (this.state.electedFrameId != null) {
      this.deps.getContentPort(this.state.electedTabId, this.state.electedFrameId)
        ?.post({
          t: 'navigator-active',
          active: true,
          prevKey: settings.navigator.prevKey,
          nextKey: settings.navigator.nextKey
        });
    }

    this.deps.broadcastPanel({ t: 'phase', phase: 'navigating' });
    this.deps.broadcastPanel({
      t: 'navigator-open',
      template: this.state.navigator.template,
      currentRecordId: record.id,
      matchedKey: target.key,
      fillEntryId: fillEntry.id
    });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Filled from "${tpl.name}" record ${recordIndex}/${tpl.records.length}.`
    });
    return true;
  }

  /**
   * Commit a template-derived value to the page and push a FillActivity entry
   * with templateContext. Shared between the initial auto-commit and the
   * navigator's record-switching path.
   */
  private async commitTemplateValue(args: {
    template: GroupTemplate;
    record: GroupRecord;
    matchedKey: string;
    value: string;
    plan: FillPlan;
    origin: 'matcher' | 'classifier';
  }): Promise<FillActivity | null> {
    const { template, record, matchedKey, value, plan, origin } = args;
    const recordIndex = template.records.findIndex((r) => r.id === record.id) + 1;
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
          return null;
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
      label: this.state?.resolvedQuestion ?? matchedKey,
      canonicalKey: matchedKey,
      value,
      source: origin === 'matcher' ? 'profile' : 'profile_existing_value',
      alternativeValues: [],
      tabId: plan.tabId,
      frameId: plan.frameId,
      elementRef: plan.elementRef,
      previousValue,
      fieldType: plan.fieldType,
      templateContext: {
        templateId: template.id,
        templateName: template.name,
        recordId: record.id,
        recordIndex,
        key: matchedKey
      }
    };
    this.deps.pushActivity(entry);
    this.deps.broadcastPanel({ t: 'recent-activity-add', entry });
    return entry;
  }

  // ───────────────────────── Navigator (Alt+] / Alt+[ / panel buttons) ─────────────────────────

  private async navigateRecord(delta: 1 | -1): Promise<void> {
    if (!this.state || this.state.phase !== 'navigating' || !this.state.navigator) return;
    const nav = this.state.navigator;
    const records = nav.template.records;
    if (records.length <= 1) {
      this.deps.broadcastPanel({
        t: 'status',
        message: 'This template has only one record — nothing to switch to.'
      });
      return;
    }
    const idx = records.findIndex((r) => r.id === nav.currentRecordId);
    if (idx < 0) return;
    const nextIdx = (idx + delta + records.length) % records.length;
    await this.navigateToRecord(records[nextIdx].id);
  }

  private async navigateToRecord(recordId: string): Promise<void> {
    if (!this.state || this.state.phase !== 'navigating' || !this.state.navigator) return;
    const nav = this.state.navigator;
    const tpl = nav.template;
    const record = tpl.records.find((r) => r.id === recordId);
    if (!record || record.id === nav.currentRecordId) return;
    if (!this.state.plan) return;

    const settings = await this.deps.loadSettings();
    const resolved = resolveTemplateValueForField(tpl, record, nav.matchedKey, this.state.plan, settings);
    if (resolved == null) {
      this.deps.broadcastPanel({
        t: 'status',
        message: `Record has no value for "${nav.matchedKey}" — clearing the field.`
      });
    }
    const valueToCommit = resolved ?? '';
    const r = await this.deps.commitOnPage(
      this.state.plan.tabId,
      this.state.plan.frameId,
      this.state.plan.elementRef,
      this.state.plan.fieldType,
      valueToCommit
    );
    if (!r.ok) {
      this.deps.broadcastPanel({
        t: 'error',
        message: `Couldn't switch records: ${r.message ?? r.kind ?? 'commit failed'}.`,
        retryable: false
      });
      return;
    }

    // Update navigator state, sticky context, and the in-place activity entry.
    nav.currentRecordId = record.id;
    await this.deps.saveRecordContext({
      templateId: tpl.id,
      recordId: record.id,
      setAt: Date.now()
    });

    const recordIndex = tpl.records.findIndex((r) => r.id === record.id) + 1;
    const updated: FillActivity = {
      kind: 'fill',
      id: nav.fillEntryId,
      at: Date.now(),
      label: this.state.resolvedQuestion ?? nav.matchedKey,
      canonicalKey: nav.matchedKey,
      value: valueToCommit,
      source: 'profile',
      alternativeValues: [],
      tabId: this.state.plan.tabId,
      frameId: this.state.plan.frameId,
      elementRef: this.state.plan.elementRef,
      previousValue: '', // overwritten below — preserved from the original entry
      fieldType: this.state.plan.fieldType,
      templateContext: {
        templateId: tpl.id,
        templateName: tpl.name,
        recordId: record.id,
        recordIndex,
        key: nav.matchedKey
      }
    };
    // Preserve the original previousValue (true pre-fill state) by reading the
    // existing entry. Activity buffer is owned by the SW caller; we ask it to
    // patch in place via updateActivity, which is also responsible for keeping
    // previousValue intact. So pass through here and the caller does the
    // merge.
    this.deps.updateActivity(updated);
    this.deps.broadcastPanel({ t: 'navigator-update', currentRecordId: record.id });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Switched to record ${recordIndex}/${tpl.records.length}.`
    });
  }

  private closeNavigator(): void {
    if (!this.state || this.state.phase !== 'navigating') return;
    if (this.state.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
    this.broadcastClose();
    this.deps.broadcastPanel({ t: 'navigator-close-broadcast' });
    this.deps.broadcastPanel({ t: 'close' });
    this.state = null;
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
    if (this.state.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
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
    if (this.state.inactivityTimer != null) clearTimeout(this.state.inactivityTimer);
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

    // Group-template integration: if the cleaned label matches a template key
    // AND there's a sticky context for the SAME template, route the save into
    // that record's slot. Otherwise behave as before (flat profile write).
    const sticky = await this.deps.loadRecordContext();
    const candidates = matchTargets(cleaned, profileBefore, settings.matching.fuseThreshold);
    const templateCandidate = candidates.find(
      (c): c is MatchCandidate & { target: Extract<MatchTarget, { kind: 'template' }> } =>
        c.target.kind === 'template' &&
        sticky != null &&
        c.target.templateId === sticky.templateId
    );

    if (templateCandidate && sticky) {
      const tplIdx = (profileBefore.groupTemplates ?? []).findIndex(
        (t) => t.id === sticky.templateId
      );
      if (tplIdx >= 0) {
        const tpl = profileBefore.groupTemplates[tplIdx];
        const recIdx = tpl.records.findIndex((r) => r.id === sticky.recordId);
        if (recIdx >= 0) {
          await this.saveToTemplateRecord({
            profileBefore,
            templateIndex: tplIdx,
            recordIndex: recIdx,
            key: templateCandidate.target.key,
            value,
            sensitive
          });
          return;
        }
      }
    }

    // Flat-profile path (default).
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

  /**
   * Write a value into one slot of one record of one template, then push a
   * SaveActivity that snapshots the full pre-save profile (so delete reverts
   * cleanly). Honors the per-key `array` type by appending instead of
   * overwriting when the existing slot is already a string[].
   */
  private async saveToTemplateRecord(args: {
    profileBefore: Profile;
    templateIndex: number;
    recordIndex: number;
    key: string;
    value: string;
    sensitive: boolean;
  }): Promise<void> {
    if (!this.state) return;
    const { profileBefore, templateIndex, recordIndex, key, value, sensitive } = args;
    const next = structuredClone(profileBefore);
    const tpl = next.groupTemplates[templateIndex];
    const record = tpl.records[recordIndex];
    const keyDef = tpl.keys.find((k) => k.key === key);
    const now = Date.now();
    if (keyDef?.type === 'array') {
      const existing = record.values[key];
      const arr = Array.isArray(existing) ? existing.slice() : existing ? [String(existing)] : [];
      const trimmed = value.trim();
      if (trimmed && !arr.some((v) => v.trim().toLowerCase() === trimmed.toLowerCase())) {
        arr.push(value);
      }
      record.values[key] = arr;
    } else {
      record.values[key] = value;
    }
    record.updatedAt = now;
    if (sensitive && keyDef && !keyDef.sensitive) {
      keyDef.sensitive = true;
    }
    tpl.updatedAt = now;
    await this.deps.saveProfile(next);

    const entry: SaveActivity = {
      kind: 'save',
      id: uuid(),
      at: Date.now(),
      label: `${tpl.name} #${recordIndex + 1} / ${key}`,
      value,
      previousProfile: profileBefore,
      templateContext: {
        templateId: tpl.id,
        templateName: tpl.name,
        recordId: record.id,
        recordIndex: recordIndex + 1,
        key
      }
    };
    this.deps.pushActivity(entry);
    this.deps.broadcastPanel({ t: 'recent-activity-add', entry });
    this.deps.broadcastPanel({
      t: 'status',
      message: `Saved to "${tpl.name}" record ${recordIndex + 1} → ${key}.`
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
  return { aliasMap, canonicalData, sensitiveKeys, groupTemplates: profile.groupTemplates ?? [] };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Resolve a record's value for one matched key into a string suitable for
 * commit. Returns null when no commit-able value is available (missing key,
 * empty array, select with no acceptable option). The caller decides whether
 * to fall through (fresh fill) or commit empty (record switch).
 *
 * Coercion rules:
 *   - boolean type     → "yes" / "no" for text-y fields; checkbox fields use
 *                        the same string but the commit layer interprets
 *                        "yes/true/1/checked" as checked.
 *   - array type       → joined with newlines for text/textarea/contenteditable;
 *                        first element for select/radio after fuzzy match;
 *                        joined with comma for unknown.
 *   - select/radio     → fuzzy-pick from options against the resolved string(s).
 *   - everything else  → string coerced to string.
 */
function resolveTemplateValueForField(
  template: GroupTemplate,
  record: GroupRecord,
  matchedKey: string,
  plan: FillPlan,
  settings: Settings
): string | null {
  const keyDef = template.keys.find((k) => k.key === matchedKey);
  const raw = record.values[matchedKey];
  if (raw == null || raw === '') return null;

  // Normalize to string[] for array handling.
  const asArray: string[] = Array.isArray(raw)
    ? raw.filter((v) => v != null && v !== '').map(String)
    : [String(raw)];
  if (asArray.length === 0) return null;

  if (plan.fieldType === 'select' || plan.fieldType === 'radio') {
    if (!plan.options || plan.options.length === 0) return null;
    const picked = pickMatchingOption(asArray, plan.options, settings.matching.fuseThreshold);
    return picked;
  }
  if (plan.fieldType === 'checkbox') {
    return asArray[0];
  }
  if (keyDef?.type === 'boolean') {
    const v = asArray[0].trim().toLowerCase();
    const truthy = v === 'yes' || v === 'true' || v === '1' || v === 'checked';
    return truthy ? 'yes' : 'no';
  }
  if (keyDef?.type === 'array' || asArray.length > 1) {
    if (plan.fieldType === 'textarea' || plan.fieldType === 'contenteditable') {
      return asArray.join('\n');
    }
    return asArray.join(', ');
  }
  return asArray[0];
}

void z; // reserved for inline schema use; suppress unused-import lint
