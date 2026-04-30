// Service Worker entry — Phase 2.
//
// Wires:
//   - RPC router + handlers for onboarding / unlock / settings / diagnostics
//   - Port discrimination (content vs side panel)
//   - Side-panel auto-open on the action button
//   - Logger settings sync
//   - Alt+A / Alt+Shift+A / Alt+S chrome.commands listeners
//   - FillSession orchestrator hooked to ports + storage + commit RPC

import { DEFAULT_SETTINGS } from '../shared/constants';
import type {
  ActiveApplication,
  AnswerHistoryEntry,
  DiagnosticResult,
  FieldType,
  Profile,
  Settings,
  Story
} from '../shared/types';
import { clearLogs, logger, readLogs, setLoggerSettings, log } from './logger';
import { mergeStories, packBackup, unpackBackup } from './backup';
import { ollamaPresenceCheck } from './llm/ollama';
import { parseResume } from './resume/parser';
import {
  type ContentPort,
  type PanelPort,
  CONTENT_PORT_NAME,
  PANEL_PORT_NAME,
  discriminatePort,
  installRpcRouter,
  rpcHandle
} from './messaging';
import { warmup } from './rag/embeddings';
import { Store, SESSION_KEYS } from './storage/store';
import { FillSessionImpl, type FillActivity, type RecentActivity, type SaveActivity } from './fill-session';
import { invalidateMatcherCache } from './matcher';

// ───────────────────────── Boot ─────────────────────────

installRpcRouter();

const panelPorts = new Set<PanelPort>();
const contentPortsByTab = new Map<number, Set<ContentPort>>();

// Buffered broadcasts for the panel — used when no panel is connected at
// broadcast time (typical: Alt+A fires; SW broadcasts status; panel hasn't
// mounted yet). On first panel connect, we flush. New panel connects later
// do NOT replay the buffer (the session may already be over).
const PANEL_BUFFER_MAX = 64;
let panelBuffer: import('./messaging').PortEvent[] = [];

function broadcastPanel(ev: import('./messaging').PortEvent): void {
  if (panelPorts.size === 0) {
    panelBuffer.push(ev);
    if (panelBuffer.length > PANEL_BUFFER_MAX) panelBuffer.shift();
    return;
  }
  for (const p of panelPorts) {
    if (!p.post(ev)) panelPorts.delete(p);
  }
}

function dropContentPort(port: ContentPort): void {
  const s = contentPortsByTab.get(port.tabId);
  if (!s) return;
  s.delete(port);
  if (s.size === 0) contentPortsByTab.delete(port.tabId);
}

// ───────────────────────── Recent activity ring buffer ─────────────────────────
// Session-local (in-memory; cleared when the SW is evicted). The panel
// mirrors this buffer; on every panel connect the SW sends a snapshot.

const RECENT_ACTIVITY_MAX = 50;
const recentActivity: RecentActivity[] = [];

function persistRecentActivity(): void {
  // Fire-and-forget: persist the ring buffer to session storage so it
  // survives SW eviction within the same browser session.
  chrome.storage.session
    .set({ [SESSION_KEYS.recentActivity]: recentActivity })
    .catch(() => { /* non-critical */ });
}

function pushActivity(entry: RecentActivity): void {
  recentActivity.push(entry);
  if (recentActivity.length > RECENT_ACTIVITY_MAX) recentActivity.shift();
  persistRecentActivity();
}

function removeActivity(id: string): void {
  const i = recentActivity.findIndex((e) => e.id === id);
  if (i >= 0) recentActivity.splice(i, 1);
  persistRecentActivity();
}

async function switchFillValue(id: string, newValue: string): Promise<void> {
  const entry = recentActivity.find((e) => e.id === id && e.kind === 'fill') as
    | FillActivity
    | undefined;
  if (!entry) return;
  try {
    const r = await commitOnPage(
      entry.tabId,
      entry.frameId,
      entry.elementRef,
      entry.fieldType,
      newValue
    );
    if (!r.ok) {
      broadcastPanel({
        t: 'error',
        message: `Couldn't switch value for "${entry.label}": ${r.message ?? r.kind ?? 'commit failed'}.`,
        retryable: false
      });
      return;
    }
    // Update the ring buffer in-place (previousValue stays as original pre-fill).
    const updated: FillActivity = {
      ...entry,
      value: newValue,
      alternativeValues: [
        entry.value,
        ...entry.alternativeValues.filter((v) => v !== newValue)
      ]
    };
    const i = recentActivity.findIndex((e) => e.id === id);
    if (i >= 0) recentActivity[i] = updated;
    persistRecentActivity();
    broadcastPanel({ t: 'recent-activity-update', entry: updated });
    broadcastPanel({ t: 'status', message: `Switched "${entry.label}" to new value.` });
  } catch (e) {
    broadcastPanel({
      t: 'error',
      message: `Couldn't switch value for "${entry.label}": ${(e as Error).message}`,
      retryable: false
    });
  }
}

