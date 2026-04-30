// SW-side proxy to the offscreen embedding host.
//
// Lifecycle: offscreen documents are ephemeral in MV3. Before sending an
// embed request we check chrome.offscreen.hasDocument() and create one if
// needed. The 'WORKERS' reason is the conventional declaration for ML
// inference offscreen use, even though our config disables proxy-mode
// blob workers.

import { logger } from '../logger';

const OFFSCREEN_PATH = 'src/offscreen/index.html';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Defensive: if the API isn't available (shouldn't happen on Chrome 116+),
  // throw a sensible error instead of crashing on `undefined.hasDocument`.
  if (!chrome.offscreen?.createDocument) {
    throw new Error('chrome.offscreen API unavailable');
  }
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Run ONNX WASM inference for text embedding via Transformers.js (single-threaded, no blob workers).'
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

type OffscreenResponse =
  | { ok: true; vectors: number[][]; dims: number; elapsedMs: number }
  | { ok: false; error: string };

async function send(payload: {
  op: 'embed' | 'embed-batch' | 'warmup';
  text?: string;
  texts?: string[];
}): Promise<OffscreenResponse> {
  await ensureOffscreen();
  try {
    const resp = (await chrome.runtime.sendMessage({
      __autofill_offscreen__: true,
      ...payload
    })) as OffscreenResponse | undefined;
    if (!resp) return { ok: false, error: 'no response from offscreen' };
    return resp;
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

export async function embed(text: string): Promise<number[]> {
  const r = await send({ op: 'embed', text });
  if (!r.ok) throw new Error(`embed failed: ${r.error}`);
  if (r.vectors.length === 0) throw new Error('embed returned no vectors');
  return r.vectors[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const r = await send({ op: 'embed-batch', texts });
  if (!r.ok) throw new Error(`embed-batch failed: ${r.error}`);
  return r.vectors;
}

export async function warmup(): Promise<{ ok: boolean; dims: number; elapsedMs: number }> {
  const t0 = performance.now();
  const r = await send({ op: 'warmup' });
  if (!r.ok) {
    logger.warn('embed', 'warmup failed', { error: r.error });
    return { ok: false, dims: 0, elapsedMs: performance.now() - t0 };
  }
  logger.info('embed', 'warmup complete', { dims: r.dims, elapsedMs: r.elapsedMs });
  return { ok: true, dims: r.dims, elapsedMs: r.elapsedMs };
}
