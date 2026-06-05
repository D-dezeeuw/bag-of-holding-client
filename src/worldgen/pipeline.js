// src/worldgen/pipeline.js — the layered worldgen orchestrator.
//
// A host declares a list of layers; the runner threads each layer's digest down
// to its dependents, runs same-`group` layers in parallel, retries per layer,
// continues past non-critical failures (and aborts on a critical one), and emits
// structured progress. This is the single implementation that an in-game campaign
// and an offline "world bible" export both consume — instead of re-implementing
// the pipeline with divergent retry/digest logic.
//
// A layer:
//   {
//     name,                                   // unique id, e.g. 'world' | 'region'
//     dependsOn?: string[],                   // layer names whose digests it receives
//     group?: number,                         // same number → run in parallel
//     critical?: boolean,                     // failure aborts the whole pipeline
//     retries?: number,                       // extra attempts on throw/empty
//     generate(parentDigests, blueprint, ctx) -> result | null,
//     digestOf?(result) -> string,            // fallback digest if result.digest absent
//   }
//
// runPipeline(layers, { blueprint, ctx, onProgress, defaultRetries }) -> { [name]: result|null }

// Ensure a result carries a `.digest`; returns the digest string for threading.
export function ensureDigest(result, fallback) {
  if (result && typeof result === 'object' && !result.digest) result.digest = fallback;
  return (result && result.digest) || fallback || null;
}

// Try `fn` up to retries+1 times; returns its value or null after exhausting.
export async function withRetry(fn, retries = 0, label = '', onProgress = () => {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const v = await fn();
      if (v != null) return v;
    } catch (e) {
      lastErr = e;
      onProgress('retry', { label, attempt, message: e.message });
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function groupLayers(layers) {
  const groups = [];
  const byNum = new Map();
  for (const layer of layers) {
    if (layer.group != null) {
      if (!byNum.has(layer.group)) { const g = { layers: [] }; byNum.set(layer.group, g); groups.push(g); }
      byNum.get(layer.group).layers.push(layer);
    } else {
      groups.push({ layers: [layer] });
    }
  }
  return groups;
}

export async function runPipeline(layers, { blueprint = null, ctx = {}, onProgress = () => {}, defaultRetries = 0 } = {}) {
  const results = {};
  const digests = {};

  for (const group of groupLayers(layers)) {
    // Run all layers in this group concurrently; never reject (capture per-layer).
    const settled = await Promise.all(group.layers.map(async (layer) => {
      onProgress('step', { layer: layer.name });
      const parentDigests = Object.fromEntries((layer.dependsOn ?? []).map(n => [n, digests[n]]));
      try {
        const result = await withRetry(
          () => layer.generate(parentDigests, blueprint, { ...ctx, results, digests }),
          layer.retries ?? defaultRetries, layer.name, onProgress,
        );
        return { layer, result, error: null };
      } catch (error) {
        return { layer, result: null, error };
      }
    }));

    for (const { layer, result, error } of settled) {
      if (result == null) {
        if (layer.critical) {
          throw new Error(`Critical worldgen layer '${layer.name}' failed: ${error?.message ?? 'no result'}`);
        }
        results[layer.name] = null;
        onProgress('skip', { layer: layer.name, reason: error?.message ?? 'empty' });
        continue;
      }
      results[layer.name] = result;
      digests[layer.name] = layer.digestOf ? ensureDigest(result, layer.digestOf(result)) : (result.digest ?? null);
      onProgress('detail', { layer: layer.name, result });
    }
  }

  return results;
}
