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
  | 'cancelled';

export type ProfileUpdate = {
  suggestedKey: string;
  fieldType: string;
  options: string[] | null;
  proposedValue: string;
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
    }
  | {
      kind: 'save';
      id: string;
      at: number;
      label: string;
      value: string;
      // previousProfile omitted from panel view — only the SW needs it.
    };

export class SessionStore {
  private port: TypedPort | null = null;

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

  dedupMerge: DedupMerge | null = $state(null);
  storyDiscovered: StoryDiscovered | null = $state(null);
  addToProfileConfirm: AddToProfileConfirm | null = $state(null);

  // Recent fills + saves, newest LAST. Updated by snapshot + add + remove
  // events from the SW.
  recentActivity: RecentActivity[] = $state([]);

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
  }

  stop(): void {
    this.port?.disconnect();
    this.port = null;
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
  postSwitchFillValue(id: string, newValue: string): void {
    this.port?.post({ t: 'switch-fill-value', id, newValue });
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
      case 'dedup-merge':
        this.dedupMerge = { olderEntryId: ev.olderEntryId, olderQuestion: ev.olderQuestion };
        return;
      case 'story-discovered':
        this.storyDiscovered = { content: ev.content, keywords: ev.keywords };
        return;
      case 'add-to-profile-confirm':
        this.addToProfileConfirm = { label: ev.label, value: ev.value };
        return;
      case 'close':
        this.resetSession();
        return;
      default:
        return;
    }
  }
}