chrome.runtime.onConnect.addListener((raw) => {
  if (raw.name !== CONTENT_PORT_NAME && raw.name !== PANEL_PORT_NAME) return;
  const port = discriminatePort(raw);
  if (!port) {
    raw.disconnect();
    return;
  }
  if (port.__role === 'content') {
    const set = contentPortsByTab.get(port.tabId) ?? new Set();
    set.add(port);
    contentPortsByTab.set(port.tabId, set);
    port.onDisconnect(() => dropContentPort(port));
    port.on((ev) => {
      void session.onContentEvent(ev, port.tabId, port.frameId);
    });
    port.post({ t: 'ack' });
  } else {
    panelPorts.add(port);
    port.onDisconnect(() => panelPorts.delete(port));
    port.on((ev) => {
      // Intercept revert-fill / delete-save here — the SW owns the activity
      // ring buffer, so it's the right place to look up the entry and dispatch
      // the actual undo work to the FillSession.
      if (ev.t === 'revert-fill') {
        const entry = recentActivity.find((e) => e.id === ev.id && e.kind === 'fill') as
          | FillActivity
          | undefined;
        if (entry) void session.revertFillEntry(entry);
        return;
      }
      if (ev.t === 'delete-save') {
        const entry = recentActivity.find((e) => e.id === ev.id && e.kind === 'save') as
          | SaveActivity
          | undefined;
        if (entry) void session.deleteSaveEntry(entry);
        return;
      }
      if (ev.t === 'switch-fill-value') {
        void switchFillValue(ev.id, ev.newValue);
        return;
      }
      void session.onPanelEvent(ev);
    });
    port.post({ t: 'ack' });
    // Always send a fresh snapshot of recent activity to a newly-connecting
    // panel — survives panel close/reopen during a SW lifetime.
    port.post({ t: 'recent-activity-snapshot', entries: recentActivity });
    // Flush any cold-start buffered events to the first-connecting panel.
    if (panelBuffer.length > 0) {
      const drain = panelBuffer;
      panelBuffer = [];
      for (const ev of drain) port.post(ev);
    }
    // If no fill session is active, tell the panel to reset to idle so that
    // a stale phase (e.g. story_setup left over from before the SW was
    // evicted) is cleared on reconnect.
    if (!session.isActive()) {
      port.post({ t: 'close' });
    }
  }
});

// Stale-port cleanup on tab navigation. When a tab navigates, the previous
// page's content script either dies (typical) or goes into bfcache (no
// onDisconnect fires, but messaging silently fails). We proactively drop
// every content port for that tab so the next session.start() either finds
// a fresh port (the new page's content script auto-registers at
// document_idle) or triggers programmatic injection.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    const set = contentPortsByTab.get(tabId);
    if (set) {
      for (const p of set) p.disconnect();
      contentPortsByTab.delete(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentPortsByTab.delete(tabId);
});

// Make the action open the side panel (one-line MV3 idiom).
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => logger.warn('sw', 'setPanelBehavior failed', { error: String(e) }));
}

// Open onboarding on first install.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/index.html') });
  }
});

// Resume the unlocked DEK from session storage on every SW startup.
void (async () => {
  try {
    const resumed = await Store.tryResumeFromSession();
    if (resumed) {
      const settings = await safeLoadSettings();
      setLoggerSettings(settings.logging);
      logger.info('sw', 'resumed unlocked vault from session');
      // Warm the embedder asynchronously — first real fill shouldn't pay it.
      warmup().catch(() => {});
      // Restore recent activity ring buffer (survives SW eviction within a
      // browser session; cleared on browser restart).
      try {
        const { [SESSION_KEYS.recentActivity]: saved } = await chrome.storage.session.get(
          SESSION_KEYS.recentActivity
        );
        if (Array.isArray(saved) && saved.length > 0) {
          recentActivity.push(...(saved as RecentActivity[]).slice(-RECENT_ACTIVITY_MAX));
          logger.debug('sw', 'restored recent activity', { count: recentActivity.length });
        }
      } catch (e) {
        logger.warn('sw', 'failed to restore recent activity', { error: String(e) });
      }
    } else {
      // Use defaults until unlocked, so logger settings exist.
      setLoggerSettings(DEFAULT_SETTINGS.logging);
    }
  } catch (e) {
    setLoggerSettings(DEFAULT_SETTINGS.logging);
    log('error', 'sw', 'startup failed', { error: String(e) });
  }
})();

