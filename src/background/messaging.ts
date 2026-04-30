// Single source of truth for the message protocol (§3.4).
//
// Two channels:
//
//   1. RPC — one-shot request/response (chrome.runtime.sendMessage). Each
//      op declares request and response zod schemas; both sides validate.
//      Errors are surfaced as a discriminated `{ ok: false, kind, message }`
//      union, never thrown across contexts.
//
//   2. Port — long-lived bidirectional `chrome.runtime.connect` named
//      "fill-session". The content script and the side panel each open one.
//      Discriminator: `port.sender?.tab != null` ⇒ ContentPort, else PanelPort.
//
// Phase 1 wires the plumbing. Phase 2 expands the port event union with
// detective / fill-plan / stream-token / commit / abort variants.

import { z } from 'zod';
import {
  activeApplicationSchema,
  answerHistoryEntrySchema,
  backupEnvelopeSchema,
  fillPlanSchema,
  logEntrySchema,
  profileSchema,
  settingsSchema,
  storySchema
} from '$shared/schemas';
import type { Result } from '$shared/types';

// ───────────────────────── RPC contracts ─────────────────────────

// Add a new RPC: extend `RpcContracts`. The handler registers itself in
// the SW; clients call via `rpcCall()`.

export const rpcContracts = {
  ping: {
    request: z.object({}),
    response: z.object({ pong: z.literal(true), now: z.number() })
  },
  'is-initialized': {
    request: z.object({}),
    response: z.object({ initialized: z.boolean() })
  },
  'is-unlocked': {
    request: z.object({}),
    response: z.object({ unlocked: z.boolean() })
  },
  'setup-master': {
    request: z.object({ password: z.string().min(8) }),
    response: z.object({ recoveryPhrase: z.string() })
  },
  'remove-recovery-phrase': {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) })
  },
  'unlock-with-password': {
    request: z.object({ password: z.string() }),
    response: z.object({ unlocked: z.boolean() })
  },
  'unlock-with-phrase': {
    request: z.object({ phrase: z.string() }),
    response: z.object({ unlocked: z.boolean() })
  },
  'change-password': {
    request: z.discriminatedUnion('via', [
      z.object({ via: z.literal('password'), current: z.string(), newPassword: z.string().min(8) }),
      z.object({ via: z.literal('phrase'), phrase: z.string(), newPassword: z.string().min(8) })
    ]),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), reason: z.enum(['wrong-credential', 'no-recovery', 'too-short']) })
    ])
  },
  lock: {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) })
  },
  'reset-extension': {
    request: z.object({ confirm: z.literal('YES, WIPE EVERYTHING') }),
    response: z.object({ ok: z.literal(true) })
  },
  'get-settings': {
    request: z.object({}),
    response: settingsSchema
  },
  'set-settings': {
    request: settingsSchema,
    response: z.object({ ok: z.literal(true) })
  },
  'get-active-application': {
    request: z.object({}),
    response: activeApplicationSchema.nullable()
  },
  'clear-active-application': {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) })
  },
  'log-event': {
    request: logEntrySchema,
    response: z.object({ ok: z.literal(true) })
  },
  'embed-warmup': {
    request: z.object({}),
    response: z.object({ ok: z.boolean(), elapsedMs: z.number() })
  },
  'run-diagnostic': {
    request: z.object({}),
    // The full DiagnosticResult lives in shared/types; the schema mirrors it
    // loosely here so the caller doesn't have to import zod for trivial use.
    response: z.unknown()
  },
  // Phase 2 stub — receives a FillPlan emitted by the content script via RPC fallback
  // (the live path will be the port). Useful for tests.
  'submit-fill-plan': {
    request: fillPlanSchema,
    response: z.object({ ok: z.literal(true) })
  },
  // Lightweight profile read/write — used by Phase 3 Options pages and the
  // E2E suite. Validation lives at the page edge before posting set-profile.
  'get-profile': {
    request: z.object({}),
    response: profileSchema
  },
  'set-profile': {
    request: profileSchema,
    response: z.object({ ok: z.literal(true) })
  },
  // Stories CRUD (Options → Stories).
  'get-stories': {
    request: z.object({}),
    response: z.array(storySchema)
  },
  'set-stories': {
    request: z.array(storySchema),
    response: z.object({ ok: z.literal(true) })
  },
  // Persisted answer-history (Options → Answer history). The session-local
  // ring buffer in `index.ts` is separate; this is the encrypted on-disk list.
  'get-history': {
    request: z.object({}),
    response: z.array(answerHistoryEntrySchema)
  },
  'delete-history-entry': {
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.literal(true) })
  },
  'set-history': {
    request: z.array(answerHistoryEntrySchema),
    response: z.object({ ok: z.literal(true) })
  },
  // Logger Options page.
  'get-logs': {
    request: z.object({}),
    response: z.array(logEntrySchema)
  },
  'clear-logs': {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) })
  },
  // Resume parsing (onboarding step 5). The onboarding page extracts text
  // (mammoth.js for .docx; UTF-8 decode for .txt) and posts it here. The SW
  // owns the LLM call so the export password and model id never need to
  // cross another context.
  'parse-resume': {
    request: z.object({ resumeText: z.string() }),
    response: z.object({
      profile: profileSchema,
      stories: z.array(storySchema)
    })
  },
  // Backup export / import. The SW owns crypto so the export password
  // never leaves the SW.
  'backup-export': {
    request: z.object({ exportPassword: z.string().min(8) }),
    response: backupEnvelopeSchema
  },
  'backup-import': {
    request: z.object({
      envelope: backupEnvelopeSchema,
      exportPassword: z.string(),
      mode: z.enum(['replace-all', 'merge-stories'])
    }),
    // Inner discriminated union — keeps every per-kind import error visible
    // even after going through the rpcCall wrapper (which only collapses
    // outer { ok: false } shapes into Result errors).
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), storiesAdded: z.number() }),
      z.object({
        ok: z.literal(false),
        kind: z.enum([
          'parse-envelope',
          'unsupported-format',
          'version-newer',
          'wrong-password',
          'parse-payload',
          'storage-failed'
        ]),
        message: z.string()
      })
    ])
  },
  // Lightweight reachability ping for the Models options page. Wraps
  // `ollamaPresenceCheck`, which talks to /api/tags. Never throws.
  'ollama-reachability-check': {
    request: z.object({ baseUrl: z.string() }),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), models: z.array(z.string()) }),
      z.object({ ok: z.literal(false), error: z.string() })
    ])
  },
  // Test-only — triggers session.start without a chrome.commands keybinding.
  // Playwright extension contexts can't reliably dispatch Alt+A as a user
  // gesture, so the E2E suite uses this to start a fill from a known tab.
  // Same code path as the real command listener.
  '__test-start-fill': {
    request: z.object({ tabId: z.number(), frameId: z.number().default(0), kind: z.enum(['fill', 'add-to-profile']).default('fill') }),
    response: z.object({ ok: z.literal(true) })
  }
} as const;

