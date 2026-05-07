// Live session store for the side panel.
//
// Subscribes to the `fill-session` port and exposes Svelte 5 `$state` fields
// the UI can render. Constructed once at panel mount; on browser-tab close
// the panel page tears down and a new instance is created next time.
//
// On every panel connect, the SW sends a `recent-activity-snapshot` event
// — that's how the recent fills + saves list survives panel close/reopen
// during a single SW lifetime.

import { connectPort, type PortEvent, type TypedPort } from '$bg/messaging';

export type Phase =
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

// Mirror of the SW's GroupTemplate snapshot — kept loose so the panel doesn't
// import from $shared/types (which would pull in zod and the SW module graph).
// The SW already validated the shape before broadcasting.
export type NavigatorTemplate = {
  id: string;
  name: string;
  keys: Array<{ key: string; type: string; aliases: string[]; sensitive: boolean }>;
  records: Array<{
    id: string;
    values: Record<string, string | string[]>;
    createdAt: number;
    updatedAt: number;
  }>;
  defaultRecordId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NavigatorState = {
  template: NavigatorTemplate;
  currentRecordId: string;
  matchedKey: string;
  fillEntryId: string;
};

export type ProfileUpdate = {
  suggestedKey: string;
  fieldType: string;
  options: string[] | null;
  proposedValue: string;
};

export type AliasTarget =
  | { kind: 'flat'; canonicalKey: string }
  | { kind: 'template'; templateId: string; templateName: string; key: string };

export type AliasToast = {
  id: string;
  alias: string;
  canonicalDisplay: string;
  target: AliasTarget;
};

export type DedupMerge = { olderEntryId: string; olderQuestion: string };
export type StoryDiscovered = { content: string; keywords: string[] };
export type AddToProfileConfirm = { label: string; value: string };

// Mirrors the FillActivity / SaveActivity shapes from background/fill-session.ts.
// Kept loose here so the panel doesn't import from $bg (which pulls in the
// whole SW module graph). Validation already happened on the SW side.
export type RecentActivity =
  | {
      kind: 'fill';
      id: string;
      at: number;
      label: string;
      canonicalKey: string | null;
      value: string;
      source: 'profile' | 'profile_existing_value' | 'profile_update' | 'story_answer';
      alternativeValues: string[];
      tabId: number;
      frameId: number;
      elementRef: string;
      previousValue: string;
      fieldType: string;
      templateContext?: {
        templateId: string;
        templateName: string;
        recordId: string;
        recordIndex: number;
        key: string;
      };
    }
  | {
      kind: 'save';
      id: string;
      at: number;
      label: string;
      value: string;
      // previousProfile omitted from panel view — only the SW needs it.
      templateContext?: {
        templateId: string;
        templateName: string;
        recordId: string;
        recordIndex: number;
        key: string;
      };
    };

// Heartbeat cadence for the panel→SW keepalive event. The SW's session has
// an inactivity timer (see SESSION_INACTIVITY_MS in fill-session.ts) which is
// reset by every inbound port event — including this heartbeat. Picked well
// below Chrome MV3's ~30s service-worker idle ceiling so the SW stays alive
// while the user is composing in the panel.
const PANEL_KEEPALIVE_MS = 20_000;

export class SessionStore {
  private port: TypedPort | null = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  // ───── observable fields (Svelte 5 runes) ─────

  phase: Phase = $state('idle');
  status = $state('');
  errorMessage = $state('');
  errorRetryable = $state(false);

  profileUpdate: ProfileUpdate | null = $state(null);

  manualSelection = $state('');

  draft = $state('');
  draftStreaming = $state(false);
  draftDone = $state(false);
  maxLength = $state(0);

  // Newly-added alias toasts. Each one auto-dismisses after a few seconds
  // (the toast component owns the timer); the user can hit "Delete alias"
  // to revert the SW-side write before that timer fires.
  aliasToasts: AliasToast[] = $state([]);

  dedupMerge: DedupMerge | null = $state(null);
  storyDiscovered: StoryDiscovered | null = $state(null);
  addToProfileConfirm: AddToProfileConfirm | null = $state(null);

  // Recent fills + saves, newest LAST. Updated by snapshot + add + remove
  // events from the SW.
  recentActivity: RecentActivity[] = $state([]);

  // Group-template navigator (set by the SW after a template-match auto-commit;
  // updated as the user steps through records via Alt+]/Alt+[ or the buttons).
  navigator: NavigatorState | null = $state(null);

  // ───── lifecycle ─────

  start(): void {
    if (this.port) return;
    this.port = connectPort('panel');
    this.port.post({ t: 'hello', from: 'panel' });
    this.port.onDisconnect(() => {
      this.port = null;
      // Auto-reconnect on next tick (SW restart resilience).
      setTimeout(() => this.start(), 200);
    });
    this.port.on((ev) => this.onEvent(ev));
    if (this.keepaliveInterval == null) {
      // Panel-driven heartbeat: every PANEL_KEEPALIVE_MS we ping the SW. While
      // a session is active this both keeps the MV3 service worker awake and
      // resets the SW's session-inactivity timer so the user never loses an
      // in-progress draft to a silent timeout.
      this.keepaliveInterval = setInterval(() => this.postKeepalive(), PANEL_KEEPALIVE_MS);
    }
  }

  stop(): void {
    this.port?.disconnect();
    this.port = null;
    if (this.keepaliveInterval != null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /** Keepalive ping. Posted on a timer (see start) AND on user interaction
   *  with the panel — see App.svelte's pointerdown/keydown listener. The SW
   *  treats it as an activity tick and restarts the inactivity timer. */
  postKeepalive(): void {
    if (this.phase === 'idle') return;
    this.port?.post({ t: 'keepalive' });
  }

  // ───── outbound ─────

  postAbort(): void {
    this.port?.post({ t: 'abort' });
  }
  postSetActiveApplication(companyName: string, role: string, userBlurb: string | null): void {
    this.port?.post({ t: 'set-active-application', companyName, role, userBlurb });
  }
  postConfirmFill(valueOverride?: string): void {
    this.port?.post({ t: 'confirm-fill', valueOverride });
  }
  postConfirmProfileUpdate(canonicalKey: string, value: string, sensitive: boolean): void {
    this.port?.post({ t: 'confirm-profile-update', canonicalKey, value, sensitive });
  }
  postUndoMerge(): void {
    this.port?.post({ t: 'undo-merge' });
  }
  postConfirmStory(content: string, keywords: string[]): void {
    this.port?.post({ t: 'confirm-story', content, keywords });
  }
  postAddToProfileSubmit(canonicalKey: string, value: string, sensitive: boolean): void {
    this.port?.post({ t: 'add-to-profile-submit', canonicalKey, value, sensitive });
  }
  postManualHighlightSubmit(): void {
    const text = this.manualSelection.trim();
    if (!text) return;
    this.port?.post({ t: 'manual-highlight-submit', text });
    this.manualSelection = '';
  }
  postRevertFill(id: string): void {
    this.port?.post({ t: 'revert-fill', id });
  }
  postDeleteSave(id: string): void {
    this.port?.post({ t: 'delete-save', id });
  }
  postDeleteAlias(toast: AliasToast): void {
    this.port?.post({
      t: 'delete-alias',
      id: toast.id,
      alias: toast.alias,
      target: toast.target
    });
  }
  /** Local dismiss (auto-timeout, or user clicked "Keep"). Does NOT delete
   *  the alias from the profile — only removes the toast from the panel. */
  dismissAliasToast(id: string): void {
    this.aliasToasts = this.aliasToasts.filter((t) => t.id !== id);
  }
  postSwitchFillValue(id: string, newValue: string): void {
    this.port?.post({ t: 'switch-fill-value', id, newValue });
  }
  postNavigatorNext(): void {
    this.port?.post({ t: 'navigator-next' });
  }
  postNavigatorPrev(): void {
    this.port?.post({ t: 'navigator-prev' });
  }
  postNavigatorJump(recordId: string): void {
    this.port?.post({ t: 'navigator-jump', recordId });
  }
  postNavigatorClose(): void {
    this.port?.post({ t: 'navigator-close' });
  }
  /** Reset all transient session-derived UI state. Called on `close` events.
   *  Recent activity + the lock toast types persist across `close`. */
  resetSession(): void {
    this.phase = 'idle';
    this.status = '';
    this.profileUpdate = null;
    this.manualSelection = '';
    this.draft = '';
    this.draftStreaming = false;
    this.draftDone = false;
    this.maxLength = 0;
    this.addToProfileConfirm = null;
    this.navigator = null;
  }

  // ───── inbound ─────

  private onEvent(ev: PortEvent): void {
    switch (ev.t) {
      case 'phase':
        this.phase = ev.phase as Phase;
        if (ev.phase !== 'manual_highlight') this.manualSelection = '';
        if (ev.phase === 'cancelled') this.resetSession();
        return;
      case 'status':
        this.status = ev.message;
        return;
      case 'error':
        this.status = '';
        this.errorMessage = ev.message;
        this.errorRetryable = !!ev.retryable;
        return;
      case 'manual-highlight-selection':
        this.manualSelection = ev.text;
        return;
      case 'profile-update':
        this.profileUpdate = {
          suggestedKey: ev.suggestedKey,
          fieldType: ev.fieldType,
          options: ev.options,
          proposedValue: ev.proposedValue
        };
        return;
      case 'answer-start':
        this.draft = '';
        this.draftStreaming = true;
        this.draftDone = false;
        this.maxLength = ev.maxLength;
        this.profileUpdate = null;
        return;
      case 'answer-token':
        this.draft += ev.text;
        return;
      case 'answer-done':
        this.draft = ev.fullText || this.draft;
        this.draftStreaming = false;
        this.draftDone = true;
        this.status = '';
        return;
      case 'recent-activity-snapshot':
        this.recentActivity = (ev.entries as RecentActivity[]) ?? [];
        return;
      case 'recent-activity-add':
        this.recentActivity = [...this.recentActivity, ev.entry as RecentActivity];
        return;
      case 'recent-activity-remove':
        this.recentActivity = this.recentActivity.filter((e) => e.id !== ev.id);
        return;
      case 'recent-activity-update': {
        const updated = ev.entry as RecentActivity;
        this.recentActivity = this.recentActivity.map((e) =>
          e.id === updated.id ? updated : e
        );
        return;
      }
      case 'alias-added':
        this.aliasToasts = [
          ...this.aliasToasts,
          {
            id: ev.id,
            alias: ev.alias,
            canonicalDisplay: ev.canonicalDisplay,
            target: ev.target as AliasTarget
          }
        ];
        return;
      case 'alias-toast-remove':
        this.aliasToasts = this.aliasToasts.filter((t) => t.id !== ev.id);
        return;
      case 'dedup-merge':
        this.dedupMerge = { olderEntryId: ev.olderEntryId, olderQuestion: ev.olderQuestion };
        return;
      case 'story-discovered':
        this.storyDiscovered = { content: ev.content, keywords: ev.keywords };
        return;
      case 'add-to-profile-confirm':
        this.addToProfileConfirm = { label: ev.label, value: ev.value };
        return;
      case 'navigator-open': {
        this.navigator = {
          template: ev.template as NavigatorTemplate,
          currentRecordId: ev.currentRecordId,
          matchedKey: ev.matchedKey,
          fillEntryId: ev.fillEntryId
        };
        return;
      }
      case 'navigator-update': {
        if (this.navigator) {
          this.navigator = { ...this.navigator, currentRecordId: ev.currentRecordId };
        }
        return;
      }
      case 'navigator-close-broadcast':
        this.navigator = null;
        return;
      case 'close':
        this.resetSession();
        return;
      default:
        return;
    }
  }
}
