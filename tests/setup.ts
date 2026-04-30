// Vitest setup — mock the chrome.* APIs for Store + logger tests.
//
// The mock implements the subset of chrome.storage that the encrypted Store
// touches (local + session, get/set/remove/clear). It's an in-memory map per
// area, reset on each test via beforeEach.

import { afterEach, beforeEach, vi } from 'vitest';

type Listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

class MockStorageArea {
  private map = new Map<string, unknown>();
  private listeners: Listener[] = [];
  constructor(private areaName: string) {}

  get = vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    if (keys == null) {
      for (const [k, v] of this.map) out[k] = v;
      return out;
    }
    const list =
      typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    for (const k of list) {
      if (this.map.has(k)) out[k] = this.map.get(k);
      else if (typeof keys === 'object' && !Array.isArray(keys) && keys && k in keys) out[k] = (keys as Record<string, unknown>)[k];
    }
    return out;
  });

  set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.map.get(k), newValue: v };
      this.map.set(k, v);
    }
    for (const l of this.listeners) l(changes, this.areaName);
  });

  remove = vi.fn(async (keys: string | string[]): Promise<void> => {
    const list = typeof keys === 'string' ? [keys] : keys;
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const k of list) {
      if (this.map.has(k)) {
        changes[k] = { oldValue: this.map.get(k) };
        this.map.delete(k);
      }
    }
    for (const l of this.listeners) l(changes, this.areaName);
  });

  clear = vi.fn(async (): Promise<void> => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of this.map) changes[k] = { oldValue: v };
    this.map.clear();
    for (const l of this.listeners) l(changes, this.areaName);
  });

  onChanged = {
    addListener: (l: Listener) => this.listeners.push(l),
    removeListener: (l: Listener) => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    }
  };

  reset() {
    this.map.clear();
    this.listeners = [];
    this.get.mockClear();
    this.set.mockClear();
    this.remove.mockClear();
    this.clear.mockClear();
  }
}

const local = new MockStorageArea('local');
const session = new MockStorageArea('session');

// Inbound message handlers registered via chrome.runtime.onMessage.addListener.
const onMessageListeners: Array<
  (msg: unknown, sender: unknown, sendResponse: (v: unknown) => void) => boolean | void
> = [];

const chromeMock = {
  storage: { local, session },
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(async (envelope: unknown) => {
      // Route into the registered handlers (RPC tests).
      let resolved: unknown = undefined;
      let kept = false;
      for (const l of onMessageListeners) {
        const send = (v: unknown) => {
          resolved = v;
        };
        const result = l(envelope, {}, send);
        if (result === true) kept = true;
      }
      if (kept) {
        // Wait one microtask for the async handler to call sendResponse.
        await Promise.resolve();
        await Promise.resolve();
      }
      return resolved;
    }),
    onMessage: {
      addListener: (l: (msg: unknown, sender: unknown, sendResponse: (v: unknown) => void) => boolean | void) => {
        onMessageListeners.push(l);
      },
      removeListener: (l: unknown) => {
        const i = onMessageListeners.indexOf(l as never);
        if (i >= 0) onMessageListeners.splice(i, 1);
      }
    },
    onConnect: { addListener: vi.fn(), removeListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    connect: vi.fn(),
    getURL: (path: string) => `chrome-extension://test/${path}`,
    openOptionsPage: vi.fn()
  },
  offscreen: undefined as unknown,
  sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
  tabs: { query: vi.fn(async () => []), create: vi.fn(async () => ({})) }
};

(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

// Web Crypto polyfill: jsdom + Node 20+ exposes globalThis.crypto.subtle.
// Sanity-check; bail loudly if not present.
if (!globalThis.crypto?.subtle) {
  throw new Error('globalThis.crypto.subtle is required (Node 20+).');
}

beforeEach(() => {
  local.reset();
  session.reset();
  onMessageListeners.length = 0;
});

afterEach(() => {
  // no-op
});