export type RpcName = keyof typeof rpcContracts;
export type RpcRequest<N extends RpcName> = z.infer<(typeof rpcContracts)[N]['request']>;
export type RpcResponse<N extends RpcName> = z.infer<(typeof rpcContracts)[N]['response']>;

type RpcEnvelope<N extends RpcName = RpcName> = {
  __autofill_rpc__: true;
  name: N;
  payload: unknown;
};

function isEnvelope(v: unknown): v is RpcEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __autofill_rpc__?: unknown }).__autofill_rpc__ === true
  );
}

// ───────────────────────── RPC client (any context → SW) ─────────────────────────

export async function rpcCall<N extends RpcName>(
  name: N,
  payload: RpcRequest<N>
): Promise<Result<RpcResponse<N>>> {
  const contract = rpcContracts[name];
  const reqParse = contract.request.safeParse(payload);
  if (!reqParse.success) {
    return {
      ok: false,
      kind: 'bad-request',
      message: `RPC ${name}: invalid request — ${reqParse.error.message}`
    };
  }
  const envelope: RpcEnvelope<N> = {
    __autofill_rpc__: true,
    name,
    payload: reqParse.data
  };
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(envelope);
  } catch (e) {
    return {
      ok: false,
      kind: 'transport',
      message: `RPC ${name}: transport error — ${(e as Error).message ?? String(e)}`
    };
  }
  // The handler sends a Result-shaped value; validate.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { ok?: unknown }).ok === false
  ) {
    return raw as Result<RpcResponse<N>>;
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { ok?: unknown }).ok !== true
  ) {
    return {
      ok: false,
      kind: 'bad-response',
      message: `RPC ${name}: handler returned non-Result value`
    };
  }
  const value = (raw as { value: unknown }).value;
  const respParse = contract.response.safeParse(value);
  if (!respParse.success) {
    return {
      ok: false,
      kind: 'bad-response',
      message: `RPC ${name}: response failed validation — ${respParse.error.message}`
    };
  }
  return { ok: true, value: respParse.data as RpcResponse<N> };
}

