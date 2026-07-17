/**
 * Static model data for the cursor-bridge extension: fallback model list,
 * context-window/max-tokens maps, vision capability set, and small helpers
 * for context-window parsing/formatting.
 *
 * Pure Node (no Pi imports) so it can be unit-tested via `node --test`.
 * Loaded by the extension through importLib()'s realpath dynamic-import.
 */

// ─── Fallback model list ──────────────────────────────────────────────

export const FALLBACK_MODELS = [
  "auto", "composer-2-fast", "composer-2", "composer-2.5", "composer-2.5-fast",
  "claude-opus-4-7-medium", "claude-opus-4-7-high", "claude-opus-4-7-xhigh",
  "claude-opus-4-7-thinking-high", "claude-opus-4-7-thinking-xhigh",
  "claude-4.6-opus-high", "claude-4.6-opus-high-thinking",
  "claude-4.6-sonnet-medium", "claude-4.6-sonnet-medium-thinking",
  "claude-4.5-sonnet", "claude-4.5-sonnet-thinking",
  "claude-4.5-opus-high", "claude-4.5-opus-high-thinking",
  "claude-4-sonnet", "claude-4-sonnet-thinking",
  "gpt-5.5-none", "gpt-5.5-low", "gpt-5.5-medium", "gpt-5.5-high", "gpt-5.5-extra-high",
  "gpt-5.4-medium", "gpt-5.4-high", "gpt-5.4-xhigh", "gpt-5.4-mini-medium", "gpt-5.4-nano-medium",
  "gpt-5.3-codex", "gpt-5.3-codex-high", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.1", "gpt-5.1-codex-max-medium", "gpt-5.1-codex-mini", "gpt-5-mini",
  "gemini-3.1-pro", "gemini-3-flash", "gemini-3.5-flash",
  "kimi-k2.5", "grok-4.3", "grok-build-0.1",
];

// ─── Context window & max tokens maps ────────────────────────────────────────

/**
 * Default context window for models not in MODEL_CONTEXT_WINDOWS.
 * Conservative: errs on early compaction rather than missed overflow.
 */
export const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * Default max tokens for models not in MAX_TOKENS_MAP.
 */
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * Cursor models known to accept image input, keyed by SDK base id (the clean
 * ids Cursor.models.list() returns, e.g. "claude-opus-4-8" — not the CLI's
 * "claude-4.6-opus"). The SDK catalog exposes no vision flag, so capability is
 * declared, not detected. Unknown ids stay text-only (safe failure). Seeded
 * conservatively; codex, nano, auto, composer and kimi families omitted until
 * confirmed. Hand-maintained like MODEL_CONTEXT_WINDOWS; re-applied by
 * /cursor-refresh-models.
 *
 * SYNC (L6): when Cursor adds or renames a vision model, add its SDK base id
 * here. A missing id is treated as text-only (images are silently dropped), so
 * keep this list current as the catalog evolves.
 */
export const VISION_CAPABLE_SDK_MODELS = new Set([
  // Claude — all 3+ tiers are multimodal (ids reconciled against Cursor.models.list()).
  "claude-fable-5", "claude-haiku-4-5",
  "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
  "claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4-6",
  // GPT-5 family (codex/nano omitted — image support unconfirmed).
  "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
  // Gemini (2.5+ multimodal).
  "gemini-2.5-flash", "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash",
  // Grok (grok-build omitted).
  "grok-4.3",
]);

/**
 * Per-model context window values.
 * Family-base keys cover all effort variants; standalone keys for raw IDs.
 *
 * SYNC (L6): hand-maintained — when Cursor ships a new model or changes a
 * window, add/adjust its key here. Unknown ids fall back to
 * FALLBACK_CONTEXT_WINDOW, so a missing entry degrades quietly rather than
 * erroring; keep it current as the catalog evolves.
 */
export const MODEL_CONTEXT_WINDOWS = {
  // ── Claude families ──
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-7-thinking": 1_000_000,
  "claude-4.6-opus": 1_000_000,
  "claude-4.6-sonnet": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-4.5-opus": 200_000,
  "claude-4.5-sonnet": 200_000,
  "claude-4-sonnet": 200_000,
  // ── GPT families ──
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 1_050_000,
  "gpt-5.4-nano": 1_050_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.1-codex-max": 400_000,
  // ── Standalone models ──
  "gemini-3.1-pro": 1_000_000,
  "gemini-3-flash": 1_000_000,
  "gemini-3.5-flash": 1_048_576,
  "grok-4.3": 1_000_000,
  "grok-build-0.1": 1_000_000,
  "kimi-k2.5": 256_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.1": 128_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5-mini": 400_000,
  "composer-2": 200_000,
  "composer-2.5": 200_000,
  "auto": 200_000,
};

/**
 * Per-model max tokens values.
 * Derives all keys from MODEL_CONTEXT_WINDOWS with the default value.
 */
export const MAX_TOKENS_MAP = Object.fromEntries(
  Object.keys(MODEL_CONTEXT_WINDOWS).map(k => [k, DEFAULT_MAX_TOKENS])
);

// ─── @ context-suffix helpers ────────────────────────────────────────────────

/**
 * Convert a numeric context window to a human-readable suffix.
 * @param {number} cw — context window value
 * @returns {string} e.g. "1m", "400k"
 */
export function contextWindowToSuffix(cw) {
  if (cw >= 1_000_000) return "1m";
  return `${Math.round(cw / 1000)}k`;
}

/**
 * Parse a context window size from a cursor-agent model display name.
 *
 * Display names include context annotations like "1M", "400K", or omit
 * them for the default 200K. Examples:
 *   "Opus 4.8 1M" → 1_000_000
 *   "GPT-5.5 1M High" → 1_050_000
 *   "Sonnet 4.6 1M" → 1_000_000
 *   "Codex 5.3 Low" → 400_000 (no annotation = ~200K default, but family has 400K)
 *
 * When the display name contains an explicit "N<unit>" token, parse it.
 * Otherwise return null so the caller can fall back to the static map.
 *
 * @param {string} displayName — the human-readable model name (second column from --list-models)
 * @returns {number|null} — context window or null if no annotation found
 */
export function parseContextFromDisplayName(displayName) {
  if (!displayName) return null;
  // Match patterns like "1M", "400K" (case-insensitive) as standalone tokens
  const m = displayName.match(/(\d+)([kKmM])\b/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "m") {
    return num * 1_000_000;
  }
  return num * 1_000;
}