async function safeLoadSettings(): Promise<Settings> {
  try {
    const s = await Store.get('settings');
    if (s) return s;
  } catch {
    /* */
  }
  return DEFAULT_SETTINGS;
}

// ───────────────────────── RPC handlers ─────────────────────────

rpcHandle('ping', async () => ({ pong: true as const, now: Date.now() }));

rpcHandle('is-initialized', async () => ({ initialized: await Store.isInitialized() }));

rpcHandle('is-unlocked', async () => ({ unlocked: Store.isUnlocked() }));

rpcHandle('setup-master', async (req) => {
  const { recoveryPhrase } = await Store.setupMaster(req.password);
  const settings = await safeLoadSettings();
  setLoggerSettings(settings.logging);
  logger.info('sw', 'setup-master complete');
  warmup().catch(() => {});
  return { recoveryPhrase };
});

rpcHandle('remove-recovery-phrase', async () => {
  await Store.removeRecoveryPhrase();
  return { ok: true as const };
});

rpcHandle('unlock-with-password', async (req) => {
  const ok = await Store.unlockWithPassword(req.password);
  if (ok) {
    const settings = await safeLoadSettings();
    setLoggerSettings(settings.logging);
    logger.info('sw', 'unlocked with password');
    warmup().catch(() => {});
  }
  return { unlocked: ok };
});

rpcHandle('unlock-with-phrase', async (req) => {
  const ok = await Store.unlockWithPhrase(req.phrase);
  if (ok) {
    const settings = await safeLoadSettings();
    setLoggerSettings(settings.logging);
    logger.info('sw', 'unlocked with recovery phrase');
    warmup().catch(() => {});
  }
  return { unlocked: ok };
});

rpcHandle('change-password', async (req) => {
  const result =
    req.via === 'password'
      ? await Store.changePassword({ kind: 'password', current: req.current }, req.newPassword)
      : await Store.changePassword({ kind: 'phrase', phrase: req.phrase }, req.newPassword);
  if (result.ok) {
    logger.info('sw', 'master password changed', { via: req.via });
  } else {
    logger.warn('sw', 'change-password rejected', { via: req.via, reason: result.reason });
  }
  return result;
});

rpcHandle('lock', async () => {
  await Store.lock();
  return { ok: true as const };
});

rpcHandle('reset-extension', async () => {
  await Store.wipeAll();
  return { ok: true as const };
});

rpcHandle('get-settings', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  const s = await Store.get('settings');
  return s ?? DEFAULT_SETTINGS;
});

rpcHandle('set-settings', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  await Store.set('settings', req);
  setLoggerSettings(req.logging);
  return { ok: true as const };
});

rpcHandle('get-active-application', async () => {
  const { 'session.activeApplication': v } = await chrome.storage.session.get(
    'session.activeApplication'
  );
  return (v as null | undefined) === undefined ? null : (v as null);
});

rpcHandle('clear-active-application', async () => {
  await chrome.storage.session.remove('session.activeApplication');
  return { ok: true as const };
});

rpcHandle('log-event', async (req) => {
  // Re-route logs from non-SW contexts into the same buffer.
  log(req.level, req.tag, req.message, req.payload);
  return { ok: true as const };
});

rpcHandle('embed-warmup', async () => {
  const r = await warmup();
  return { ok: r.ok, elapsedMs: r.elapsedMs };
});