// ───────────────────────── RPC server (SW only) ─────────────────────────

type Handler<N extends RpcName> = (
  req: RpcRequest<N>,
  sender: chrome.runtime.MessageSender
) => Promise<RpcResponse<N>>;

const handlers = new Map<RpcName, Handler<RpcName>>();

export function rpcHandle<N extends RpcName>(name: N, handler: Handler<N>): void {
  handlers.set(name, handler as unknown as Handler<RpcName>);
}

export function installRpcRouter(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isEnvelope(msg)) return false;
    const contract = rpcContracts[msg.name];
    if (!contract) {
      sendResponse({ ok: false, kind: 'unknown-rpc', message: `unknown RPC: ${msg.name}` });
      return false;
    }
    const handler = handlers.get(msg.name);
    if (!handler) {
      sendResponse({ ok: false, kind: 'no-handler', message: `no handler for RPC: ${msg.name}` });
      return false;
    }
    const reqParse = contract.request.safeParse(msg.payload);
    if (!reqParse.success) {
      sendResponse({
        ok: false,
        kind: 'bad-request',
        message: `RPC ${msg.name}: ${reqParse.error.message}`
      });
      return false;
    }
    (async () => {
      try {
        const value = await handler(reqParse.data as RpcRequest<typeof msg.name>, sender);
        const respParse = contract.response.safeParse(value);
        if (!respParse.success) {
          sendResponse({
            ok: false,
            kind: 'bad-response',
            message: `RPC ${msg.name} handler returned invalid response: ${respParse.error.message}`
          });
          return;
        }
        sendResponse({ ok: true, value: respParse.data });
      } catch (e) {
        sendResponse({
          ok: false,
          kind: 'handler-threw',
          message: `RPC ${msg.name} handler threw: ${(e as Error).message ?? String(e)}`
        });
      }
    })();
    return true; // keep the channel open for the async response
  });
}

// ───────────────────────── Port protocol ─────────────────────────

// Distinct names per role. The earlier design used a single name and
// discriminated by `sender.tab != null`, but that misclassifies any panel
// page opened as a regular tab (e.g. by Playwright, or by users who load
// the side-panel HTML directly). Per-role names make discrimination
// unambiguous and survive any context.
export const CONTENT_PORT_NAME = 'fill-session-content';
export const PANEL_PORT_NAME = 'fill-session-panel';

// Backwards-compat re-export — only referenced by tests/diagnostics that
// previously assumed a single name. New code should use the role-specific
// constants above.
export const PORT_NAME = CONTENT_PORT_NAME;

