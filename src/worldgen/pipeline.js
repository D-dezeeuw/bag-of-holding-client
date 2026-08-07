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

// Thrown when a critical layer fails. Carries everything the pipeline HAD
// produced, so the host can persist it and hand it straight back as
// `initialResults` instead of paying for the completed layers a second time.
export class PipelineError extends Error {
  constructor(message, results) {
    super(message);
    this.name = 'PipelineError';
    this.results = results;
  }
}

// runPipeline(layers, opts) -> { [name]: result|null }
//
// `initialResults` resumes a run: any layer whose name is an own key is taken as
// already decided (a value adopts it, `null` records a layer that failed and is
// not worth retrying) and never regenerated. `onCheckpoint(results)` fires after
// every group, which is the moment worth persisting — worldgen is the single
// most expensive thing the game does, and losing four completed layers to one
// timeout on the fifth was the whole reason a first run could cost more than a
// session's play.
export async function runPipeline(layers, {
  blueprint = null, ctx = {}, onProgress = () => {}, defaultRetries = 0,
  initialResults = null, onCheckpoint = null,
} = {}) {
  const results = {};
  const digests = {};
  const resumed = (name) => initialResults != null && Object.hasOwn(initialResults, name);

  const adopt = (layer, result) => {
    results[layer.name] = result;
    if (result != null) {
      digests[layer.name] = layer.digestOf ? ensureDigest(result, layer.digestOf(result)) : (result.digest ?? null);
    }
  };

  for (const group of groupLayers(layers)) {
    // Run all layers in this group concurrently; never reject (capture per-layer).
    const settled = await Promise.all(group.layers.map(async (layer) => {
      if (resumed(layer.name)) {
        onProgress('resume', { layer: layer.name });
        return { layer, result: initialResults[layer.name], error: null, fromCheckpoint: true };
      }
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

    for (const { layer, result, error, fromCheckpoint } of settled) {
      if (result == null) {
        // A checkpoint that recorded `null` is a decision, not a fresh failure:
        // re-throwing on it would make a resumed run unresumable.
        if (layer.critical && !fromCheckpoint) {
          throw new PipelineError(
            `Critical worldgen layer '${layer.name}' failed: ${error?.message ?? 'no result'}`,
            { ...results },
          );
        }
        results[layer.name] = null;
        if (!fromCheckpoint) onProgress('skip', { layer: layer.name, reason: error?.message ?? 'empty' });
        continue;
      }
      adopt(layer, result);
      if (!fromCheckpoint) onProgress('detail', { layer: layer.name, result });
    }

    onCheckpoint?.({ ...results });
  }

  return results;
}
