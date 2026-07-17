/**
 * Disk model cache for the cursor-bridge extension.
 *
 * Caches the cursor-agent model list per auth identity in
 * ~/.pi/agent/cursor-bridge-model-cache.json with a TTL.
 *
 * The Pi-stored auth key is threaded in as a parameter (the extension owns
 * the mutable cachedAuthKey state) so this module stays pure and testable.
 *
 * Pure Node (no Pi imports) so it can be unit-tested via `node --test`.
 * Loaded by the extension through importLib()'s realpath dynamic-import.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { homeDir } from "./cursor-cli.js";

/**
 * Default TTL for the disk model cache (24 hours in ms).
 */
export const DEFAULT_CACHE_TTL_MS = 86_400_000;

/**
 * Cache file format version. Bump if the on-disk schema changes.
 */
export const CACHE_FORMAT_VERSION = 2;

/**
 * Whether the disk model cache is disabled.
 */
export const DISABLE_MODEL_CACHE = process.env.PI_CURSOR_DISABLE_MODEL_CACHE === "1";

/**
 * Resolve the cache TTL from env var or default (24h).
 */
export function getCacheTTL() {
  const env = process.env.PI_CURSOR_MODEL_CACHE_TTL_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Resolve the cache file path: ~/.pi/agent/cursor-bridge-model-cache.json
 */
export function getCacheFilePath() {
  return path.join(homeDir(), ".pi", "agent", "cursor-bridge-model-cache.json");
}

/**
 * Read Cursor auth state and return a SHA-256 hex hash.
 *
 * Sources (in priority order):
 *   1. CURSOR_API_KEY env var
 *   2. The Pi-stored key passed by the caller (from ~/.pi/agent/auth.json)
 *   3. ~/.cursor/cli-config.json (authInfo + serverConfigCache)
 *   4. Unauthenticated sentinel
 *
 * @param {string|null} [authKey] — Pi-stored Cursor API key (or null)
 * @returns {string} hex-encoded SHA-256 hash
 */
export function getAuthHash(authKey) {
  // L4 — auth-source layering (intentional precedence):
  //   1. CURSOR_API_KEY env — an explicit override always wins.
  //   2. Pi-stored key from /login (`pikey:`) — the Pi-native default (Phase 5).
  //   3. ~/.cursor/cli-config.json — the cursor-agent CLI's own login.
  //   4. "unauthenticated" sentinel.
  // This hash only keys the on-disk model cache, so env-first is safe: a user
  // who sets the env var is deliberately choosing that identity for caching.
  const apiKey = process.env.CURSOR_API_KEY;
  if (apiKey) {
    return crypto.createHash("sha256").update(`apikey:${apiKey}`).digest("hex");
  }

  // Pi-stored API key (from /login)
  if (authKey) {
    return crypto.createHash("sha256").update(`pikey:${authKey}`).digest("hex");
  }

  try {
    const cliConfigPath = path.join(homeDir(), ".cursor", "cli-config.json");
    const cliConfig = JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
    const authInfo = cliConfig.authInfo || {};
    const serverConfig = cliConfig.serverConfigCache || {};
    const input = JSON.stringify(authInfo) + "|" + JSON.stringify(serverConfig);
    return crypto.createHash("sha256").update(input).digest("hex");
  } catch {
    // No ~/.cursor/cli-config.json or parse error — use sentinel
    return crypto.createHash("sha256").update("unauthenticated").digest("hex");
  }
}

/**
 * Load model cache from disk.
 *
 * Reads the cache file, finds the entry for the current auth hash,
 * and returns it if valid. When allowStale is false (default), returns
 * null for expired entries (beyond TTL). When allowStale is true, returns
 * the cached entry regardless of age — useful for CLI-fallback when the
 * primary fetch fails.
 *
 * Returns null on any other failure (missing file, corrupt JSON,
 * no matching entry).
 *
 * @param {{ allowStale?: boolean }} [options]
 * @param {string|null} [authKey] — Pi-stored Cursor API key (or null)
 * @returns {{ models: Array, cachedAt: number } | null}
 */
export function loadModelCache(options = {}, authKey = null) {
  if (DISABLE_MODEL_CACHE) return null;

  let raw;
  try {
    raw = fs.readFileSync(getCacheFilePath(), "utf8");
  } catch {
    return null; // ENOENT or permission error — no cache
  }

  let cache;
  try {
    cache = JSON.parse(raw);
  } catch {
    // Corrupt cache file — delete it to prevent repeat errors
    try { fs.unlinkSync(getCacheFilePath()); } catch {}
    return null;
  }

  if (!cache || cache.formatVersion !== CACHE_FORMAT_VERSION) return null;

  const authHash = getAuthHash(authKey);
  const entry = cache.entries?.[authHash];
  if (!entry || !Array.isArray(entry.models)) return null;

  const ttl = getCacheTTL();
  const age = Date.now() - entry.cachedAt;
  if (!options.allowStale && age > ttl) return null;

  return { models: entry.models, cachedAt: entry.cachedAt };
}

/**
 * Save model cache to disk.
 *
 * Reads existing cache, updates the entry for the current auth hash,
 * purges stale entries, and writes back. Fire-and-forget — caller
 * should not await.
 *
 * @param {Array<{ id: string, name?: string, object?: string, owned_by?: string }>} models
 * @param {string} [cliVersion] — cursor-agent CLI version string (for debugging)
 * @param {string|null} [authKey] — Pi-stored Cursor API key (or null)
 * @returns {Promise<void>}
 */
export async function saveModelCache(models, cliVersion, authKey = null) {
  if (DISABLE_MODEL_CACHE || !Array.isArray(models) || models.length === 0) return;

  const filePath = getCacheFilePath();
  const authHash = getAuthHash(authKey);
  const ttl = getCacheTTL();

  // Read existing cache (ignore errors — we'll create from scratch)
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    cache = { formatVersion: CACHE_FORMAT_VERSION, entries: {} };
  }

  if (!cache.entries) cache.entries = {};
  if (!cache.formatVersion) cache.formatVersion = CACHE_FORMAT_VERSION;

  // Update entry for current auth
  cache.entries[authHash] = {
    cachedAt: Date.now(),
    cliVersion: cliVersion || "",
    models: models.map(m => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      object: m.object || "model",
      owned_by: m.owned_by || "cursor",
    })),
  };

  // Purge entries older than 2x TTL to prevent unbounded growth
  const cutoff = Date.now() - 2 * ttl;
  for (const hash of Object.keys(cache.entries)) {
    if (cache.entries[hash].cachedAt < cutoff) {
      delete cache.entries[hash];
    }
  }

  // Ensure directory exists
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}

  // Write atomically via temp file
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error("[cursor-bridge] Failed to write model cache:", err.message);
  }
}