// Port event union. Every variant is keyed by `t`. Direction in comments
// is informative — TypedPort doesn't enforce it (the SW filters by sender).
export const portEventSchema = z.discriminatedUnion('t', [
  // ───── handshake / lifecycle ─────
  z.object({ t: z.literal('hello'), from: z.enum(['content', 'panel']) }),
  z.object({ t: z.literal('ack') }),
  z.object({ t: z.literal('close') }),                                                 // SW → both
  z.object({ t: z.literal('abort') }),                                                 // either → SW
  z.object({ t: z.literal('status'), message: z.string() }),                           // SW → panel
  z.object({                                                                           // SW → panel
    t: z.literal('error'),
    message: z.string(),
    retryable: z.boolean().optional()
  }),

  // ───── detective handshake (SW ↔ content script in active frame) ─────
  z.object({ t: z.literal('run-detective') }),                                         // SW → content
  z.object({ t: z.literal('fill-plan'), plan: fillPlanSchema }),                        // content → SW
  z.object({ t: z.literal('detective-failed'), reason: z.string() }),                   // content → SW

  // ───── manual highlight fallback ─────
  z.object({ t: z.literal('manual-highlight-start') }),                                 // SW → content
  z.object({ t: z.literal('manual-highlight-stop') }),                                  // SW → content
  z.object({ t: z.literal('manual-highlight-selection'), text: z.string() }),           // content → SW (live preview)
  z.object({ t: z.literal('manual-highlight-submit'), text: z.string() }),              // content → SW (Enter)
  z.object({ t: z.literal('manual-highlight-cancel') }),                                // content → SW

  // ───── application setup (panel → SW) ─────
  z.object({
    t: z.literal('set-active-application'),
    companyName: z.string(),
    role: z.string(),
    userBlurb: z.string().nullable()
  }),

  // ───── live session state broadcasts (SW → panel) ─────
  z.object({
    t: z.literal('phase'),
    phase: z.enum([
      'detecting',
      'manual_highlight',
      'matching',
      'classifying',
      'profile_update_pending',
      'story_setup',
      'answering',
      'committed',
      'cancelled'
    ])
  }),

  // ───── classifier → profile_update card (SW → panel) ─────
  z.object({
    t: z.literal('profile-update'),
    suggestedKey: z.string(),
    fieldType: z.string(),
    options: z.array(z.string()).nullable(),
    proposedValue: z.string()
  }),

  // ───── streaming answer (SW → panel) ─────
  z.object({ t: z.literal('answer-start'), maxLength: z.number() }),
  z.object({ t: z.literal('answer-token'), text: z.string() }),
  z.object({ t: z.literal('answer-done'), fullText: z.string() }),

  // ───── user actions (panel → SW) ─────
  z.object({ t: z.literal('confirm-fill'), valueOverride: z.string().optional() }),
  z.object({
    t: z.literal('confirm-profile-update'),
    canonicalKey: z.string(),
    value: z.string(),
    sensitive: z.boolean()
  }),

  // ───── recent activity (SW → panel) ─────
  // Each fill (profile match, profile_existing_value, profile_update commit,
  // or story_answer commit) and each Alt+S save appends one entry to a
  // session-local ring buffer. The panel renders them in FillHistory /
  // SaveHistory and exposes per-entry delete buttons.
  z.object({
    t: z.literal('recent-activity-snapshot'),
    entries: z.array(z.unknown())
  }),
  z.object({
    t: z.literal('recent-activity-add'),
    entry: z.unknown()
  }),
  z.object({
    t: z.literal('recent-activity-remove'),
    id: z.string()
  }),

  // Panel asks the SW to undo a fill or a save.
  z.object({ t: z.literal('revert-fill'), id: z.string() }),
  z.object({ t: z.literal('delete-save'), id: z.string() }),

  // Panel asks the SW to re-commit a different value for the same field.
  z.object({ t: z.literal('switch-fill-value'), id: z.string(), newValue: z.string() }),

  // SW tells the panel to update an existing activity entry in-place.
  z.object({ t: z.literal('recent-activity-update'), entry: z.unknown() }),

  // ───── post-commit signals (SW → panel) ─────
  z.object({
    t: z.literal('dedup-merge'),
    olderEntryId: z.string(),
    olderQuestion: z.string()
  }),
  z.object({ t: z.literal('undo-merge') }),                                             // panel → SW
  z.object({
    t: z.literal('story-discovered'),
    content: z.string(),
    keywords: z.array(z.string())
  }),
  z.object({
    t: z.literal('confirm-story'),
    content: z.string(),
    keywords: z.array(z.string())
  }),

  // ───── add-to-profile (Alt+S) confirmation (SW → panel) ─────
  z.object({
    t: z.literal('add-to-profile-confirm'),
    label: z.string(),
    value: z.string()
  }),
  z.object({
    t: z.literal('add-to-profile-submit'),
    canonicalKey: z.string(),
    value: z.string(),
    sensitive: z.boolean()
  })
]);

