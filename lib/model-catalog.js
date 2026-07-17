/**
 * ModelCatalog: owns the model-family variant map that the chat-completions
 * handler uses to resolve family base ids (e.g. "gpt-5.5" + reasoning_effort)
 * to concrete cursor-agent variant ids (e.g. "gpt-5.5-high").
 *
 * Replaces the former globalThis.__variantMap hidden global.
 *
 * L5 invariant: adopt() and clear() REPLACE the variantMap object — they never
 * mutate it in place. A request handler that captured `catalog.variantMap`
 * keeps reading one consistent snapshot even if /cursor-refresh-models swaps
 * the catalog contents mid-flight.
 *
 * Pure Node (no Pi imports) so it can be unit-tested via `node --test`.
 * Loaded by the extension through importLib()'s realpath dynamic-import.
 */

import { buildModelFamilies, resolveModelVariant } from "./cursor-helpers.js";

export class ModelCatalog {
  constructor() {
    /** @type {Record<string, object>} family base id → variants entry */
    this.variantMap = {};
  }

  /**
   * Adopt a model list: rebuild the variant map from the given models and
   * replace (not mutate) the current map.
   * @param {Array<{ id: string }>} models
   */
  adopt(models) {
    const { variantMap } = buildModelFamilies(models);
    this.variantMap = variantMap;
  }

  /** Reset to an empty map (replace, not mutate — see L5 note above). */
  clear() {
    this.variantMap = {};
  }

  /**
   * Resolve a model id (family base or concrete variant) against the current
   * map. Returns the resolved concrete id or null when unknown.
   * @param {string} modelId
   * @param {string} [effort] — OpenAI reasoning_effort value
   */
  resolve(modelId, effort) {
    return resolveModelVariant(modelId, effort, this.variantMap);
  }
}