rpcHandle('run-diagnostic', async () => {
  const settings = await safeLoadSettings();
  const activeBackend = settings.activeBackend;
  const backendCfg = settings.backends[activeBackend] as { apiKey?: string; baseUrl?: string; model: string };
  const hasApiKey =
    activeBackend === 'ollama'
      ? typeof backendCfg.baseUrl === 'string' && backendCfg.baseUrl.length > 0
      : typeof backendCfg.apiKey === 'string' && backendCfg.apiKey.length > 0;

  let activeTabId: number | null = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t?.id != null) activeTabId = t.id;
  } catch {
    /* */
  }

  const contentByTab: Record<number, number> = {};
  for (const [tabId, set] of contentPortsByTab) contentByTab[tabId] = set.size;

  let embeddingResult: DiagnosticResult['embedding'];
  if (Store.isUnlocked()) {
    const w = await warmup();
    embeddingResult = w.ok
      ? { ok: true, dims: w.dims, elapsedMs: w.elapsedMs }
      : { ok: false, error: 'warmup failed' };
  } else {
    embeddingResult = { ok: false, error: 'vault locked' };
  }

  // Pluck the most recent SW logs so the user can see whether
  // chrome.commands fired (`command fired: trigger-fill`) without building
  // the full Logger options page yet.
  const allLogs = await readLogs();
  const recentLogs = allLogs.slice(-25).map((e) => ({
    ts: e.ts,
    level: e.level,
    tag: e.tag,
    message: e.message
  }));

  const result: DiagnosticResult & { recentLogs: typeof recentLogs } = {
    swAlive: true,
    isInitialized: await Store.isInitialized(),
    vaultUnlocked: Store.isUnlocked(),
    embedding: embeddingResult,
    ports: {
      panel: panelPorts.size,
      contentByTab,
      activeTabContent: activeTabId != null ? (contentByTab[activeTabId] ?? 0) : null
    },
    llm: {
      activeBackend,
      hasApiKey,
      model: backendCfg.model
    },
    recentLogs
  };
  return result;
});

rpcHandle('submit-fill-plan', async () => {
  // Reserved for tests / future port-less integration paths.
  return { ok: true as const };
});

rpcHandle('get-profile', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  return (await Store.get('profile')) ?? { aliasMap: {}, canonicalData: {}, sensitiveKeys: [] };
});

rpcHandle('set-profile', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  // Trust input shape minimally — Phase 3 Profile UI will validate at the edge.
  await Store.set('profile', req as Profile);
  invalidateMatcherCache();
  return { ok: true as const };
});

// ───────────────────────── Phase 3 RPCs ─────────────────────────

rpcHandle('get-stories', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  return (await Store.get('stories')) ?? [];
});

rpcHandle('set-stories', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  await Store.set('stories', req);
  return { ok: true as const };
});

rpcHandle('get-history', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  return (await Store.get('history')) ?? [];
});

rpcHandle('set-history', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  await Store.set('history', req);
  return { ok: true as const };
});

rpcHandle('delete-history-entry', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  const cur = (await Store.get('history')) ?? [];
  const next = cur.filter((e) => e.id !== req.id);
  await Store.set('history', next);
  return { ok: true as const };
});

rpcHandle('get-logs', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  return await readLogs();
});

rpcHandle('clear-logs', async () => {
  if (!Store.isUnlocked()) throw new Error('locked');
  await clearLogs();
  return { ok: true as const };
});

rpcHandle('parse-resume', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  const settings = await safeLoadSettings();
  const r = await parseResume(settings, req.resumeText);
  if (!r.ok) {
    // Throw → rpcCall wrapper surfaces as Result error to the onboarding page.
    throw new Error(r.message);
  }
  return r.parsed;
});

rpcHandle('backup-export', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  const profile =
    (await Store.get('profile')) ?? { aliasMap: {}, canonicalData: {}, sensitiveKeys: [] };
  const stories = (await Store.get('stories')) ?? [];
  const history = (await Store.get('history')) ?? [];
  const settings = (await Store.get('settings')) ?? DEFAULT_SETTINGS;
  return await packBackup({
    exportPassword: req.exportPassword,
    profile,
    stories,
    history,
    settings
  });
});

rpcHandle('backup-import', async (req) => {
  if (!Store.isUnlocked()) throw new Error('locked');
  const r = await unpackBackup(req.envelope, req.exportPassword);
  if (!r.ok) return { ok: false as const, kind: r.kind, message: r.message };
  try {
    if (req.mode === 'replace-all') {
      await Store.set('profile', r.bundle.profile);
      await Store.set('stories', r.bundle.stories);
      await Store.set('history', r.bundle.history);
      await Store.set('settings', r.bundle.settings);
      setLoggerSettings(r.bundle.settings.logging);
      invalidateMatcherCache();
      return { ok: true as const, storiesAdded: r.bundle.stories.length };
    }
    // merge-stories — leaves profile/settings/history alone.
    const existing = (await Store.get('stories')) ?? [];
    const merged = mergeStories(existing, r.bundle.stories);
    await Store.set('stories', merged);
    return { ok: true as const, storiesAdded: merged.length - existing.length };
  } catch (e) {
    return {
      ok: false as const,
      kind: 'storage-failed' as const,
      message: (e as Error).message ?? String(e)
    };
  }
});