export type PortEvent = z.infer<typeof portEventSchema>;

/**
 * Wrapper around chrome.runtime.Port that:
 *  - validates every inbound message against `portEventSchema` (drops invalid),
 *  - swallows the `Attempting to use a disconnected port` error on send
 *    (caused by Chrome bfcache and SW restart races),
 *  - exposes a typed `on`/`post`/`disconnect` surface.
 */
export class TypedPort {
  private listeners: Set<(ev: PortEvent) => void> = new Set();
  private disconnectListeners: Set<() => void> = new Set();
  private disconnected = false;

  constructor(public readonly raw: chrome.runtime.Port) {
    raw.onMessage.addListener((msg) => {
      const parsed = portEventSchema.safeParse(msg);
      if (!parsed.success) return; // silently drop malformed
      for (const l of this.listeners) {
        try {
          l(parsed.data);
        } catch {
          /* listener errors must not poison the port */
        }
      }
    });
    raw.onDisconnect.addListener(() => {
      this.disconnected = true;
      for (const l of this.disconnectListeners) {
        try {
          l();
        } catch { /* */ }
      }
    });
  }

  on(fn: (ev: PortEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onDisconnect(fn: () => void): () => void {
    this.disconnectListeners.add(fn);
    return () => this.disconnectListeners.delete(fn);
  }

  /**
   * Returns true iff the message left this side of the channel without error.
   * Note: we can't distinguish "delivered to peer" from "queued in transit" —
   * Chrome MV3 ports don't surface acks. But if Chrome marks the port as
   * disconnected (typical for bfcache / SW restart), .postMessage throws and
   * we mark + return false.
   */
  post(ev: PortEvent): boolean {
    if (this.disconnected) return false;
    try {
      this.raw.postMessage(ev);
      return true;
    } catch {
      this.disconnected = true;
      return false;
    }
  }

  /** Cheap "is the peer probably alive?" test. Used to skip stale ports. */
  isAlive(): boolean {
    return !this.disconnected;
  }

  disconnect(): void {
    if (this.disconnected) return;
    try {
      this.raw.disconnect();
    } catch {
      /* */
    }
    this.disconnected = true;
  }
}

/** Open a typed port from any non-SW context. */
export function connectPort(role: 'content' | 'panel'): TypedPort {
  const name = role === 'panel' ? PANEL_PORT_NAME : CONTENT_PORT_NAME;
  return new TypedPort(chrome.runtime.connect({ name }));
}

// ───────────────────────── Port discrimination (SW) ─────────────────────────

export type ContentPort = TypedPort & {
  __role: 'content';
  tabId: number;
  frameId: number;
};

export type PanelPort = TypedPort & {
  __role: 'panel';
};

export function discriminatePort(raw: chrome.runtime.Port): ContentPort | PanelPort | null {
  const wrapped = new TypedPort(raw);
  if (raw.name === PANEL_PORT_NAME) {
    return Object.assign(wrapped, { __role: 'panel' as const }) as PanelPort;
  }
  if (raw.name === CONTENT_PORT_NAME) {
    // Content scripts always have sender.tab set; defensive fallback to -1.
    return Object.assign(wrapped, {
      __role: 'content' as const,
      tabId: raw.sender?.tab?.id ?? -1,
      frameId: raw.sender?.frameId ?? 0
    }) as ContentPort;
  }
  return null;
}
