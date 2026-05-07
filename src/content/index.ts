// Content script — Phase 2 (multi-frame aware).
//
// Compiled as an ES module by crxjs (no globals on window). Stays passive
// until the SW posts `run-detective` over the port, then:
//
//   - synchronously captures `document.activeElement` BEFORE any await (§4.1).
//   - assigns the element a uuid (`elementRef`) so the SW can address it later.
//   - climbs for the question text, captures field type / options /
//     currentValue / page context.
//   - sends the FillPlan back over the port.
//
// Multi-frame: with `all_frames: true`, EVERY frame (top + every iframe) runs
// its own copy of this script. The SW broadcasts `run-detective` to all of
// them. Each frame self-elects: it only responds with a fill-plan if its
// own document is "the focused one" (i.e. activeElement is a real focusable
// field, not the body / an iframe element). Frames that aren't focused
// stay silent — the SW takes the first responder.
//
// Manual highlight: same pattern. Each frame independently runs its
// selection capture. Only the frame containing the user's selection emits
// non-empty `manual-highlight-selection` events; the others stay quiet.
//
// Esc handling: a capture-phase keydown listener posts `abort` to the SW
// whenever a session is active for this frame.

import { connectPort, type TypedPort } from '$bg/messaging';
import { runDetective } from './detective';
import { commitValue, isSupportedFieldType } from './commit';
import { startManualHighlight, stopManualHighlight } from './highlight-fallback';
import type { FieldType } from '$shared/types';