rpcHandle('ollama-reachability-check', async (req) => {
  return await ollamaPresenceCheck(req.baseUrl);
});

rpcHandle('__test-start-fill', async (req) => {
  // Test-only entry. Same code path as the real chrome.commands listener.
  session.start(req.kind, req.tabId, req.frameId);
  return { ok: true as const };
});

// ───────────────────────── FillSession wiring ─────────────────────────

async function commitOnPage(
  tabId: number,
  frameId: number,
  elementRef: string,
  fieldType: FieldType,
  value: string
): Promise<{ ok: boolean; kind?: string; message?: string }> {
  try {
    const resp = (await chrome.tabs.sendMessage(
      tabId,
      { __autofill_commit__: true, elementRef, fieldType, value },
      { frameId }
    )) as { ok: boolean; kind?: string; message?: string } | undefined;
    if (!resp) return { ok: false, kind: 'no-response', message: 'no response from content script' };
    return resp;
  } catch (e) {
    return { ok: false, kind: 'transport', message: (e as Error).message ?? String(e) };
  }
}

const session = new FillSessionImpl({
  getAllContentPorts: (tabId) => {
    const set = contentPortsByTab.get(tabId);
    if (!set || set.size === 0) return [];
    const out: ContentPort[] = [];
    for (const p of set) {
      if (!p.isAlive()) {
        dropContentPort(p);
        continue;
      }
      out.push(p);
    }
    return out;
  },
  getContentPort: (tabId, frameId) => {
    const set = contentPortsByTab.get(tabId);
    if (!set) return null;
    for (const p of set) {
      if (!p.isAlive()) {
        dropContentPort(p);
        continue;
      }
      if (p.frameId === frameId) return p;
    }
    return null;
  },
  broadcastPanel,
  pushActivity,
  removeActivity,
  loadSettings: async () => (await Store.get('settings')) ?? DEFAULT_SETTINGS,
  loadProfile: async () =>
    (await Store.get('profile')) ?? ({ aliasMap: {}, canonicalData: {}, sensitiveKeys: [] } as Profile),
  saveProfile: async (p) => {
    await Store.set('profile', p);
    invalidateMatcherCache();
  },
  loadStories: async () => (await Store.get('stories')) ?? ([] as Story[]),
  saveStories: async (s) => Store.set('stories', s),
  loadHistory: async () => (await Store.get('history')) ?? ([] as AnswerHistoryEntry[]),
  saveHistory: async (h) => Store.set('history', h),
  loadActiveApplication: async () => {
    const { [SESSION_KEYS.activeApplication]: v } = await chrome.storage.session.get(
      SESSION_KEYS.activeApplication
    );
    return (v as ActiveApplication | undefined) ?? null;
  },
  saveActiveApplication: async (a) => {
    if (a == null) await chrome.storage.session.remove(SESSION_KEYS.activeApplication);
    else await chrome.storage.session.set({ [SESSION_KEYS.activeApplication]: a });
  },
  commitOnPage
});

// ───────────────────────── Override get-active-application ─────────────────────────
// (replaces the stub registered earlier; chrome.runtime.onMessage routing
// uses the latest registration.)
rpcHandle('get-active-application', async () => {
  const { [SESSION_KEYS.activeApplication]: v } = await chrome.storage.session.get(
    SESSION_KEYS.activeApplication
  );
  return (v as ActiveApplication | null | undefined) ?? null;
});

rpcHandle('clear-active-application', async () => {
  await chrome.storage.session.remove(SESSION_KEYS.activeApplication);
  return { ok: true as const };
});

// ───────────────────────── Commands ─────────────────────────

/**
 * Programmatic content-script injection — the fallback for tabs that were
 * already open before the extension loaded, or whose previous content script
 * disappeared (bfcache, etc.). Reads file paths from the runtime manifest
 * so crxjs's hashed filenames don't trip us up (per §13).
 *
 * Returns the count of injected frames. Throws on injection failure (the
 * caller surfaces a user-friendly error to the side panel).
 */
async function injectContentScript(tabId: number): Promise<number> {
  const manifest = chrome.runtime.getManifest();
  const cs = manifest.content_scripts?.[0];
  const files = cs?.js;
  if (!files || files.length === 0) {
    throw new Error('manifest has no content_scripts[0].js');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: cs?.all_frames ?? true },
    files
  });
  return results.length;
}

