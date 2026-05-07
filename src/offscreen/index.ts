// Offscreen document — hosts @xenova/transformers for sentence embeddings.
//
// MV3 service workers can't run the WASM bootstrap (no `document`, missing
// Worker host APIs onnxruntime-web reaches for). The SW proxies embed
// requests here via chrome.runtime.sendMessage with a discriminated envelope.
//
// Hard-coded constraints (§6.1):
//   - numThreads = 1 (no SharedArrayBuffer in extension pages).
//   - proxy = false (extension CSP blocks blob: workers).
//   - WASM execution requires 'wasm-unsafe-eval' in manifest CSP (§13).

import { env, pipeline } from '@xenova/transformers';
import { EMBEDDING_MODEL_ID } from '../shared/constants';

// Force WASM, single-threaded, no proxy.
env.backends.onnx.wasm.numThreads = 1;
// `proxy` is on the runtime config of the wasm backend; not all builds expose
// it, but setting it defensively when present is harmless.
(env.backends.onnx.wasm as unknown as { proxy?: boolean }).proxy = false;

// Skip the local-path lookup entirely. Without this, Transformers.js first
// tries to fetch each model file from `/models/...` (which fails noisily in
// the extension manager because we don't bundle the model) and only then
// falls back to the HuggingFace CDN. The errors confused the user and add
// nothing — the model is meant to come from the CDN and live in IndexedDB.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Cache the pipeline so we only pay the model-download / init cost once.
type EmbedFn = (
  text: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array | number[] | Float32Array[] }>;

let pipePromise: Promise<EmbedFn> | null = null;

function getPipe(): Promise<EmbedFn> {
  if (!pipePromise) {
    pipePromise = pipeline('feature-extraction', EMBEDDING_MODEL_ID).then(
      (p) => p as unknown as EmbedFn
    );
  }
  return pipePromise;
}

// ───────────────────────── Message protocol ─────────────────────────

type EmbedRequest = {
  __quickfill_offscreen__: true;
  op: 'embed' | 'embed-batch' | 'warmup';
  text?: string;
  texts?: string[];
};

type EmbedResponse =
  | { ok: true; vectors: number[][]; dims: number; elapsedMs: number }
  | { ok: false; error: string };

function isEmbedRequest(v: unknown): v is EmbedRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __quickfill_offscreen__?: unknown }).__quickfill_offscreen__ === true
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isEmbedRequest(msg)) return false;
  (async () => {
    const t0 = performance.now();
    try {
      const pipe = await getPipe();
      if (msg.op === 'warmup') {
        const out = await pipe(' ', { pooling: 'mean', normalize: true });
        const dims = vectorize(out)[0].length;
        sendResponse({ ok: true, vectors: [], dims, elapsedMs: performance.now() - t0 });
        return;
      }
      const inputs = msg.op === 'embed' ? [msg.text ?? ''] : (msg.texts ?? []);
      if (inputs.length === 0) {
        sendResponse({ ok: true, vectors: [], dims: 0, elapsedMs: performance.now() - t0 });
        return;
      }
      const out = await pipe(inputs, { pooling: 'mean', normalize: true });
      const vectors = vectorize(out);
      const dims = vectors[0]?.length ?? 0;
      const resp: EmbedResponse = {
        ok: true,
        vectors,
        dims,
        elapsedMs: performance.now() - t0
      };
      sendResponse(resp);
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message ?? String(e) });
    }
  })();
  return true;
});

/**
 * @xenova/transformers returns either a Tensor with `.data` (Float32Array,
 * batchSize × dims flattened) and `.dims` ([batchSize, dims]). Normalize to
 * `number[][]`.
 */
function vectorize(out: unknown): number[][] {
  // Tensor-like
  const t = out as { data?: Float32Array | number[]; dims?: number[] };
  if (t && t.data && Array.isArray(t.dims) && t.dims.length === 2) {
    const [batch, dims] = t.dims;
    const flat = t.data;
    const result: number[][] = [];
    for (let b = 0; b < batch; b++) {
      const row: number[] = new Array(dims);
      for (let i = 0; i < dims; i++) row[i] = (flat as Float32Array | number[])[b * dims + i];
      result.push(row);
    }
    return result;
  }
  // Array of arrays
  if (Array.isArray(out)) return out as number[][];
  // 1-D fallback
  if (t?.data) return [Array.from(t.data as Float32Array)];
  throw new Error('unrecognized embedding output shape');
}