(() => {
  let port: TypedPort | null = null;
  let escWired = false;
  let navKeysWired = false;

  // elementRef → element. WeakRef so detached nodes can be GC'd.
  const refs = new Map<string, WeakRef<Element>>();
  let sessionActive = false;
  // True while the group-template navigator is open in the side panel.
  // Gating on this flag ensures we only intercept Alt+, / Alt+. during an
  // active navigator session and never interfere with normal page interaction.
  let navigatorActive = false;
  // Navigator keys are pushed by the SW via the `navigator-active` message
  // (which carries the user-rebound values from settings). Defaults match
  // DEFAULT_SETTINGS.navigator and are used if an older SW elides them.
  let navPrevKey = ',';
  let navNextKey = '.';

  function newRef(el: Element): string {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `ref-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    refs.set(id, new WeakRef(el));
    return id;
  }

  function deref(id: string): Element | null {
    const ref = refs.get(id);
    if (!ref) return null;
    return ref.deref() ?? null;
  }

  function ensureEsc() {
    if (escWired) return;
    escWired = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && sessionActive && port) {
          // Don't preventDefault — the panel may also want to react via its
          // own Esc handler; we just send the abort. Page handlers seeing
          // Esc is fine.
          port.post({ t: 'abort' });
        }
      },
      true
    );
  }

  /**
   * Wire the Alt+, / Alt+. keydown listener once for the lifetime of this
   * content script. The listener only acts when `navigatorActive` is true,
   * so it is completely inert during normal page interaction.
   *
   * We use the capture phase (third arg `true`) so the handler runs before
   * the page's own listeners — necessary for preventDefault to stop any
   * page-side Alt+, / Alt+. bindings from also firing.
   */
  function ensureNavKeys() {
    if (navKeysWired) return;
    navKeysWired = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (!e.altKey || !navigatorActive || !port) return;
        if (e.key === navPrevKey) {
          e.preventDefault();
          port.post({ t: 'navigator-prev' });
        } else if (e.key === navNextKey) {
          e.preventDefault();
          port.post({ t: 'navigator-next' });
        }
      },
      true
    );
  }

  function endSession() {
    sessionActive = false;
    navigatorActive = false;
    stopManualHighlight();
  }

  /**
   * Self-election for run-detective. We only respond if THIS frame is the
   * one that holds the user's current focus. The decision rule:
   *   - activeElement must exist and not be the document body or root.
   *   - activeElement must NOT be an iframe / frame element (focus is
   *     actually inside that subframe; let it respond).
   *
   * This works because every frame in the tab is running the same content
   * script via `all_frames: true`, and the SW broadcasts `run-detective` to
   * every content port for the tab simultaneously.
   */
  function isFocusedFrame(): boolean {
    const a = document.activeElement;
    if (!a) return false;
    if (a === document.body || a === document.documentElement) return false;
    if (a instanceof HTMLIFrameElement) return false;
    if (typeof HTMLFrameElement !== 'undefined' && a instanceof HTMLFrameElement) return false;
    return true;
  }

  function connect() {
    try {
      port = connectPort('content');
    } catch {
      port = null;
      return;
    }
    port.post({ t: 'hello', from: 'content' });
    port.onDisconnect(() => {
      endSession();
      port = null;
      // Reconnect on next event tick — SW restarts are common.
      setTimeout(connect, 200);
    });

    port.on(async (ev) => {
      switch (ev.t) {
        case 'run-detective': {
          // CRITICAL: synchronously read activeElement BEFORE any await.
          // chrome.sidePanel.open() (dispatched by the SW) may move focus.
          // ensureEsc + sessionActive flags are set unconditionally so any
          // subsequent Esc still aborts even if this frame turns out not to
          // be the focused one.
          ensureEsc();
          sessionActive = true;
          if (!isFocusedFrame()) {
            // This frame doesn't hold focus — the focused frame's content
            // script will handle it. Stay silent (the SW will take the
            // first valid fill-plan response and ignore the rest, including
            // our absence).
            return;
          }
          const focused = document.activeElement as Element;
          const result = await runDetective(focused, ev.detector);
          if (result.rejected) {
            port?.post({
              t: 'detective-failed',
              reason: `field-rejected:${result.rejected}`
            });
            return;
          }
          const elementRef = newRef(focused);
          port?.post({
            t: 'fill-plan',
            plan: {
              question: result.question,
              fieldType: result.fieldType,
              options: result.options,
              currentValue: result.currentValue,
              pageContext: result.pageContext,
              ancestorHtml: result.ancestorHtml,
              ancestorInnerText: result.ancestorInnerText,
              elementDescriptor: result.elementDescriptor,
              elementRef,
              tabId: -1, // SW will overwrite from sender.tab.id
              frameId: -1 // SW will overwrite from sender.frameId
            }
          });
          break;
        }

        case 'manual-highlight-start': {
          // Every frame starts highlight capture independently. Frames whose
          // window.getSelection() is empty just won't emit selection events,
          // so the SW only receives non-empty selections from the frame the
          // user is actually selecting in.
          startManualHighlight({
            onSelection: (text) => port?.post({ t: 'manual-highlight-selection', text }),
            onSubmit: (text) => port?.post({ t: 'manual-highlight-submit', text }),
            onCancel: () => port?.post({ t: 'manual-highlight-cancel' })
          });
          break;
        }

        case 'navigator-active': {
          // SW tells us to start or stop intercepting Alt+<prev>/Alt+<next>.
          // Sent when entering / leaving the 'navigating' phase. The keys
          // come from user settings (default ',' and '.').
          navigatorActive = ev.active;
          if (ev.active) {
            if (ev.prevKey) navPrevKey = ev.prevKey;
            if (ev.nextKey) navNextKey = ev.nextKey;
          }
          break;
        }

        case 'manual-highlight-stop': {
          stopManualHighlight();
          break;
        }

        case 'close': {
          // endSession() also clears navigatorActive, so the keydown listener
          // becomes inert again even if we never got an explicit
          // navigator-active:false (e.g. on abort or session end).
          endSession();
          break;
        }

        default:
          break;
      }
    });
  }

  // bfcache restore: when the page comes back out of the bfcache, our old
  // port is dead but no `onDisconnect` fires reliably. Force a reconnect.
  // Registered ONCE at module load.
  window.addEventListener('pageshow', (e) => {
    const ev = e as PageTransitionEvent;
    if (ev.persisted) {
      try {
        port?.disconnect();
      } catch {
        /* */
      }
      port = null;
      setTimeout(connect, 0);
    }
  });

  // Commit instruction comes through a separate one-shot RPC because it's a
  // request/response with a typed result.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      typeof msg !== 'object' ||
      msg == null ||
      (msg as { __quickfill_commit__?: unknown }).__quickfill_commit__ !== true
    ) {
      return false;
    }
    const m = msg as { elementRef: string; fieldType: FieldType; value: string };
    const el = deref(m.elementRef);
    if (!el) {
      sendResponse({ ok: false, kind: 'detached', message: 'element no longer present' });
      return false;
    }
    if (!isSupportedFieldType(m.fieldType)) {
      sendResponse({ ok: false, kind: 'unsupported-field', message: 'unsupported field type' });
      return false;
    }
    commitValue(el, m.fieldType, m.value).then(sendResponse);
    return true; // async response
  });

  // Wire Alt+, / Alt+. interception once at module load. The listener is
  // completely inert until the SW sends navigator-active:true.
  ensureNavKeys();
  connect();
})();