/**
 * Make sure a content port exists for `tabId`. If not, programmatically
 * inject the content script and wait briefly for it to register a port.
 *
 * Returns `true` on success, `false` on injection failure (e.g. chrome://
 * URL, file:// without permission, or the page rejected the script).
 */
async function ensureContentScript(tabId: number, frameId: number): Promise<boolean> {
  // Drop any obviously-dead ports first.
  const set = contentPortsByTab.get(tabId);
  if (set) {
    for (const p of set) if (!p.isAlive()) dropContentPort(p);
  }
  const refreshed = contentPortsByTab.get(tabId);
  if (refreshed && refreshed.size > 0) {
    for (const p of refreshed) {
      if (p.frameId === frameId || refreshed.size === 1) return true;
    }
  }
  try {
    await injectContentScript(tabId);
  } catch (e) {
    logger.warn('sw', 'injectContentScript failed', { tabId, error: String(e) });
    return false;
  }
  // Wait up to ~1s for the freshly-injected script to connect its port.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const live = contentPortsByTab.get(tabId);
    if (live && live.size > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

chrome.commands.onCommand.addListener((command, tab) => {
  // CRITICAL: keep this handler synchronous up to chrome.sidePanel.open() so
  // the user-gesture context is preserved. Async work happens after the
  // panel-open call (and after session.start, which is itself synchronous).

  logger.info('sw', `command fired: ${command}`, { tabId: tab?.id ?? null, url: tab?.url ?? null });

  // Open the side panel right away — it must be in the user gesture window.
  if (tab?.id != null && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
      logger.warn('sw', `${command}: sidePanel.open failed`, { error: String(e) });
    });
  }

  if (!Store.isUnlocked()) {
    logger.info('sw', `${command}: vault locked`);
    return;
  }

  if (!tab?.id) {
    void runCommandFallback(command);
    return;
  }

  const isManualHighlight = command === 'trigger-fill-manual';
  const kind: 'fill' | 'add-to-profile' = command === 'add-to-profile' ? 'add-to-profile' : 'fill';

  // Synchronous fast path: a content port already exists for this tab.
  // session.start() is synchronous — it posts run-detective immediately, so
  // the content script's `document.activeElement` capture happens before any
  // focus shift caused by sidePanel.open() landing.
  const directPort = (() => {
    const set = contentPortsByTab.get(tab.id);
    if (!set || set.size === 0) return null;
    for (const p of set) if (p.frameId === 0 && p.isAlive()) return p;
    for (const p of set) if (p.isAlive()) return p;
    return null;
  })();

  if (directPort) {
    logger.info('sw', `${command}: direct port found`, {
      tabId: tab.id,
      frameId: directPort.frameId
    });
    if (isManualHighlight) {
      session.startWithManualHighlight(tab.id);
    } else {
      session.start(kind, tab.id, directPort.frameId);
    }
    return;
  }
  logger.info('sw', `${command}: no direct port, falling back to injection`, { tabId: tab.id });

  // Slow path: no live content port. Inject programmatically, then start.
  void (async () => {
    broadcastPanel({ t: 'phase', phase: 'detecting' });
    broadcastPanel({ t: 'status', message: 'Connecting to the page…' });
    const ok = await ensureContentScript(tab.id!, 0);
    if (!ok) {
      broadcastPanel({
        t: 'error',
        message:
          "AutoFill couldn't talk to this page. If the URL is a chrome:// or chrome-extension:// page, AutoFill cannot run there. Otherwise, try reloading the page and pressing Alt+A again.",
        retryable: false
      });
      broadcastPanel({ t: 'phase', phase: 'cancelled' });
      return;
    }
    if (isManualHighlight) {
      session.startWithManualHighlight(tab.id!);
    } else {
      session.start(kind, tab.id!, 0);
    }
  })();
});

/** Resolve the active tab if `tab` was missing (older Chrome / edge cases). */
async function runCommandFallback(command: string): Promise<void> {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t?.id) {
    logger.warn('sw', `${command}: no active tab`);
    return;
  }
  const kind: 'fill' | 'add-to-profile' = command === 'add-to-profile' ? 'add-to-profile' : 'fill';
  const ok = await ensureContentScript(t.id, 0);
  if (!ok) {
    broadcastPanel({
      t: 'error',
      message: "AutoFill couldn't talk to this page. Reload it, then press Alt+A again.",
      retryable: false
    });
    return;
  }
  if (command === 'trigger-fill-manual') {
    session.startWithManualHighlight(t.id);
  } else {
    session.start(kind, t.id, 0);
  }
}
