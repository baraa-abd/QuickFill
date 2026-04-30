// §11 — encrypted ring-buffer logger.
//
// Microtask-batched flush; never throws; redaction is exhaustive.
// Anything that fails (settings missing, vault locked, storage full) is
// silently dropped — logging is observation, not the program's main path.

import { LOG_REDACT_DEPTH_CAP, LOG_RING_BUFFER_SIZE } from '$shared/constants';
import type { LogEntry, LogLevel, Settings } from '$shared/types';
import { Store } from './storage/store';

let queue: LogEntry[] = [];
let flushScheduled = false;
let cachedSettings: Pick<Settings['logging'], 'enabled' | 'logPayloads'> | null = null;

// Set by the SW after settings are loaded. Avoid re-reading settings on every log.
export function setLoggerSettings(s: Settings['logging']): void {
  cachedSettings = { enabled: s.enabled, logPayloads: s.logPayloads };
}

export function log(
  level: LogLevel,
  tag: string,
  message: string,
  payload?: unknown
): void {
  try {
    if (!cachedSettings || !cachedSettings.enabled) return;
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      tag,
      message
    };
    if (cachedSettings.logPayloads && payload !== undefined) {
      entry.payload = redact(payload, 0);
    }
    queue.push(entry);
    scheduleFlush();
  } catch {
    /* swallow — logger must never throw */
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flush();
  });
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    if (!Store.isUnlocked()) return; // vault locked → drop silently
    const existing = (await Store.get('logs')) ?? [];
    const next = existing.concat(batch);
    const trimmed =
      next.length > LOG_RING_BUFFER_SIZE
        ? next.slice(next.length - LOG_RING_BUFFER_SIZE)
        : next;
    await Store.set('logs', trimmed);
  } catch {
    /* swallow */
  }
}

// ───────────────────────── Redaction ─────────────────────────

const REDACT_KEY_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^x-api-key$/i,
  /^api[_-]?key$/i,
  /^apikey$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^password$/i
];

const REDACT_KEY_SUBSTRINGS = ['secret', 'token'];

function keyShouldRedact(key: string): boolean {
  if (REDACT_KEY_PATTERNS.some((re) => re.test(key))) return true;
  const lower = key.toLowerCase();
  if (REDACT_KEY_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  return false;
}

const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth: number): unknown {
  if (depth > LOG_REDACT_DEPTH_CAP) return '[depth-capped]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keyShouldRedact(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

// ───────────────────────── Inspection helpers ─────────────────────────

export async function readLogs(): Promise<LogEntry[]> {
  try {
    return (await Store.get('logs')) ?? [];
  } catch {
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await Store.set('logs', []);
  } catch {
    /* */
  }
}

// Convenience.
export const logger = {
  debug: (tag: string, msg: string, payload?: unknown) => log('debug', tag, msg, payload),
  info: (tag: string, msg: string, payload?: unknown) => log('info', tag, msg, payload),
  warn: (tag: string, msg: string, payload?: unknown) => log('warn', tag, msg, payload),
  error: (tag: string, msg: string, payload?: unknown) => log('error', tag, msg, payload)
};
